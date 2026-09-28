import { Pool } from '../db';
import type { Jobs } from './types';
import { dispatchDue, recoverStale } from '../services/notifications';

/**
 * Self-healing sweep, run every ~30s by the worker. Everything here is derived from DB state, so a lost queue message,
 * a crash between commit and enqueue, or a Redis flush only causes a short delay, never a lost email/summary/event.
 */
export async function reconcile(pool: Pool, jobs: Jobs, enqueueNotification: (id: string) => Promise<void>) {
  const out = { expiredHolds: 0, recovered: 0, dispatched: 0, summaries: 0, calendar: 0 };
  out.expiredHolds = (await pool.query(
    `UPDATE appointments SET status='EXPIRED', updated_at=now() WHERE status='HELD' AND hold_expires_at <= now()`)).rowCount ?? 0;
  out.recovered = await recoverStale(pool);
  out.dispatched = await dispatchDue(pool, enqueueNotification);

  const sums = (await pool.query(
    `SELECT s.appointment_id, s.kind FROM visit_summaries s JOIN appointments a ON a.id = s.appointment_id
     WHERE s.approved_at IS NULL AND s.status IN ('PENDING','FALLBACK') AND s.attempts < 5
       AND s.updated_at < now() - interval '2 minutes'
       AND ((s.kind='PRE' AND a.status='CONFIRMED') OR (s.kind='POST' AND a.status='COMPLETED')) LIMIT 200`)).rows;
  for (const s of sums) { await jobs.summary(s.appointment_id, s.kind).catch(() => {}); out.summaries++; }

  const cals = (await pool.query(
    `SELECT a.id FROM appointments a JOIN doctors d ON d.id=a.doctor_id
     WHERE d.google_refresh_token IS NOT NULL AND a.updated_at < now() - interval '1 minute'
       AND ((a.status='CONFIRMED' AND a.google_event_id IS NULL AND a.start_at > now())
         OR (a.status IN ('CANCELLED','CANCELLED_LEAVE','EXPIRED') AND a.google_event_id IS NOT NULL)) LIMIT 200`)).rows;
  for (const a of cals) { await jobs.calendar(a.id).catch(() => {}); out.calendar++; }
  return out;
}
