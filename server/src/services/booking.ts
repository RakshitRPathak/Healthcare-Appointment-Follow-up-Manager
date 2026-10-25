import { z } from 'zod';
import { config } from '../config';
import { AppError } from '../errors';
import { Client, Pool, tx } from '../db';
import type { AuthUser } from '../auth';
import type { Jobs } from '../jobs/types';
import { gridSlots } from './availability';
import { notify } from './notifications';

const ACTIVE = `('HELD','CONFIRMED')`;

interface Place { doctorId: string; patientId: string; startAt: Date; status: 'HELD' | 'CONFIRMED'; reason?: string }

/**
 * The one place appointments are created. Order matters:
 *  1. lock the doctor row  -> serialises booking vs. leave-creation vs. other bookings for that doctor
 *  2. validate the slot against the doctor's working-hours grid (their local time zone)
 *  3. reject if the doctor is on leave
 *  4. expire stale holds that overlap (an expired hold must not block anyone)
 *  5. INSERT; the EXCLUDE constraints are the final guard, even if steps 1-4 had a bug
 */
async function place(c: Client, p: Place) {
  const doc = (await c.query('SELECT id, slot_minutes, timezone FROM doctors WHERE id=$1 FOR UPDATE', [p.doctorId])).rows[0];
  if (!doc) throw new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
  if (p.startAt.getTime() <= Date.now()) throw new AppError(422, 'SLOT_IN_PAST', 'Slot is in the past');

  const localDate = (await c.query(`SELECT ($1::timestamptz AT TIME ZONE $2::text)::date::text AS d`, [p.startAt, doc.timezone])).rows[0].d;
  const slot = (await gridSlots(c, doc.id, localDate)).find((s) => s.start_at.getTime() === p.startAt.getTime());
  if (!slot) throw new AppError(422, 'INVALID_SLOT', 'Not a valid slot for this doctor');

  const onLeave = await c.query(
    `SELECT 1 FROM doctor_leaves WHERE doctor_id=$1 AND tstzrange(starts_at, ends_at,'[)') && tstzrange($2,$3,'[)') LIMIT 1`,
    [doc.id, slot.start_at, slot.end_at]);
  if (onLeave.rowCount) throw new AppError(409, 'DOCTOR_ON_LEAVE', 'Doctor is on leave at that time');

  await c.query(
    `UPDATE appointments SET status='EXPIRED', updated_at=now()
     WHERE status='HELD' AND hold_expires_at <= now() AND (doctor_id=$1 OR patient_id=$2)
       AND during && tstzrange($3,$4,'[)')`, [doc.id, p.patientId, slot.start_at, slot.end_at]);

  try {
    const r = await c.query(
      `INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status, hold_expires_at, reason)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $5='HELD' THEN now() + make_interval(mins => $6) END, $7) RETURNING *`,
      [doc.id, p.patientId, slot.start_at, slot.end_at, p.status, config.holdMinutes, p.reason ?? null]);
    return r.rows[0];
  } catch (e: any) {
    if (e.code === '23P01') {
      if (e.constraint === 'appt_no_patient_overlap')
        throw new AppError(409, 'PATIENT_TIME_CONFLICT', 'You already have an appointment at that time');
      throw new AppError(409, 'SLOT_ALREADY_BOOKED', 'That slot has just been taken');
    }
    throw e;
  }
}

/** Confirmation email + doctor email + 24h reminder, written in the SAME transaction as the booking. */
async function onConfirmed(c: Client, a: any) {
  await notify(c, { userId: a.patient_id, type: 'APPT_CONFIRMED', appointmentId: a.id, dedupeKey: `appt-confirmed:${a.id}` });
  await notify(c, { userId: a.doctor_id, type: 'APPT_NEW_DOCTOR', appointmentId: a.id, dedupeKey: `appt-new:${a.id}` });
  const remindAt = new Date(a.start_at.getTime() - config.reminderHoursBefore * 3600_000);
  if (remindAt.getTime() > Date.now())
    await notify(c, { userId: a.patient_id, type: 'APPT_REMINDER', appointmentId: a.id, dedupeKey: `appt-reminder:${a.id}`, sendAt: remindAt });
}

