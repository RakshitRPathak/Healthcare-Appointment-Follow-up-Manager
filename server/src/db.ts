import pg from 'pg';
import { config } from './config';

// Return timestamptz as Date (default) and int8 as number (our counters are small).
pg.types.setTypeParser(20, (v) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
export type Db = Pick<pg.Pool, 'query'>;

export function createPool(url = config.databaseUrl, max = 10): Pool {
  return new pg.Pool({ connectionString: url, max });
}

export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
