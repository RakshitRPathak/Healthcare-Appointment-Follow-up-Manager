import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminToken, auth, createDoctor, createPatient, makeApp, pool, resetDb, slot } from './helpers';

beforeEach(resetDb);

describe('auth + RBAC', () => {
  it('register -> login -> use API; passwords are hashed; duplicate email rejected', async () => {
    const { api } = makeApp();
    const reg = await api().post('/auth/register').send({ email: 'A@x.com', password: 'longenough1', name: 'Ann' });
    expect(reg.status).toBe(201);
    expect((await api().post('/auth/register').send({ email: 'a@X.com', password: 'longenough1', name: 'Ann' })).body.error.code).toBe('EMAIL_TAKEN');
    const login = await api().post('/auth/login').send({ email: 'a@x.com', password: 'longenough1' });
    expect(login.status).toBe(200); expect(login.body.role).toBe('PATIENT');
    expect((await pool.query('SELECT password_hash FROM users')).rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect((await api().get('/appointments').set(auth(login.body.token))).status).toBe(200);
  });

  it('bad credentials give the same error for unknown user and wrong password; login is throttled', async () => {
    const { api } = makeApp(); await createPatient();
    const a = await api().post('/auth/login').send({ email: 'nobody@x.com', password: 'whatever1' });
    const b = await api().post('/auth/login').send({ email: (await pool.query('SELECT email FROM users')).rows[0].email, password: 'wrong-password' });
    expect([a.status, b.status]).toEqual([401, 401]); expect(a.body.error.message).toBe(b.body.error.message);
    let last = 0; for (let i = 0; i < 12; i++) last = (await api().post('/auth/login').send({ email: 'brute@x.com', password: 'guess-guess' })).status;
    expect(last).toBe(429);
  });

  it('rejects missing, malformed, wrong-secret, expired and alg=none tokens', async () => {
    const { api } = makeApp(); const p = await createPatient();
    expect((await api().get('/appointments')).status).toBe(401);
    expect((await api().get('/appointments').set('Authorization', 'Bearer junk')).status).toBe(401);
    const wrong = jwt.sign({ role: 'ADMIN' }, 'other-secret', { subject: p.id });
    expect((await api().get('/appointments').set(auth(wrong))).status).toBe(401);
    const expired = jwt.sign({ role: 'PATIENT' }, 'dev-only-secret-change-me', { subject: p.id, expiresIn: -10 });
    expect((await api().get('/appointments').set(auth(expired))).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: p.id, role: 'ADMIN' })).toString('base64url')}.`;
    expect((await api().get('/admin/notifications').set(auth(none))).status).toBe(401);
  });

  it('role gates: patients cannot manage leave/admin/complete; doctors cannot book; only admins create doctors', async () => {
    const { api } = makeApp(); const [doc, p] = [await createDoctor(), await createPatient()];
    expect((await api().post('/doctors/me/leaves').set(auth(p.token)).send({ startsAt: slot(3, 9), endsAt: slot(3, 10) })).status).toBe(403);
    expect((await api().get('/admin/notifications').set(auth(p.token))).status).toBe(403);
    expect((await api().post('/appointments').set(auth(doc.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'doctor booking' })).status).toBe(403);
    const body = { email: 'new@d.com', password: 'Password#1', name: 'New', specialty: 'ENT', workingHours: [{ weekday: 1, start: '09:00', end: '13:00' }] };
    expect((await api().post('/admin/doctors').set(auth(doc.token)).send(body)).status).toBe(403);
    const ok = await api().post('/admin/doctors').set(auth(await adminToken())).send(body);
    expect(ok.status).toBe(201);
    expect((await api().get('/doctors').set(auth(p.token))).body.map((d: any) => d.name)).toContain('New');
  });

  it("users cannot see or touch other people's appointments or summaries", async () => {
    const { api } = makeApp(); const [doc, a, b, otherDoc] = [await createDoctor(), await createPatient(), await createPatient(), await createDoctor()];
    const r = await api().post('/appointments').set(auth(a.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'private matter' });
    expect((await api().delete(`/appointments/${r.body.id}`).set(auth(b.token))).status).toBe(404);
    expect((await api().delete(`/appointments/${r.body.id}`).set(auth(otherDoc.token))).status).toBe(404);
    expect((await api().get(`/appointments/${r.body.id}/summaries`).set(auth(b.token))).status).toBe(404);
    expect((await api().get('/appointments').set(auth(b.token))).body).toEqual([]);
    expect((await api().get('/appointments').set(auth(doc.token))).body).toHaveLength(1);
    expect((await api().post(`/appointments/${r.body.id}/confirm`).set(auth(b.token)).send({ reason: 'not mine at all' })).status).toBe(404);
  });

  it('validates input: bad uuids, bad dates, unknown fields do not reach the DB layer; errors are uniform JSON', async () => {
    const { api } = makeApp(); const p = await createPatient();
    const r1 = await api().post('/appointments').set(auth(p.token)).send({ doctorId: 'nope', startAt: 'tomorrow', reason: 'x' });
    expect(r1.status).toBe(400); expect(r1.body.error.code).toBe('VALIDATION_ERROR');
    expect((await api().delete('/appointments/not-a-uuid').set(auth(p.token))).status).toBe(400);
    expect((await api().get('/doctors/x/slots?date=2030-13-45').set(auth(p.token))).status).toBe(400);
    expect((await api().post('/auth/register').set('Content-Type', 'application/json').send('{bad json')).body.error.code).toBe('BAD_JSON');
    expect((await api().get('/nope')).body.error.code).toBe('NOT_FOUND');
    const sqli = await api().post('/auth/login').send({ email: "x'; DROP TABLE users;--@a.com", password: 'x' });
    expect(sqli.status).toBe(400);
    expect((await pool.query('SELECT count(*)::int c FROM users')).rows[0].c).toBe(1);
  });

  it('cancellation rules: only active bookings, and a cancelled slot becomes bookable again', async () => {
    const { api } = makeApp(); const [doc, a, b] = [await createDoctor(), await createPatient(), await createPatient()];
    const r = await api().post('/appointments').set(auth(a.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'will cancel this' });
    expect((await api().delete(`/appointments/${r.body.id}`).set(auth(a.token))).body.status).toBe('CANCELLED');
    expect((await api().delete(`/appointments/${r.body.id}`).set(auth(a.token))).body.error.code).toBe('NOT_CANCELLABLE');
    expect((await api().post('/appointments').set(auth(b.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'taking it now' })).status).toBe(201);
  });
});
