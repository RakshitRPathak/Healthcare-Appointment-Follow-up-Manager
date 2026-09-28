import { z } from 'zod';
import { AppError } from '../errors';
import { Pool, tx } from '../db';
import type { Jobs } from '../jobs/types';
import { cancelSideEffects } from './booking';

export const leaveSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().max(300).optional(),
  cancelConflicts: z.boolean().default(false),
}).refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] });

/**
 * Policy: never silently break patient bookings.
 *  - conflicts found + cancelConflicts=false -> 409 LEAVE_CONFLICTS listing them, nothing changes
 *  - cancelConflicts=true -> each conflicting appointment becomes CANCELLED_LEAVE, patients are notified, reminders cancelled
 * Runs under the same doctor-row lock as booking, so a booking can't slip in between the check and the insert.
 */
export async function createLeave(pool: Pool, jobs: Jobs, doctorId: string, input: z.infer<typeof leaveSchema>) {
  const starts = new Date(input.startsAt), ends = new Date(input.endsAt);
  const { leave, cancelled } = await tx(pool, async (c) => {
    const d = await c.query('SELECT id FROM doctors WHERE id=$1 FOR UPDATE', [doctorId]);
    if (!d.rowCount) throw new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found');
    const conflicts = (await c.query(
      `SELECT * FROM appointments WHERE doctor_id=$1 AND during && tstzrange($2,$3,'[)')
         AND (status='CONFIRMED' OR (status='HELD' AND hold_expires_at > now())) FOR UPDATE`,
      [doctorId, starts, ends])).rows;
    if (conflicts.length && !input.cancelConflicts)
      throw new AppError(409, 'LEAVE_CONFLICTS', `${conflicts.length} appointment(s) fall inside this leave`,
        { appointments: conflicts.map((a) => ({ id: a.id, startAt: a.start_at, patientId: a.patient_id, status: a.status })) });
    const done: any[] = [];
    for (const a of conflicts) {
      const upd = (await c.query(
        `UPDATE appointments SET status='CANCELLED_LEAVE', cancel_reason='Doctor is on leave', updated_at=now()
         WHERE id=$1 RETURNING *`, [a.id])).rows[0];
      await cancelSideEffects(c, upd, a.status === 'CONFIRMED');
      done.push(upd);
    }
    const leave = (await c.query(
      `INSERT INTO doctor_leaves (doctor_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4) RETURNING *`,
      [doctorId, starts, ends, input.reason ?? null])).rows[0];
    return { leave, cancelled: done };
  });
  await Promise.allSettled(cancelled.map((a) => jobs.calendar(a.id)));
  return { leave, cancelledAppointments: cancelled.map((a) => a.id) };
}

export async function listLeaves(pool: Pool, doctorId: string) {
  return (await pool.query('SELECT * FROM doctor_leaves WHERE doctor_id=$1 AND ends_at > now() ORDER BY starts_at', [doctorId])).rows;
}

export async function deleteLeave(pool: Pool, doctorId: string, id: string) {
  const r = await pool.query('DELETE FROM doctor_leaves WHERE id=$1 AND doctor_id=$2', [id, doctorId]);
  if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Leave not found');
}
