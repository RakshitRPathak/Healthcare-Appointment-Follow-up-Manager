import { beforeEach, describe, expect, it } from 'vitest';
import { CalendarClient, CalendarEvent } from '../src/integrations/calendar';
import { reconcile } from '../src/jobs/reconcile';
import { syncCalendar } from '../src/services/calendarSync';
import { auth, createDoctor, createPatient, makeApp, pool, resetDb, RecordingJobs, slot } from './helpers';

beforeEach(resetDb);

class FakeCal implements CalendarClient {
  events = new Map<string, CalendarEvent>(); fail = false; creates = 0; deletes = 0;
  async createEvent(e: CalendarEvent) { if (this.fail) throw new Error('google 503'); this.creates++; this.events.set(e.eventId, e); }
  async deleteEvent(a: { eventId: string }) { if (this.fail) throw new Error('google 503'); this.deletes++; this.events.delete(a.eventId); }
}

describe('Google Calendar sync', () => {
  it('creates once (idempotent), stores the event id, deletes on cancel, is a no-op without a token', async () => {
    const { api } = makeApp(); const cal = new FakeCal();
    const [doc, plain, p] = [await createDoctor({ token: true }), await createDoctor(), await createPatient('Meera')];
    const a = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'calendar test' });
    expect(await syncCalendar(pool, a.body.id, cal)).toBe('created');
    expect(await syncCalendar(pool, a.body.id, cal)).toBe('noop');
    expect(cal.creates).toBe(1);
    const ev = [...cal.events.values()][0];
    expect(ev.eventId).toBe(a.body.id.replace(/-/g, '')); expect(ev.timeZone).toBe('Asia/Kolkata'); expect(ev.title).toContain('Meera');
    await api().delete(`/appointments/${a.body.id}`).set(auth(p.token));
    expect(await syncCalendar(pool, a.body.id, cal)).toBe('deleted'); expect(cal.events.size).toBe(0);
    expect(await syncCalendar(pool, a.body.id, cal)).toBe('noop');
    const b = await api().post('/appointments').set(auth(p.token)).send({ doctorId: plain.id, startAt: slot(4), reason: 'no calendar linked' });
    expect(await syncCalendar(pool, b.body.id, cal)).toBe('noop');
  });

  it('Google outage never breaks booking; reconcile repairs it once Google is back', async () => {
    const { api } = makeApp(); const cal = new FakeCal(); cal.fail = true;
    const [doc, p] = [await createDoctor({ token: true }), await createPatient()];
    const a = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'calendar outage' });
    expect(a.status).toBe(201);
    await expect(syncCalendar(pool, a.body.id, cal)).rejects.toThrow('google 503');
    expect((await pool.query('SELECT google_event_id FROM appointments WHERE id=$1', [a.body.id])).rows[0].google_event_id).toBeNull();
    await pool.query(`UPDATE appointments SET updated_at = now() - interval '5 minutes'`);
    const jobs = new RecordingJobs(); await reconcile(pool, jobs, async () => {});
    expect(jobs.calendars).toEqual([a.body.id]);                                      // sweep re-queues the missing sync
    cal.fail = false;
    expect(await syncCalendar(pool, a.body.id, cal)).toBe('created');
  });

  it('leave-driven cancellation removes the calendar event too', async () => {
    const { api } = makeApp(); const cal = new FakeCal();
    const [doc, p] = [await createDoctor({ token: true }), await createPatient()];
    const a = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3, 10), reason: 'will be displaced' });
    await syncCalendar(pool, a.body.id, cal);
    await api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 9), endsAt: slot(3, 12), cancelConflicts: true }).expect(201);
    expect(await syncCalendar(pool, a.body.id, cal)).toBe('deleted');
  });
});

