import { z } from 'zod';
import { AppError } from '../errors';
import { Pool, tx } from '../db';
import { Llm } from '../integrations/llm';
import { PROMPT_VERSION, PRE_SYSTEM, POST_SYSTEM, wrapData } from './prompts';
import { notify } from './notifications';

const str = z.string().trim().max(600);
export const preSchema = z.object({
  chiefComplaint: str, relevantHistory: z.array(str).max(10), currentMedications: z.array(str).max(20),
  allergies: z.array(str).max(10), suggestedQuestions: z.array(str).max(5), flags: z.array(str).max(10),
}).strict();
export const postSchema = z.object({
  summary: str, findings: str, instructions: z.array(str).max(10),
  medications: z.array(z.object({ name: str, dosage: str, howToTake: str }).strict()).max(20),
  followUp: str, whenToSeekCare: z.array(str).max(8),
}).strict();

const parseJson = (raw: string) => JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
const ageYears = (dob: Date | null) => (dob ? Math.floor((Date.now() - dob.getTime()) / 31_557_600_000) : null);

async function gatherPre(pool: Pool, appt: any) {
  const p = (await pool.query('SELECT dob, allergies, chronic_conditions FROM patients WHERE id=$1', [appt.patient_id])).rows[0];
  const prior = (await pool.query(
    `SELECT s.content->>'summary' AS summary FROM visit_summaries s JOIN appointments a ON a.id=s.appointment_id
     WHERE a.patient_id=$1 AND a.status='COMPLETED' AND s.kind='POST' AND s.approved_at IS NOT NULL
     ORDER BY a.start_at DESC LIMIT 3`, [appt.patient_id])).rows.map((r) => r.summary);
  const meds = (await pool.query(
    `SELECT name, dosage FROM medications WHERE patient_id=$1 AND end_date >= current_date`, [appt.patient_id])).rows;
  // PHI minimisation: no name, email or ids ever leave our system.
  return { visitReason: appt.reason, patient: { ageYears: ageYears(p.dob), allergies: p.allergies ?? 'not provided',
           chronicConditions: p.chronic_conditions ?? 'not provided' }, priorVisitSummaries: prior, activeMedications: meds };
}

const fallbackPre = (d: any) => ({
  chiefComplaint: d.visitReason ?? 'not provided',
  relevantHistory: [d.patient.chronicConditions, ...d.priorVisitSummaries].filter(Boolean),
  currentMedications: d.activeMedications.map((m: any) => `${m.name} ${m.dosage}`),
  allergies: [d.patient.allergies], suggestedQuestions: [], flags: ['Auto-generated without AI: review raw intake'],
});
const fallbackPost = (d: any) => ({
  summary: 'Your doctor has noted the outcome of your visit. Please read the details below.',
  findings: d.doctorNotes, instructions: [],
  medications: d.prescribedMedications.map((m: any) => ({ name: m.name, dosage: m.dosage, howToTake: m.instructions ?? 'as directed' })),
  followUp: 'Contact the clinic if you need a follow-up.', whenToSeekCare: ['If symptoms worsen or you feel unwell, contact the clinic or seek urgent care.'],
});

/** Post-visit guard: the model may not invent a drug the doctor did not prescribe. */
function assertMedsSubset(content: z.infer<typeof postSchema>, prescribed: { name: string }[]) {
  const ok = new Set(prescribed.map((m) => m.name.toLowerCase()));
  const bad = content.medications.find((m) => !ok.has(m.name.toLowerCase()));
  if (bad) throw new Error(`model invented medication "${bad.name}"`);
}

/**
 * Never blocks booking and never leaves the doctor/patient with nothing:
 *  success -> GENERATED (source llm)
 *  any failure (timeout, bad JSON, schema violation, invented drug) -> FALLBACK content is stored, then the error is
 *  rethrown so the job queue retries; a later success upgrades FALLBACK -> GENERATED.
 */
