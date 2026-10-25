import express, { ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import { z, ZodError } from 'zod';
import { authenticate, requireRole, signToken, wrap } from './auth';
import { config } from './config';
import { AppError } from './errors';
import { Pool, tx } from './db';
import type { Jobs } from './jobs/types';
import { availableSlots } from './services/availability';
import * as booking from './services/booking';
import * as leaves from './services/leaves';
import { approvePost, listSummaries, postSchema } from './services/summaries';

export interface AppDeps { pool: Pool; jobs: Jobs; jwtSecret?: string; bcryptCost?: number }

const tz = z.string().refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'invalid time zone');
const uuid = z.string().uuid();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export function createApp({ pool, jobs, jwtSecret = config.jwtSecret, bcryptCost = config.bcryptCost }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  const auth = authenticate(jwtSecret);
  const dummyHash = bcrypt.hashSync('not-a-real-password', bcryptCost);   // equalises login timing for unknown emails

  // --- tiny in-memory login throttle (per email+ip). Use a shared store (Redis) if you run several API instances.
  const attempts = new Map<string, { n: number; reset: number }>();
  const throttle = (key: string) => {
    const now = Date.now(); const e = attempts.get(key);
    if (!e || e.reset < now) { attempts.set(key, { n: 1, reset: now + 15 * 60_000 }); return; }
    if (++e.n > 10) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts, try again later');
  };

  app.get('/health', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

  // ---------- auth
  const registerSchema = z.object({
    email: z.string().email().max(254), password: z.string().min(8).max(128), name: z.string().trim().min(1).max(100),
    timezone: tz.optional(), dob: z.string().date().optional(),
    allergies: z.string().max(500).optional(), chronicConditions: z.string().max(500).optional(),
  });
  app.post('/auth/register', wrap(async (req, res) => {
    const b = registerSchema.parse(req.body);
    const hash = await bcrypt.hash(b.password, bcryptCost);
    const id = await tx(pool, async (c) => {
      try {
        const u = (await c.query(`INSERT INTO users (email,password_hash,role,name,timezone) VALUES ($1,$2,'PATIENT',$3,COALESCE($4,'Asia/Kolkata')) RETURNING id`,
          [b.email, hash, b.name, b.timezone ?? null])).rows[0];
        await c.query('INSERT INTO patients (id, dob, allergies, chronic_conditions) VALUES ($1,$2,$3,$4)', [u.id, b.dob ?? null, b.allergies ?? null, b.chronicConditions ?? null]);
        return u.id as string;
      } catch (e: any) { if (e.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered'); throw e; }
    });
    res.status(201).json({ id, token: signToken({ id, role: 'PATIENT' }, jwtSecret) });
  }));

  app.post('/auth/login', wrap(async (req, res) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    throttle(`${req.ip}|${b.email.toLowerCase()}`);
    const u = (await pool.query('SELECT id, role, password_hash FROM users WHERE lower(email)=lower($1)', [b.email])).rows[0];
    const ok = await bcrypt.compare(b.password, u?.password_hash ?? dummyHash);
    if (!u || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    res.json({ token: signToken({ id: u.id, role: u.role }, jwtSecret), role: u.role });
  }));

  // ---------- admin
  app.post('/admin/doctors', auth, requireRole('ADMIN'), wrap(async (req, res) => {
    const b = z.object({
      email: z.string().email(), password: z.string().min(8), name: z.string().min(1), specialty: z.string().min(1),
      slotMinutes: z.number().int().min(5).max(240).default(30), timezone: tz.default('Asia/Kolkata'),
      workingHours: z.array(z.object({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).min(1),
    }).refine((v) => v.workingHours.every((w) => w.end > w.start), 'end must be after start').parse(req.body);
    const hash = await bcrypt.hash(b.password, bcryptCost);
    const id = await tx(pool, async (c) => {
      try {
        const u = (await c.query(`INSERT INTO users (email,password_hash,role,name,timezone) VALUES ($1,$2,'DOCTOR',$3,$4) RETURNING id`, [b.email, hash, b.name, b.timezone])).rows[0];
        await c.query('INSERT INTO doctors (id, specialty, slot_minutes, timezone) VALUES ($1,$2,$3,$4)', [u.id, b.specialty, b.slotMinutes, b.timezone]);
        for (const w of b.workingHours) await c.query('INSERT INTO doctor_working_hours (doctor_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [u.id, w.weekday, w.start, w.end]);
        return u.id as string;
      } catch (e: any) { if (e.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'Email already registered'); throw e; }
    });
    res.status(201).json({ id });
  }));
  app.get('/admin/notifications', auth, requireRole('ADMIN'), wrap(async (req, res) => {
    const status = z.enum(['PENDING','QUEUED','SENDING','SENT','FAILED','DEAD','CANCELLED']).default('DEAD').parse(req.query.status);
    res.json((await pool.query('SELECT id,user_id,type,status,attempts,last_error,send_at FROM notifications WHERE status=$1 ORDER BY updated_at DESC LIMIT 200', [status])).rows);
  }));
  app.post('/admin/notifications/:id/retry', auth, requireRole('ADMIN'), wrap(async (req, res) => {
    const r = await pool.query(`UPDATE notifications SET status='PENDING', attempts=0, send_at=now(), updated_at=now() WHERE id=$1 AND status IN ('DEAD','FAILED') RETURNING id`, [uuid.parse(req.params.id)]);
    if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'No retryable notification with that id');
    res.json({ requeued: true });
  }));

  // ---------- doctors, slots, leave
  app.get('/doctors', auth, wrap(async (_req, res) => {
    res.json((await pool.query(`SELECT d.id, u.name, d.specialty, d.timezone, d.slot_minutes FROM doctors d JOIN users u ON u.id=d.id ORDER BY u.name`)).rows);
  }));
  app.get('/doctors/:id/slots', auth, wrap(async (req, res) => {
    const date = z.string().date().parse(req.query.date);
    const slots = await availableSlots(pool, uuid.parse(req.params.id), date);
    res.json(slots.map((s) => ({ startAt: s.start_at, endAt: s.end_at })));
  }));
  app.post('/doctors/me/leaves', auth, requireRole('DOCTOR'), wrap(async (req, res) => {
    res.status(201).json(await leaves.createLeave(pool, jobs, req.user!.id, leaves.leaveSchema.parse(req.body)));
  }));
  app.get('/doctors/me/leaves', auth, requireRole('DOCTOR'), wrap(async (req, res) => { res.json(await leaves.listLeaves(pool, req.user!.id)); }));
  app.delete('/doctors/me/leaves/:id', auth, requireRole('DOCTOR'), wrap(async (req, res) => {
    await leaves.deleteLeave(pool, req.user!.id, uuid.parse(req.params.id)); res.status(204).end();
  }));

  // ---------- appointments
  app.post('/appointments', auth, requireRole('PATIENT'), wrap(async (req, res) => {
    res.status(201).json(await booking.book(pool, jobs, req.user!.id, booking.bookSchema.parse(req.body)));
  }));
  app.post('/appointments/hold', auth, requireRole('PATIENT'), wrap(async (req, res) => {
    res.status(201).json(await booking.hold(pool, req.user!.id, booking.holdSchema.parse(req.body)));
  }));
  app.post('/appointments/:id/confirm', auth, requireRole('PATIENT'), wrap(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
    res.json(await booking.confirmHold(pool, jobs, req.user!.id, uuid.parse(req.params.id), reason));
  }));
  app.get('/appointments', auth, wrap(async (req, res) => { res.json(await booking.listFor(pool, req.user!)); }));
  app.delete('/appointments/:id', auth, wrap(async (req, res) => {
    const reason = typeof req.query.reason === 'string' ? req.query.reason.slice(0, 300) : undefined;
    res.json(await booking.cancel(pool, jobs, req.user!, uuid.parse(req.params.id), reason));
  }));
  app.post('/appointments/:id/complete', auth, requireRole('DOCTOR'), wrap(async (req, res) => {
    await booking.complete(pool, jobs, req.user!.id, uuid.parse(req.params.id), booking.completeSchema.parse(req.body));
    res.json({ completed: true });
  }));
  app.get('/appointments/:id/summaries', auth, wrap(async (req, res) => {
    res.json(await listSummaries(pool, req.user!, uuid.parse(req.params.id)));
  }));
  app.post('/summaries/:id/approve', auth, requireRole('DOCTOR'), wrap(async (req, res) => {
    const edited = req.body?.content ? postSchema.parse(req.body.content) : undefined;
    res.json(await approvePost(pool, req.user!.id, uuid.parse(req.params.id), edited));
  }));

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof AppError) return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: err.issues } });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  };
  app.use(onError);
  return app;
}