describe('completion + medication reminders', () => {
  async function started() {
    const ctx = makeApp(); const doc = await createDoctor(); const p = await createPatient();
    const a = await ctx.api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'follow up visit' });
    return { ...ctx, doc, p, id: a.body.id as string };
  }
  const start = (id: string) => pool.query(`UPDATE appointments SET start_at = now() - interval '1 hour', end_at = now() - interval '30 minutes' WHERE id=$1`, [id]);

  it('cannot complete before the visit starts, by another doctor, or twice', async () => {
    const { api, doc, id } = await started(); const other = await createDoctor();
    const body = { notes: 'notes here', medications: [] };
    expect((await api().post(`/appointments/${id}/complete`).set(auth(doc.token)).send(body)).body.error.code).toBe('NOT_STARTED');
    await start(id);
    expect((await api().post(`/appointments/${id}/complete`).set(auth(other.token)).send(body)).status).toBe(404);
    expect((await api().post(`/appointments/${id}/complete`).set(auth(doc.token)).send(body)).status).toBe(200);
    expect((await api().post(`/appointments/${id}/complete`).set(auth(doc.token)).send(body)).body.error.code).toBe('NOT_COMPLETABLE');
  });

  it('prescribing creates future-only, de-duplicated reminders at the requested local times', async () => {
    const { api, doc, id, jobs } = await started(); await start(id);
    await api().post(`/appointments/${id}/complete`).set(auth(doc.token)).send({
      notes: 'started antibiotics', medications: [{ name: 'Amoxicillin', dosage: '500mg', timesOfDay: ['08:00', '20:00'], durationDays: 3 }] }).expect(200);
    const rows = (await pool.query(`SELECT dedupe_key, send_at, payload FROM notifications WHERE type='MED_REMINDER' ORDER BY send_at`)).rows;
    expect(rows.length).toBeGreaterThanOrEqual(4); expect(rows.length).toBeLessThanOrEqual(6);
    expect(rows.every((r) => r.send_at > new Date())).toBe(true);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(rows.length);
    const hoursIst = rows.map((r) => Number(new Date(r.send_at.getTime() + 5.5 * 3600_000).toISOString().slice(11, 13)));
    expect(hoursIst.every((h) => h === 8 || h === 20)).toBe(true);
    expect(rows[0].payload).toMatchObject({ medication: 'Amoxicillin', dosage: '500mg' });
    expect(jobs.summaries).toContainEqual([id, 'POST']);
    expect((await pool.query('SELECT status FROM appointments WHERE id=$1', [id])).rows[0].status).toBe('COMPLETED');
  });

  it('validates prescriptions (bad time format, zero/oversized duration)', async () => {
    const { api, doc, id } = await started(); await start(id);
    const send = (m: object) => api().post(`/appointments/${id}/complete`).set(auth(doc.token)).send({ notes: 'valid notes', medications: [m] });
    expect((await send({ name: 'X', dosage: '1', timesOfDay: ['25:00'], durationDays: 3 })).status).toBe(400);
    expect((await send({ name: 'X', dosage: '1', timesOfDay: ['08:00'], durationDays: 0 })).status).toBe(400);
    expect((await send({ name: 'X', dosage: '1', timesOfDay: ['08:00'], durationDays: 999 })).status).toBe(400);
    expect((await pool.query('SELECT status FROM appointments WHERE id=$1', [id])).rows[0].status).toBe('CONFIRMED');   // nothing half-applied
  });
});

describe('reconcile sweep', () => {
  it('expires stale holds and re-queues summaries that never generated', async () => {
    const { api } = makeApp(); const [doc, p] = [await createDoctor(), await createPatient()];
    const h = await api().post('/appointments/hold').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3) });
    await pool.query(`UPDATE appointments SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [h.body.id]);
    const b = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(4), reason: 'summary never ran' });
    await pool.query(`UPDATE visit_summaries SET updated_at = now() - interval '10 minutes'`);
    const jobs = new RecordingJobs(); const r = await reconcile(pool, jobs, async () => {});
    expect(r.expiredHolds).toBe(1); expect(jobs.summaries).toEqual([[b.body.id, 'PRE']]);
    expect((await pool.query('SELECT status FROM appointments WHERE id=$1', [h.body.id])).rows[0].status).toBe('EXPIRED');
  });
});
