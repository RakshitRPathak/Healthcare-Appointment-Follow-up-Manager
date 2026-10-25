import { beforeEach, describe, expect, it } from 'vitest';
import { auth, createDoctor, createPatient, makeApp, pool, resetDb, slot } from './helpers';

beforeEach(resetDb);

describe('slot-conflict handling (mandatory concurrency test)', () => {
  it('two simultaneous bookings of the same slot: exactly one succeeds, the other gets 409 SLOT_ALREADY_BOOKED', async () => {
    const { api } = makeApp();
    const doc = await createDoctor();
    const [p1, p2] = [await createPatient(), await createPatient()];
    const body = { doctorId: doc.id, startAt: slot(3), reason: 'fever and cough' };
    const res = await Promise.all([
      api().post('/appointments').set(auth(p1.token)).send(body),
      api().post('/appointments').set(auth(p2.token)).send(body),
    ]);
    const statuses = res.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.error.code).toBe('SLOT_ALREADY_BOOKED');
    const rows = await pool.query(`SELECT count(*)::int c FROM appointments WHERE status='CONFIRMED'`);
    expect(rows.rows[0].c).toBe(1);
  });

  it('20 patients race for the same slot: exactly one winner, 19 clean 409s, no stray notifications', async () => {
    const { api } = makeApp();
    const doc = await createDoctor();
    const patients = await Promise.all(Array.from({ length: 20 }, () => createPatient()));
    const res = await Promise.all(patients.map((p) =>
      api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'checkup please' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409 && r.body.error.code === 'SLOT_ALREADY_BOOKED')).toHaveLength(19);
    // losers rolled back everything: only the winner's 3 rows (patient confirm, doctor notice, 24h reminder)
    expect((await pool.query('SELECT count(*)::int c FROM notifications')).rows[0].c).toBe(3);
  });

  it('30 patients spread over 3 slots: exactly 3 confirmed', async () => {
    const { api } = makeApp();
    const doc = await createDoctor();
    const patients = await Promise.all(Array.from({ length: 30 }, () => createPatient()));
    const slots = [slot(4, 9), slot(4, 9, 30), slot(4, 10)];
    const res = await Promise.all(patients.map((p, i) =>
      api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slots[i % 3], reason: 'routine visit' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    expect(res.filter((r) => r.status === 409)).toHaveLength(27);
  });

  it('the database itself rejects overlaps even if application logic is bypassed', async () => {
    const doc = await createDoctor(); const [a, b] = [await createPatient(), await createPatient()];
    const ins = (pid: string, s: string, e: string) => pool.query(
      `INSERT INTO appointments (doctor_id, patient_id, start_at, end_at, status) VALUES ($1,$2,$3,$4,'CONFIRMED')`, [doc.id, pid, s, e]);
    await ins(a.id, '2030-01-01T04:00:00Z', '2030-01-01T04:30:00Z');
    await expect(ins(b.id, '2030-01-01T04:15:00Z', '2030-01-01T04:45:00Z')).rejects.toMatchObject({ code: '23P01' });
    await expect(ins(b.id, '2030-01-01T04:30:00Z', '2030-01-01T05:00:00Z')).resolves.toBeTruthy();   // back-to-back is fine
  });

  it('a patient cannot hold two overlapping appointments with different doctors', async () => {
    const { api } = makeApp();
    const [d1, d2, p] = [await createDoctor(), await createDoctor(), await createPatient()];
    const ok = await api().post('/appointments').set(auth(p.token)).send({ doctorId: d1.id, startAt: slot(3), reason: 'first opinion' });
    const clash = await api().post('/appointments').set(auth(p.token)).send({ doctorId: d2.id, startAt: slot(3), reason: 'second opinion' });
    expect(ok.status).toBe(201);
    expect(clash.status).toBe(409); expect(clash.body.error.code).toBe('PATIENT_TIME_CONFLICT');
  });

  it('rejects off-grid, past and unknown slots with precise codes', async () => {
    const { api } = makeApp(); const doc = await createDoctor(); const p = await createPatient();
    const post = (startAt: string, doctorId = doc.id) => api().post('/appointments').set(auth(p.token)).send({ doctorId, startAt, reason: 'anything' });
    expect((await post(slot(3, 10, 15))).body.error.code).toBe('INVALID_SLOT');
    expect((await post(slot(3, 20))).body.error.code).toBe('INVALID_SLOT');          // outside working hours
    expect((await post(slot(-1))).body.error.code).toBe('SLOT_IN_PAST');
    expect((await post(slot(3), '00000000-0000-4000-8000-000000000000')).body.error.code).toBe('DOCTOR_NOT_FOUND');
  });
});

describe('slot holds', () => {
  it('a hold blocks others; confirming makes it a booking', async () => {
    const { api } = makeApp(); const doc = await createDoctor(); const [a, b] = [await createPatient(), await createPatient()];
    const h = await api().post('/appointments/hold').set(auth(a.token)).send({ doctorId: doc.id, startAt: slot(3) });
    expect(h.status).toBe(201); expect(h.body.status).toBe('HELD');
    const blocked = await api().post('/appointments').set(auth(b.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'need this slot' });
    expect(blocked.body.error.code).toBe('SLOT_ALREADY_BOOKED');
    const c = await api().post(`/appointments/${h.body.id}/confirm`).set(auth(a.token)).send({ reason: 'follow-up on rash' });
    expect(c.status).toBe(200); expect(c.body.status).toBe('CONFIRMED');
    const again = await api().post(`/appointments/${h.body.id}/confirm`).set(auth(a.token)).send({ reason: 'follow-up on rash' });
    expect(again.status).toBe(200);                                                   // idempotent
  });

  it('an expired hold frees the slot and can no longer be confirmed', async () => {
    const { api } = makeApp(); const doc = await createDoctor(); const [a, b] = [await createPatient(), await createPatient()];
    const h = await api().post('/appointments/hold').set(auth(a.token)).send({ doctorId: doc.id, startAt: slot(3) });
    await pool.query(`UPDATE appointments SET hold_expires_at = now() - interval '1 second' WHERE id=$1`, [h.body.id]);
    const stolen = await api().post('/appointments').set(auth(b.token)).send({ doctorId: doc.id, startAt: slot(3), reason: 'now available' });
    expect(stolen.status).toBe(201);
    const late = await api().post(`/appointments/${h.body.id}/confirm`).set(auth(a.token)).send({ reason: 'too late now' });
    expect(late.status).toBe(410); expect(late.body.error.code).toBe('HOLD_EXPIRED');
  });

  it('expired holds do not appear as unavailable in the slot list; live ones do', async () => {
    const { api } = makeApp(); const doc = await createDoctor(); const a = await createPatient();
    const h = await api().post('/appointments/hold').set(auth(a.token)).send({ doctorId: doc.id, startAt: slot(3) });
    const date = slot(3).slice(0, 10);
    const before = await api().get(`/doctors/${doc.id}/slots?date=${date}`).set(auth(a.token));
    expect(before.body).toHaveLength(15);
    await pool.query(`UPDATE appointments SET hold_expires_at = now() - interval '1 second' WHERE id=$1`, [h.body.id]);
    const after = await api().get(`/doctors/${doc.id}/slots?date=${date}`).set(auth(a.token));
    expect(after.body).toHaveLength(16);
  });
});