async function afterConfirmed(jobs: Jobs, id: string) {
  // Best effort; reconcile() will pick up anything that fails here.
  await Promise.allSettled([jobs.summary(id, 'PRE'), jobs.calendar(id)]);
}

export const bookSchema = z.object({
  doctorId: z.string().uuid(), startAt: z.string().datetime({ offset: true }), reason: z.string().trim().min(3).max(1000),
});

export async function book(pool: Pool, jobs: Jobs, patientId: string, input: z.infer<typeof bookSchema>) {
  const a = await tx(pool, async (c) => {
    const row = await place(c, { doctorId: input.doctorId, patientId, startAt: new Date(input.startAt), status: 'CONFIRMED', reason: input.reason });
    await onConfirmed(c, row);
    await c.query(`INSERT INTO visit_summaries (appointment_id, kind) VALUES ($1,'PRE') ON CONFLICT DO NOTHING`, [row.id]);
    return row;
  });
  await afterConfirmed(jobs, a.id);
  return a;
}

export const holdSchema = z.object({ doctorId: z.string().uuid(), startAt: z.string().datetime({ offset: true }) });

export async function hold(pool: Pool, patientId: string, input: z.infer<typeof holdSchema>) {
  return tx(pool, (c) => place(c, { doctorId: input.doctorId, patientId, startAt: new Date(input.startAt), status: 'HELD' }));
}

export async function confirmHold(pool: Pool, jobs: Jobs, patientId: string, id: string, reason: string) {
  const a = await tx(pool, async (c) => {
    const row = (await c.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row || row.patient_id !== patientId) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
    if (row.status === 'CONFIRMED') return row;                                   // idempotent
    if (row.status !== 'HELD' || row.hold_expires_at <= new Date()) {
      if (row.status === 'HELD') await c.query(`UPDATE appointments SET status='EXPIRED', updated_at=now() WHERE id=$1`, [id]);
      throw new AppError(410, 'HOLD_EXPIRED', 'The hold has expired; pick a slot again');
    }
    const upd = (await c.query(
      `UPDATE appointments SET status='CONFIRMED', hold_expires_at=NULL, reason=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, reason])).rows[0];
    await onConfirmed(c, upd);
    await c.query(`INSERT INTO visit_summaries (appointment_id, kind) VALUES ($1,'PRE') ON CONFLICT DO NOTHING`, [id]);
    return upd;
  });
  await afterConfirmed(jobs, a.id);
  return a;
}

export async function cancel(pool: Pool, jobs: Jobs, actor: AuthUser, id: string, reason?: string) {
  const a = await tx(pool, async (c) => {
    const row = (await c.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const allowed = row && (actor.role === 'ADMIN' || row.patient_id === actor.id || row.doctor_id === actor.id);
    if (!allowed) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
    if (!['HELD', 'CONFIRMED'].includes(row.status)) throw new AppError(409, 'NOT_CANCELLABLE', `Appointment is ${row.status}`);
    const upd = (await c.query(
      `UPDATE appointments SET status='CANCELLED', cancel_reason=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, reason ?? null])).rows[0];
    await cancelSideEffects(c, upd, row.status === 'CONFIRMED');
    return upd;
  });
  await jobs.calendar(a.id).catch(() => {});
  return a;
}

