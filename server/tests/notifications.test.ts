import { beforeEach, describe, expect, it } from 'vitest';
import { dispatchDue, processNotification, recoverStale } from '../src/services/notifications';
import { adminToken, auth, createDoctor, createPatient, FakeMailer, makeApp, pool, resetDb, slot } from './helpers';

beforeEach(resetDb);

async function booked() {
  const ctx = makeApp(); const doc = await createDoctor({ name: 'Rao' }); const p = await createPatient('Meera');
  const r = await ctx.api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'persistent cough' });
  const rows = (await pool.query('SELECT * FROM notifications ORDER BY type')).rows;
  return { ...ctx, doc, p, appt: r.body, rows };
}

describe('notification reliability (transactional outbox)', () => {
  it('a booking writes confirmation, doctor notice and a 24h reminder atomically', async () => {
    const { rows, appt } = await booked();
    expect(rows.map((r) => r.type)).toEqual(['APPT_CONFIRMED', 'APPT_NEW_DOCTOR', 'APPT_REMINDER']);
    const reminder = rows.find((r) => r.type === 'APPT_REMINDER');
    expect(reminder.send_at.getTime()).toBe(new Date(appt.start_at).getTime() - 24 * 3600_000);
  });

  it('sends the email to the right person with a stable Message-ID', async () => {
    const { rows, p } = await booked(); const mail = new FakeMailer();
    const conf = rows.find((r) => r.type === 'APPT_CONFIRMED');
    expect(await processNotification(pool, conf.id, mail)).toBe('sent');
    expect(mail.sent[0].to).toBe(p.email); expect(mail.sent[0].text).toContain('Dr. Rao');
    expect(mail.sent[0].messageId).toBe(`<${conf.id}@ham.local>`);
    expect((await pool.query('SELECT status, sent_at FROM notifications WHERE id=$1', [conf.id])).rows[0].status).toBe('SENT');
  });

  it('is idempotent: a second attempt on a SENT row does nothing', async () => {
    const { rows } = await booked(); const mail = new FakeMailer(); const id = rows[0].id;
    await processNotification(pool, id, mail);
    expect(await processNotification(pool, id, mail)).toBe('skipped');
    expect(mail.sent).toHaveLength(1);
  });

  it('two workers racing on the same notification send exactly one email', async () => {
    const { rows } = await booked(); const mail = new FakeMailer(); mail.delayMs = 50; const id = rows[0].id;
    const r = await Promise.all([processNotification(pool, id, mail), processNotification(pool, id, mail), processNotification(pool, id, mail)]);
    expect(r.filter((x) => x === 'sent')).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('transient SMTP failures are retried and eventually delivered, with attempts recorded', async () => {
    const { rows } = await booked(); const mail = new FakeMailer(); mail.failNext = 2; const id = rows[0].id;
    await expect(processNotification(pool, id, mail)).rejects.toThrow('smtp down');
    expect((await pool.query('SELECT status, last_error FROM notifications WHERE id=$1', [id])).rows[0]).toEqual({ status: 'FAILED', last_error: 'smtp down' });
    await expect(processNotification(pool, id, mail)).rejects.toThrow();
    await expect(processNotification(pool, id, mail)).resolves.toBe('sent');
    const r = (await pool.query('SELECT status, attempts, last_error FROM notifications WHERE id=$1', [id])).rows[0];
    expect(r).toEqual({ status: 'SENT', attempts: 3, last_error: null });
  });

  it('permanent failure ends in DEAD (dead-letter), stops retrying, and an admin can requeue it', async () => {
    const { rows, api } = await booked(); const mail = new FakeMailer(); mail.failAlways = true; const id = rows[0].id;
    for (let i = 0; i < 3; i++) await expect(processNotification(pool, id, mail, 3)).rejects.toThrow();
    expect((await pool.query('SELECT status, attempts FROM notifications WHERE id=$1', [id])).rows[0]).toEqual({ status: 'DEAD', attempts: 3 });
    expect(await processNotification(pool, id, mail, 3)).toBe('skipped');            // no more retries
    const admin = await adminToken();
    const dead = await api().get('/admin/notifications?status=DEAD').set(auth(admin));
    expect(dead.body.map((n: any) => n.id)).toEqual([id]);
    await api().post(`/admin/notifications/${id}/retry`).set(auth(admin)).expect(200);
    mail.failAlways = false;
    expect(await processNotification(pool, id, mail)).toBe('sent');
  });

  it('cancelling an appointment cancels its reminder, so a stale reminder is never emailed', async () => {
    const { appt, p, api, rows } = await booked(); const mail = new FakeMailer();
    await api().delete(`/appointments/${appt.id}?reason=changed%20plans`).set(auth(p.token)).expect(200);
    const reminder = rows.find((r) => r.type === 'APPT_REMINDER');
    expect(await processNotification(pool, reminder.id, mail)).toBe('skipped');
    expect(mail.sent).toHaveLength(0);
    const types = (await pool.query(`SELECT type FROM notifications WHERE type='APPT_CANCELLED'`)).rows;
    expect(types).toHaveLength(2);                                                    // patient + doctor told
  });

  it('a reminder that slipped past cancellation is still suppressed at send time', async () => {
    const { appt, rows } = await booked(); const mail = new FakeMailer();
    await pool.query(`UPDATE appointments SET status='CANCELLED' WHERE id=$1`, [appt.id]);   // bypass service on purpose
    const reminder = rows.find((r) => r.type === 'APPT_REMINDER');
    expect(await processNotification(pool, reminder.id, mail)).toBe('skipped');
    expect(mail.sent).toHaveLength(0);
  });

  it('dispatcher only picks DUE rows, marks them QUEUED once, and recovery re-arms rows lost with a dead worker', async () => {
    const { rows } = await booked(); const queued: string[] = [];
    const n = await dispatchDue(pool, async (id) => { queued.push(id); });
    expect(n).toBe(2);                                                                // reminder is 2 days away: not due
    expect(queued).not.toContain(rows.find((r) => r.type === 'APPT_REMINDER').id);
    expect(await dispatchDue(pool, async () => {})).toBe(0);                          // no double dispatch
    await pool.query(`UPDATE notifications SET updated_at = now() - interval '10 minutes' WHERE status='QUEUED'`);
    expect(await recoverStale(pool)).toBe(2);
    expect(await dispatchDue(pool, async () => {})).toBe(2);
  });

  it('parallel dispatchers never hand out the same row twice', async () => {
    await booked(); const seen: string[] = [];
    await Promise.all([1, 2, 3, 4].map(() => dispatchDue(pool, async (id) => { seen.push(id); })));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(2);
  });

  it('a queue outage after commit loses nothing: rows stay QUEUED-recoverable', async () => {
    await booked();
    await expect(dispatchDue(pool, async () => { throw new Error('redis down'); })).rejects.toThrow('redis down');
    await pool.query(`UPDATE notifications SET updated_at = now() - interval '10 minutes' WHERE status='QUEUED'`);
    expect(await recoverStale(pool)).toBeGreaterThan(0);
  });

  it('email content never contains clinical details', async () => {
    const { appt, doc, api } = await booked();
    await pool.query(`UPDATE appointments SET start_at = now() - interval '1 hour', end_at = now() - interval '30 minutes' WHERE id=$1`, [appt.id]);
    await api().post(`/appointments/${appt.id}/complete`).set(auth(doc.token)).send({ notes: 'confidential diagnosis text', medications: [] }).expect(200);
    const s = (await pool.query(`SELECT id FROM visit_summaries WHERE kind='POST'`)).rows[0];
    await pool.query(`UPDATE visit_summaries SET status='FALLBACK', content='{"summary":"x","findings":"secret","instructions":[],"medications":[],"followUp":"x","whenToSeekCare":[]}' WHERE id=$1`, [s.id]);
    await api().post(`/summaries/${s.id}/approve`).set(auth(doc.token)).send({}).expect(200);
    const mail = new FakeMailer(); const n = (await pool.query(`SELECT id FROM notifications WHERE type='POST_VISIT_SUMMARY'`)).rows[0];
    await processNotification(pool, n.id, mail);
    expect(mail.sent[0].text).not.toContain('secret'); expect(mail.sent[0].text).toContain('sign in');
  });
});
