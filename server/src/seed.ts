import bcrypt from 'bcryptjs';
import { createPool } from './db';
import { migrate } from './migrate';

const pool = createPool();
await migrate(pool);
const h = (p: string) => bcrypt.hashSync(p, 10);
const admin = await pool.query(`INSERT INTO users (email,password_hash,role,name) VALUES ('admin@clinic.test',$1,'ADMIN','Admin') ON CONFLICT DO NOTHING RETURNING id`, [h('Admin#12345')]);
const doc = await pool.query(`INSERT INTO users (email,password_hash,role,name) VALUES ('dr.rao@clinic.test',$1,'DOCTOR','Asha Rao') ON CONFLICT DO NOTHING RETURNING id`, [h('Doctor#12345')]);
if (doc.rows[0]) {
  await pool.query(`INSERT INTO doctors (id, specialty, slot_minutes) VALUES ($1,'General Medicine',30)`, [doc.rows[0].id]);
  for (const d of [1, 2, 3, 4, 5]) await pool.query(`INSERT INTO doctor_working_hours (doctor_id, weekday, start_time, end_time) VALUES ($1,$2,'09:00','17:00')`, [doc.rows[0].id, d]);
}
console.log(admin.rowCount || doc.rowCount ? 'seeded: admin@clinic.test / Admin#12345, dr.rao@clinic.test / Doctor#12345' : 'already seeded');
await pool.end();
