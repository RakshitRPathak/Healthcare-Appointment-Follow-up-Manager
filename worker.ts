import { config } from './config';
import { createPool } from './db';
import { migrate } from './migrate';
import { createQueues, startWorkers } from './jobs/queues';
import { SmtpMailer } from './integrations/mailer';
import { GoogleCalendar } from './integrations/calendar';
import { NullLlm, OpenAiLlm } from './integrations/llm';

const pool = createPool();
await migrate(pool);
const q = createQueues(config.redisUrl);
const llm = config.openaiKey ? new OpenAiLlm(config.openaiKey, config.openaiModel) : new NullLlm();
const stop = startWorkers(pool, q, { mailer: new SmtpMailer(), llm, calendar: new GoogleCalendar() });
console.log(`worker up (llm: ${llm.model})`);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await (await stop)(); await q.close(); await pool.end(); process.exit(0); });
