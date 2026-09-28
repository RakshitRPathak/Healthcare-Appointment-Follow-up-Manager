import { beforeEach, describe, expect, it } from 'vitest';
import { auth, createDoctor, createPatient, istDate, makeApp, pool, resetDb, slot } from './helpers';

beforeEach(resetDb);

describe('doctor-leave conflicts', () => {
  it('slot list is 09:00-16:30 IST and shrinks around leave', async () => {
    const { api } = makeApp(); const doc = await createDoctor(); const p = await createPatient();
    const d = istDate(3);
    const s1 = await api().get(`/doctors/${doc.id}/slots?date=${d}`).set(auth(p.token));
    expect(s1.body).toHaveLength(16);
    expect(s1.body[0].startAt).toBe(new Date(`${d}T09:00:00+05:30`).toISOString());
    expect(s1.body[15].startAt).toBe(new Date(`${d}T16:30:00+05:30`).toISOString());
    await api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 12), endsAt: slot(3, 14) }).expect(201);
    const s2 = await api().get(`/doctors/${doc.id}/slots?date=${d}`).set(auth(p.token));
    expect(s2.body).toHaveLength(12);                                                // 12:00,12:30,13:00,13:30 gone
  });

  it('booking inside leave -> 409 DOCTOR_ON_LEAVE', async () => {
    const { api } = makeApp(); const doc = await createDoctor(); const p = await createPatient();
    await api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 9), endsAt: slot(3, 12) }).expect(201);
    const r = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3, 10), reason: 'during leave' });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('DOCTOR_ON_LEAVE');
    const ok = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3, 12), reason: 'right after leave' });
    expect(ok.status).toBe(201);                                                     // leave end is exclusive
  });

  it('leave that overlaps existing bookings is refused, lists them, and changes nothing', async () => {
    const { api } = makeApp(); const doc = await createDoctor(); const p = await createPatient();
    const appt = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3, 10), reason: 'booked earlier' });
    const r = await api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 9), endsAt: slot(3, 12) });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('LEAVE_CONFLICTS');
    expect(r.body.error.details.appointments.map((a: any) => a.id)).toEqual([appt.body.id]);
    expect((await pool.query('SELECT count(*)::int c FROM doctor_leaves')).rows[0].c).toBe(0);
    expect((await pool.query('SELECT status FROM appointments')).rows[0].status).toBe('CONFIRMED');
  });

  it('cancelConflicts=true cancels affected appointments, notifies patient, cancels reminder, queues calendar cleanup', async () => {
    const { api, jobs } = makeApp(); const doc = await createDoctor(); const p = await createPatient();
    const appt = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3, 10), reason: 'booked earlier' });
    const r = await api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 9), endsAt: slot(3, 12), cancelConflicts: true });
    expect(r.status).toBe(201); expect(r.body.cancelledAppointments).toEqual([appt.body.id]);
    const a = (await pool.query('SELECT status, cancel_reason FROM appointments WHERE id=$1', [appt.body.id])).rows[0];
    expect(a).toEqual({ status: 'CANCELLED_LEAVE', cancel_reason: 'Doctor is on leave' });
    const n = (await pool.query(`SELECT type, user_id, status FROM notifications WHERE type IN ('APPT_CANCELLED','APPT_REMINDER') ORDER BY type`)).rows;
    expect(n.find((x) => x.type === 'APPT_CANCELLED' && x.user_id === p.id)).toBeTruthy();
    expect(n.find((x) => x.type === 'APPT_REMINDER')!.status).toBe('CANCELLED');
    expect(jobs.calendars).toContain(appt.body.id);
    // the patient can rebook another time
    const again = await api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3, 13), reason: 'rebooking now' });
    expect(again.status).toBe(201);
  });

  it('race: booking vs leave creation for the same time never leaves a booking inside a leave', async () => {
    for (let i = 0; i < 8; i++) {
      await resetDb();
      const { api } = makeApp(); const doc = await createDoctor(); const p = await createPatient();
      const [b, l] = await Promise.all([
        api().post('/appointments').set(auth(p.token)).send({ doctorId: doc.id, startAt: slot(3, 10), reason: 'racing the leave' }),
        api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 9), endsAt: slot(3, 12) }),
      ]);
      const bad = await pool.query(
        `SELECT 1 FROM appointments a JOIN doctor_leaves l ON l.doctor_id=a.doctor_id
         WHERE a.status IN ('HELD','CONFIRMED') AND tstzrange(l.starts_at,l.ends_at) && a.during`);
      expect(bad.rowCount).toBe(0);
      expect([b.status, l.status].sort()).toEqual([201, 409]);                         // exactly one side wins
    }
  });

  it('leave validation and management', async () => {
    const { api } = makeApp(); const doc = await createDoctor();
    const bad = await api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 12), endsAt: slot(3, 9) });
    expect(bad.status).toBe(400);
    const ok = await api().post('/doctors/me/leaves').set(auth(doc.token)).send({ startsAt: slot(3, 9), endsAt: slot(3, 12) });
    const list = await api().get('/doctors/me/leaves').set(auth(doc.token));
    expect(list.body).toHaveLength(1);
    await api().delete(`/doctors/me/leaves/${ok.body.leave.id}`).set(auth(doc.token)).expect(204);
  });
});
