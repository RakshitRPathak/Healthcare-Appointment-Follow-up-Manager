import { Db } from '../db';

export interface Slot { start_at: Date; end_at: Date }

/** Every bookable-in-principle slot on a doctor's LOCAL calendar date (working hours only, ignores bookings/leave). */
export async function gridSlots(db: Db, doctorId: string, date: string): Promise<Slot[]> {
  const r = await db.query(
    `SELECT gs AS start_at, gs + make_interval(mins => d.slot_minutes) AS end_at
     FROM doctors d
     JOIN doctor_working_hours w ON w.doctor_id = d.id AND w.weekday = extract(dow FROM $2::date)::int
     CROSS JOIN LATERAL generate_series(
        (($2::date + w.start_time) AT TIME ZONE d.timezone),
        ((($2::date + w.end_time) AT TIME ZONE d.timezone) - make_interval(mins => d.slot_minutes)),
        make_interval(mins => d.slot_minutes)) AS gs
     WHERE d.id = $1 ORDER BY gs`, [doctorId, date]);
  return r.rows;
}

/** Grid minus live bookings, unexpired holds, doctor leave and the past. */
export async function availableSlots(db: Db, doctorId: string, date: string): Promise<Slot[]> {
  const grid = await gridSlots(db, doctorId, date);
  if (!grid.length) return [];
  const r = await db.query(
    `SELECT s.start_at, s.end_at FROM unnest($2::timestamptz[], $3::timestamptz[]) AS s(start_at, end_at)
     WHERE s.start_at > now()
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.doctor_id = $1
             AND (a.status = 'CONFIRMED' OR (a.status = 'HELD' AND a.hold_expires_at > now()))
             AND a.during && tstzrange(s.start_at, s.end_at, '[)'))
       AND NOT EXISTS (SELECT 1 FROM doctor_leaves l WHERE l.doctor_id = $1
             AND tstzrange(l.starts_at, l.ends_at, '[)') && tstzrange(s.start_at, s.end_at, '[)'))
     ORDER BY s.start_at`,
    [doctorId, grid.map((g) => g.start_at), grid.map((g) => g.end_at)]);
  return r.rows;
}
