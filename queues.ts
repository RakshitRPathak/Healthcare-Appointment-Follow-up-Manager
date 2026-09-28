import { Queue, Worker, UnrecoverableError, ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from '../db';
import type { Jobs } from './types';
import type { Mailer } from '../integrations/mailer';
import type { Llm } from '../integrations/llm';
import { LlmError } from '../integrations/llm';
import type { CalendarClient } from '../integrations/calendar';
import { processNotification } from '../services/notifications';
import { generateSummary } from '../services/summaries';
import { syncCalendar } from '../services/calendarSync';
import { reconcile } from './reconcile';

const backoff = (delay: number) => ({ type: 'exponential', delay });
const base = { removeOnComplete: true, removeOnFail: true };   // truth lives in Postgres (status, attempts, last_error)

export function createQueues(redisUrl: string) {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null }) as unknown as ConnectionOptions;
  const notifications = new Queue('notifications', { connection });
  const summaries = new Queue('summaries', { connection });
  const calendar = new Queue('calendar', { connection });

  const enqueueNotification = async (id: string) => { await notifications.add('send', { id }, { ...base, jobId: `n_${id}`, attempts: 5, backoff: backoff(30_000) }); };
  const jobs: Jobs = {
    summary: async (appointmentId, kind) => { await summaries.add('gen', { appointmentId, kind }, { ...base, jobId: `s_${kind}_${appointmentId}`, attempts: 3, backoff: backoff(20_000) }); },
    calendar: async (appointmentId) => { await calendar.add('sync', { appointmentId }, { ...base, attempts: 5, backoff: backoff(30_000) }); },
  };
  return { connection, jobs, enqueueNotification,
    close: async () => { await Promise.all([notifications.close(), summaries.close(), calendar.close()]); await (connection as unknown as Redis).quit(); } };
}

export function startWorkers(pool: Pool, q: ReturnType<typeof createQueues>, deps: { mailer: Mailer; llm: Llm; calendar: CalendarClient }) {
  const c = q.connection;
  const workers = [
    new Worker('notifications', async (job) => { await processNotification(pool, job.data.id, deps.mailer); }, { connection: c, concurrency: 10 }),
    new Worker('summaries', async (job) => {
      try { await generateSummary(pool, job.data.appointmentId, job.data.kind, deps.llm); }
      catch (e) { if (e instanceof LlmError && !e.retryable) throw new UnrecoverableError(e.message); throw e; }
    }, { connection: c, concurrency: 3 }),
    new Worker('calendar', async (job) => { await syncCalendar(pool, job.data.appointmentId, deps.calendar); }, { connection: c, concurrency: 5 }),
  ];
  workers.forEach((w) => w.on('error', (e) => console.error('[worker]', e.message)));
  const tick = () => reconcile(pool, q.jobs, q.enqueueNotification).catch((e) => console.error('[reconcile]', e.message));
  const timer = setInterval(tick, 5_000); tick();
  return async () => { clearInterval(timer); await Promise.all(workers.map((w) => w.close())); };
}