/** Shared by patient/doctor cancellation and leave-driven cancellation. */
export async function cancelSideEffects(c: Client, a: any, notifyParties: boolean) {
  await c.query(`UPDATE notifications SET status='CANCELLED', updated_at=now()
                 WHERE appointment_id=$1 AND type='APPT_REMINDER' AND status IN ('PENDING','QUEUED','FAILED')`, [a.id]);
  if (!notifyParties) return;
  await notify(c, { userId: a.patient_id, type: 'APPT_CANCELLED', appointmentId: a.id, dedupeKey: `appt-cancelled:${a.id}:patient` });
  await notify(c, { userId: a.doctor_id,  type: 'APPT_CANCELLED', appointmentId: a.id, dedupeKey: `appt-cancelled:${a.id}:doctor` });
}

export async function listFor(pool: Pool, user: AuthUser) {
  const where = user.role === 'ADMIN' ? 'TRUE' : user.role === 'DOCTOR' ? 'a.doctor_id = $1' : 'a.patient_id = $1';
  const r = await pool.query(
    `SELECT a.id, a.doctor_id, a.patient_id, a.start_at, a.end_at, a.status, a.reason, a.hold_expires_at,
            du.name AS doctor_name, pu.name AS patient_name
     FROM appointments a JOIN users du ON du.id=a.doctor_id JOIN users pu ON pu.id=a.patient_id
     WHERE ${where} ORDER BY a.start_at DESC LIMIT 200`, user.role === 'ADMIN' ? [] : [user.id]);
  return r.rows;
}

export const completeSchema = z.object({
  notes: z.string().trim().min(3).max(5000),
  medications: z.array(z.object({
    name: z.string().trim().min(1).max(120), dosage: z.string().trim().min(1).max(120),
    instructions: z.string().trim().max(500).optional(),
    timesOfDay: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(6),
    durationDays: z.number().int().min(1).max(config.medReminderMaxDays),
  })).max(20).default([]),
});

export async function complete(pool: Pool, jobs: Jobs, doctorId: string, id: string, input: z.infer<typeof completeSchema>) {
  await tx(pool, async (c) => {
    const a = (await c.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!a || a.doctor_id !== doctorId) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
    if (a.status !== 'CONFIRMED') throw new AppError(409, 'NOT_COMPLETABLE', `Appointment is ${a.status}`);
    if (a.start_at > new Date()) throw new AppError(409, 'NOT_STARTED', 'Appointment has not started yet');
    await c.query(`UPDATE appointments SET status='COMPLETED', doctor_notes=$2, updated_at=now() WHERE id=$1`, [id, input.notes]);
    const tz = (await c.query('SELECT timezone FROM users WHERE id=$1', [a.patient_id])).rows[0].timezone;
    for (const m of input.medications) {
      const med = (await c.query(
        `INSERT INTO medications (patient_id, appointment_id, name, dosage, instructions, times_of_day, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6::time[], (now() AT TIME ZONE $7::text)::date, (now() AT TIME ZONE $7::text)::date + $8::int - 1)
         RETURNING id, start_date, end_date`,
        [a.patient_id, id, m.name, m.dosage, m.instructions ?? null, m.timesOfDay, tz, m.durationDays])).rows[0];
      // One row per (day, time). dedupe_key makes re-runs harmless. Past times are skipped.
      await c.query(
        `INSERT INTO notifications (user_id, type, appointment_id, payload, dedupe_key, send_at)
         SELECT $1, 'MED_REMINDER', $2, jsonb_build_object('medication',$3::text,'dosage',$4::text,'time',t::text),
                'med:'||$5::text||':'||d::date||':'||t::text, ((d::date + t) AT TIME ZONE $6::text)
         FROM generate_series($7::timestamp, $8::timestamp, interval '1 day') AS d, unnest($9::time[]) AS t
         WHERE ((d::date + t) AT TIME ZONE $6::text) > now()
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [a.patient_id, id, m.name, m.dosage, med.id, tz, med.start_date, med.end_date, m.timesOfDay]);
    }
    await c.query(`INSERT INTO visit_summaries (appointment_id, kind) VALUES ($1,'POST') ON CONFLICT DO NOTHING`, [id]);
  });
  await jobs.summary(id, 'POST').catch(() => {});
}
