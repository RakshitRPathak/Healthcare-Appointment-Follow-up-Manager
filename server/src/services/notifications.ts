import { config } from '../config';
import { Db, Pool } from '../db';
import type { Mailer } from '../integrations/mailer';

export type NotificationType =
  | 'APPT_CONFIRMED' | 'APPT_NEW_DOCTOR' | 'APPT_REMINDER' | 'APPT_CANCELLED'
  | 'POST_VISIT_SUMMARY' | 'MED_REMINDER';

/** Insert inside the caller's business transaction: the email exists iff the business change committed. */
export async function notify(db: Db, n: {
  userId: string; type: NotificationType; dedupeKey: string; appointmentId?: string;
  payload?: Record<string, unknown>; sendAt?: Date;
}) {
  await db.query(
    `INSERT INTO notifications (user_id, type, appointment_id, payload, dedupe_key, send_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, now())) ON CONFLICT (dedupe_key) DO NOTHING`,
    [n.userId, n.type, n.appointmentId ?? null, JSON.stringify(n.payload ?? {}), n.dedupeKey, n.sendAt ?? null]);
}

const fmt = (d: Date, tz: string) =>
  d.toLocaleString('en-IN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

async function render(pool: Db, n: any, user: { name: string; timezone: string }) {
  let a: any = null;
  if (n.appointment_id) {
    a = (await pool.query(
      `SELECT a.*, du.name AS doctor_name, pu.name AS patient_name FROM appointments a
       JOIN users du ON du.id = a.doctor_id JOIN users pu ON pu.id = a.patient_id WHERE a.id = $1`,
      [n.appointment_id])).rows[0];
  }
  const when = a ? fmt(a.start_at, user.timezone) : '';
  switch (n.type as NotificationType) {
    case 'APPT_CONFIRMED':
      return { subject: 'Appointment confirmed', text: `Hi ${user.name},\n\nYour appointment with Dr. ${a.doctor_name} is confirmed for ${when}.` };
    case 'APPT_NEW_DOCTOR':
      return { subject: 'New appointment booked', text: `Dr. ${user.name}, ${a.patient_name} booked ${when}.` };
    case 'APPT_REMINDER':
      return { subject: 'Appointment reminder', text: `Reminder: appointment with Dr. ${a.doctor_name} on ${when}.` };
    case 'APPT_CANCELLED':
      return { subject: 'Appointment cancelled',
               text: `The appointment on ${when} was cancelled.${a.cancel_reason ? ` Reason: ${a.cancel_reason}.` : ''} Please book a new slot.` };
    case 'POST_VISIT_SUMMARY': // deliberately no clinical content in email: patient logs in to read it
      return { subject: 'Your visit summary is ready', text: `Hi ${user.name},\n\nYour visit summary is ready. Please sign in to read it.` };
    case 'MED_REMINDER':
      return { subject: `Medication reminder: ${n.payload.medication}`,
               text: `Time to take ${n.payload.medication} (${n.payload.dosage}).` };
    default: throw new Error(`unknown notification type ${n.type}`);
  }
}

/** Claim -> send -> mark. The claim is an atomic UPDATE, so two workers can never send the same row. */
export async function processNotification(pool: Pool, id: string, mailer: Mailer, maxAttempts = config.maxNotificationAttempts)
  : Promise<'sent' | 'skipped'> {
  const claim = await pool.query(
    `UPDATE notifications SET status='SENDING', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status IN ('PENDING','QUEUED','FAILED') RETURNING *`, [id]);
  const n = claim.rows[0];
  if (!n) return 'skipped';                                   // already sent / cancelled / dead / being sent
  try {
    if (n.type === 'APPT_REMINDER') {
      const s = (await pool.query('SELECT status FROM appointments WHERE id=$1', [n.appointment_id])).rows[0];
      if (s?.status !== 'CONFIRMED') {
        await pool.query(`UPDATE notifications SET status='CANCELLED', updated_at=now() WHERE id=$1`, [id]);
        return 'skipped';
      }
    }
    const user = (await pool.query('SELECT email, name, timezone FROM users WHERE id=$1', [n.user_id])).rows[0];
    const msg = await render(pool, n, user);
    await mailer.send({ to: user.email, ...msg, messageId: `<${n.id}@ham.local>` }); // stable Message-ID helps receivers de-dupe
    await pool.query(`UPDATE notifications SET status='SENT', sent_at=now(), last_error=NULL, updated_at=now() WHERE id=$1`, [id]);
    return 'sent';
  } catch (e) {
    const dead = n.attempts >= maxAttempts;
    await pool.query(`UPDATE notifications SET status=$2, last_error=$3, updated_at=now() WHERE id=$1`,
      [id, dead ? 'DEAD' : 'FAILED', String((e as Error).message).slice(0, 500)]);
    throw e;                                                  // lets BullMQ apply its backoff
  }
}

/** Move due PENDING rows to QUEUED (row-locked, SKIP LOCKED so many dispatchers can run) then hand them to the queue. */
export async function dispatchDue(pool: Pool, enqueue: (id: string) => Promise<void>, batch = 100): Promise<number> {
  const c = await pool.connect();
  let ids: string[] = [];
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `SELECT id FROM notifications WHERE status='PENDING' AND send_at <= now()
       ORDER BY send_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]);
    ids = r.rows.map((x) => x.id);
    if (ids.length) await c.query(`UPDATE notifications SET status='QUEUED', updated_at=now() WHERE id = ANY($1)`, [ids]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  for (const id of ids) await enqueue(id);
  return ids.length;
}

/** Crash recovery: rows stuck QUEUED/SENDING (process died) go back to PENDING. Worst case is a duplicate send, never a lost one. */
export async function recoverStale(pool: Pool) {
  const r = await pool.query(
    `UPDATE notifications SET status='PENDING', updated_at=now()
     WHERE (status='QUEUED' AND updated_at < now() - interval '2 minutes')
        OR (status='SENDING' AND updated_at < now() - interval '5 minutes')`);
  return r.rowCount ?? 0;
}
