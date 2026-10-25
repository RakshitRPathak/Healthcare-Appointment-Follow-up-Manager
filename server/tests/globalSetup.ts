import pg from 'pg';
import { migrate } from '../src/migrate';

export default async function setup() {
  const pool = new pg.Pool({ connectionString: 'postgresql://ham:ham@localhost:5432/ham_test' });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');   // fresh schema every run
  await migrate(pool as any);
  await pool.end();
}