export async function generateSummary(pool: Pool, appointmentId: string, kind: 'PRE' | 'POST', llm: Llm) {
  const appt = (await pool.query('SELECT * FROM appointments WHERE id=$1', [appointmentId])).rows[0];
  if (!appt) return 'skipped';
  const existing = (await pool.query('SELECT status, approved_at FROM visit_summaries WHERE appointment_id=$1 AND kind=$2', [appointmentId, kind])).rows[0];
  if (existing?.status === 'GENERATED' || existing?.approved_at) return 'skipped';   // idempotent

  const data: any = kind === 'PRE' ? await gatherPre(pool, appt) : {
    doctorNotes: appt.doctor_notes,
    prescribedMedications: (await pool.query('SELECT name, dosage, instructions FROM medications WHERE appointment_id=$1', [appointmentId])).rows,
  };
  await pool.query(
    `INSERT INTO visit_summaries (appointment_id, kind, attempts) VALUES ($1,$2,1)
     ON CONFLICT (appointment_id, kind) DO UPDATE SET attempts = visit_summaries.attempts + 1, updated_at = now()`, [appointmentId, kind]);
  try {
    const raw = await llm.complete({ system: kind === 'PRE' ? PRE_SYSTEM : POST_SYSTEM, user: wrapData(data) });
    const parsed = (kind === 'PRE' ? preSchema : postSchema).parse(parseJson(raw));
    if (kind === 'POST') assertMedsSubset(parsed as z.infer<typeof postSchema>, data.prescribedMedications);
    await pool.query(
      `UPDATE visit_summaries SET status='GENERATED', content=$3, source='llm', prompt_version=$4, model=$5, last_error=NULL, updated_at=now()
       WHERE appointment_id=$1 AND kind=$2`, [appointmentId, kind, JSON.stringify(parsed), PROMPT_VERSION, llm.model]);
    return 'generated';
  } catch (e) {
    const fb = kind === 'PRE' ? fallbackPre(data) : fallbackPost(data);
    await pool.query(
      `UPDATE visit_summaries SET status='FALLBACK', content=$3, source='fallback', prompt_version=$4, model=$5, last_error=$6, updated_at=now()
       WHERE appointment_id=$1 AND kind=$2 AND status <> 'GENERATED'`,
      [appointmentId, kind, JSON.stringify(fb), PROMPT_VERSION, llm.model, String((e as Error).message).slice(0, 500)]);
    throw e;
  }
}

/** Visibility: doctor sees both; patient sees POST only once the doctor approved it. */
export async function listSummaries(pool: Pool, user: { id: string; role: string }, appointmentId: string) {
  const a = (await pool.query('SELECT doctor_id, patient_id FROM appointments WHERE id=$1', [appointmentId])).rows[0];
  const mine = a && (user.role === 'ADMIN' || a.doctor_id === user.id || a.patient_id === user.id);
  if (!mine) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
  const rows = (await pool.query(
    `SELECT id, kind, status, content, source, approved_at FROM visit_summaries WHERE appointment_id=$1 ORDER BY kind`, [appointmentId])).rows;
  if (user.role === 'PATIENT') return rows.filter((r) => r.kind === 'POST' && r.approved_at);
  return rows;
}

/** Doctor reviews (optionally edits) the patient-facing summary; only then is the patient notified. */
export async function approvePost(pool: Pool, doctorId: string, summaryId: string, edited?: unknown) {
  return tx(pool, async (c) => {
    const s = (await c.query(
      `SELECT s.*, a.doctor_id, a.patient_id FROM visit_summaries s JOIN appointments a ON a.id=s.appointment_id WHERE s.id=$1 FOR UPDATE OF s`,
      [summaryId])).rows[0];
    if (!s || s.doctor_id !== doctorId || s.kind !== 'POST') throw new AppError(404, 'NOT_FOUND', 'Summary not found');
    if (!s.content) throw new AppError(409, 'NOT_READY', 'Summary has not been generated yet');
    const content = edited ? postSchema.parse(edited) : s.content;
    await c.query(
      `UPDATE visit_summaries SET content=$2, approved_at=now(), source=CASE WHEN $3 THEN 'doctor' ELSE source END, updated_at=now() WHERE id=$1`,
      [summaryId, JSON.stringify(content), !!edited]);
    await notify(c, { userId: s.patient_id, type: 'POST_VISIT_SUMMARY', appointmentId: s.appointment_id, dedupeKey: `post-summary:${summaryId}` });
    return { id: summaryId, approved: true };
  });
}
