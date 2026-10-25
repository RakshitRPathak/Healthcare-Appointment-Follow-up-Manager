import { Pool } from '../db';
import type { CalendarClient } from '../integrations/calendar';

/** State-driven, not op-driven: "make Google match the DB for this appointment". Safe to run any number of times. */
export async function syncCalendar(pool: Pool, appointmentId: string, cal: CalendarClient): Promise<'created' | 'deleted' | 'noop'> {
  const r = await pool.query(
    `SELECT a.*, d.google_refresh_token AS token, d.timezone, pu.name AS patient_name
     FROM appointments a JOIN doctors d ON d.id=a.doctor_id JOIN users pu ON pu.id=a.patient_id WHERE a.id=$1`, [appointmentId]);
  const a = r.rows[0];
  if (!a || !a.token) return 'noop';
  const eventId = a.id.replace(/-/g, '');                                     // valid Google event id (base32hex charset)
  if (a.status === 'CONFIRMED' && !a.google_event_id) {
    await cal.createEvent({ eventId, refreshToken: a.token, title: `Appointment: ${a.patient_name}`, startAt: a.start_at, endAt: a.end_at, timeZone: a.timezone });
    await pool.query('UPDATE appointments SET google_event_id=$2 WHERE id=$1', [a.id, eventId]);
    return 'created';
  }
  if (['CANCELLED', 'CANCELLED_LEAVE', 'EXPIRED'].includes(a.status) && a.google_event_id) {
    await cal.deleteEvent({ eventId: a.google_event_id, refreshToken: a.token });
    await pool.query('UPDATE appointments SET google_event_id=NULL WHERE id=$1', [a.id]);
    return 'deleted';
  }
  return 'noop';
}
