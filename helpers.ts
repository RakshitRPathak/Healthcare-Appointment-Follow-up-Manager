import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createPool } from '../src/db';
import { createApp } from '../src/app';
import { signToken } from '../src/auth';
import type { Jobs } from '../src/jobs/types';
import type { Mailer, MailMessage } from '../src/integrations/mailer';
import { Llm, LlmError } from '../src/integrations/llm';

export const pool = createPool('postgresql://ham:ham@localhost:5432/ham_test', 25);

export class RecordingJobs implements Jobs {
  summaries: [string, string][] = []; calendars: string[] = [];
  async summary(id: string, kind: 'PRE' | 'POST') { this.summaries.push([id, kind]); }
  async calendar(id: string) { this.calendars.push(id); }
}
export class FakeMailer implements Mailer {
  sent: MailMessage[] = []; failNext = 0; failAlways = false; delayMs = 0;
  async send(m: MailMessage) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failAlways || this.failNext-- > 0) throw new Error('smtp down');
    this.sent.push(m);
  }
}
export class FakeLlm implements Llm {
  model = 'fake'; calls: { system: string; user: string }[] = []; constructor(public handler: (i: number) => string | Error) {}
  async complete(req: { system: string; user: string }) {
    this.calls.push(req);
    const r = this.handler(this.calls.length);
    if (r instanceof Error) throw r;
    return r;
  }
}
export const timeout = () => new LlmError('network or timeout: aborted', true);

export async function resetDb() { await pool.query('TRUNCATE users CASCADE'); }
export function makeApp() {
  const jobs = new RecordingJobs();
  const app = createApp({ pool, jobs, bcryptCost: 4 });
  return { app, jobs, api: () => request(app) };
}

let n = 0;
export async function createDoctor(o: { name?: string; slot?: number; token?: boolean } = {}) {
  const u = (await pool.query(`INSERT INTO users (email,password_hash,role,name) VALUES ($1,$2,'DOCTOR',$3) RETURNING id`,
    [`doc${++n}@t.test`, bcrypt.hashSync('Password#1', 4), o.name ?? `Doc${n}`])).rows[0];
  await pool.query('INSERT INTO doctors (id, specialty, slot_minutes, google_refresh_token) VALUES ($1,$2,$3,$4)',
    [u.id, 'General', o.slot ?? 30, o.token ? 'refresh-tok' : null]);
  for (let d = 0; d < 7; d++) await pool.query(`INSERT INTO doctor_working_hours (doctor_id, weekday, start_time, end_time) VALUES ($1,$2,'09:00','17:00')`, [u.id, d]);
  return { id: u.id as string, token: signToken({ id: u.id, role: 'DOCTOR' }) };
}
export async function createPatient(name = `Pat${++n}`) {
  const email = `pat${++n}@t.test`;
  const u = (await pool.query(`INSERT INTO users (email,password_hash,role,name) VALUES ($1,$2,'PATIENT',$3) RETURNING id`,
    [email, bcrypt.hashSync('Password#1', 4), name])).rows[0];
  await pool.query(`INSERT INTO patients (id, dob, allergies, chronic_conditions) VALUES ($1,'1990-04-01','penicillin','asthma')`, [u.id]);
  return { id: u.id as string, name, email, token: signToken({ id: u.id, role: 'PATIENT' }) };
}
export const adminToken = async () => {
  const u = (await pool.query(`INSERT INTO users (email,password_hash,role,name) VALUES ($1,$2,'ADMIN','Admin') RETURNING id`, [`admin${++n}@t.test`, 'x'])).rows[0];
  return signToken({ id: u.id, role: 'ADMIN' });
};

/** ISO timestamp for HH:MM on the IST calendar day `daysAhead` from now. */
export function slot(daysAhead: number, hh = 10, mm = 0) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + daysAhead * 86400_000).toISOString().slice(0, 10);
  return `${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`;
}
export const istDate = (daysAhead: number) => slot(daysAhead).slice(0, 10);
export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
