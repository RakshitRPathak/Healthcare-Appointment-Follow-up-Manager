-- Healthcare Appointment & Follow-up Manager: schema
-- Needs a role allowed to CREATE EXTENSION btree_gist (superuser or trusted-extension owner).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_role AS ENUM ('PATIENT', 'DOCTOR', 'ADMIN');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE patients (
  id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dob                 date,
  allergies           text,
  chronic_conditions  text
);

CREATE TABLE doctors (
  id                    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialty             text NOT NULL,
  slot_minutes          int  NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 240),
  timezone              text NOT NULL DEFAULT 'Asia/Kolkata',
  google_refresh_token  text
);

-- Weekly recurring availability in the doctor's local time. weekday: 0 = Sunday .. 6 = Saturday
CREATE TABLE doctor_working_hours (
  id          bigserial PRIMARY KEY,
  doctor_id   uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday     int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX dwh_doctor_idx ON doctor_working_hours (doctor_id, weekday);

CREATE TABLE doctor_leaves (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id  uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX leaves_doctor_idx ON doctor_leaves (doctor_id, starts_at);

CREATE TABLE appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id        uuid NOT NULL REFERENCES doctors(id),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  during           tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  status           text NOT NULL CHECK (status IN
                   ('HELD','CONFIRMED','CANCELLED','CANCELLED_LEAVE','COMPLETED','NO_SHOW','EXPIRED')),
  hold_expires_at  timestamptz,
  reason           text,
  cancel_reason    text,
  doctor_notes     text,
  google_event_id  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- The database itself refuses double-booking, whatever the application does.
  CONSTRAINT appt_no_doctor_overlap  EXCLUDE USING gist (doctor_id  WITH =, during WITH &&) WHERE (status IN ('HELD','CONFIRMED')),
  CONSTRAINT appt_no_patient_overlap EXCLUDE USING gist (patient_id WITH =, during WITH &&) WHERE (status IN ('HELD','CONFIRMED'))
);
CREATE INDEX appt_doctor_start_idx  ON appointments (doctor_id, start_at);
CREATE INDEX appt_patient_start_idx ON appointments (patient_id, start_at);
CREATE INDEX appt_held_idx ON appointments (hold_expires_at) WHERE status = 'HELD';

CREATE TABLE medications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id     uuid NOT NULL REFERENCES patients(id),
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  name           text NOT NULL,
  dosage         text NOT NULL,
  instructions   text,
  times_of_day   time[] NOT NULL,
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  CHECK (end_date >= start_date)
);
CREATE INDEX med_patient_idx ON medications (patient_id, end_date);

CREATE TABLE visit_summaries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL REFERENCES appointments(id),
  kind            text NOT NULL CHECK (kind IN ('PRE','POST')),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','GENERATED','FALLBACK')),
  content         jsonb,
  source          text CHECK (source IN ('llm','fallback','doctor')),
  prompt_version  text,
  model           text,
  last_error      text,
  attempts        int NOT NULL DEFAULT 0,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id, kind)
);

-- Transactional outbox + delivery log for every email.
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  type            text NOT NULL,
  appointment_id  uuid REFERENCES appointments(id),
  payload         jsonb NOT NULL DEFAULT '{}',
  dedupe_key      text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','QUEUED','SENDING','SENT','FAILED','DEAD','CANCELLED')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  send_at         timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_due_idx  ON notifications (send_at) WHERE status = 'PENDING';
CREATE INDEX notif_appt_idx ON notifications (appointment_id);
