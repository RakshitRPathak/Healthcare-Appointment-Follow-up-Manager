import { createApp } from './app';
import { config } from './config';
import { createPool } from './db';
import { migrate } from './migrate';
import { createQueues } from './jobs/queues';

const pool = createPool();
await migrate(pool);
const q = createQueues(config.redisUrl);
createApp({ pool, jobs: q.jobs }).listen(config.port, () => console.log(`API on :${config.port}  (run "npm run worker" for background jobs)`));
