# Healthcare Appointment & Follow-up Manager

[![tests](https://github.com/RakshitRPathak/Healthcare-Appointment-Follow-up-Manager/actions/workflows/ci.yml/badge.svg)](https://github.com/RakshitRPathak/Healthcare-Appointment-Follow-up-Manager/actions/workflows/ci.yml)

A booking backend for a clinic: patients book doctors, doctors manage leave and write visit notes, and the system sends
reminders and drafts visit summaries with an LLM. I built it around the places where booking systems usually break:
two people grabbing the same slot, a doctor adding leave over existing bookings, an email provider that times out,
and a language model that returns something wrong.

Node + TypeScript + Express, PostgreSQL, JWT auth with three roles (patient, doctor, admin), BullMQ + Redis for
background work. **51 integration tests run against a real Postgres** on every push.

The project started as a front-end hackathon entry in 2024. In 2026 I rebuilt it as a backend and kept the focus on
correctness under failure.

## Run it

```bash
cd server && npm install
export DATABASE_URL=postgresql://ham:ham@localhost:5432/ham REDIS_URL=redis://localhost:6379 JWT_SECRET=<long random>
npm run seed      # applies sql/001_init.sql, creates an admin and one doctor
npm start         # API on :3000
npm run worker    # emails, LLM summaries, calendar sync and sweeps, in a separate process
```

Tests need a Postgres with a `ham_test` database owned by `ham` (`services.sh` sets this up on Debian or Ubuntu), then
`npm test`. Redis is not needed for the tests.

Optional: `OPENAI_API_KEY`, `SMTP_HOST/PORT/USER/PASS`, `GOOGLE_CLIENT_ID/SECRET`. Without them the system still runs:
emails are logged instead of sent, summaries use the deterministic fallback, and calendar sync is skipped.

## How it handles the hard cases

**Two people booking the same slot.** A booking runs in one transaction that locks the doctor's row, checks the slot
against the doctor's working hours (in the doctor's time zone), checks leave, expires stale holds, then inserts. Two
Postgres `EXCLUDE USING gist` constraints on the appointment's time range, one per doctor and one per patient, are the
last line of defence: double-booking is impossible even if the application code has a bug. The loser gets
`409 SLOT_ALREADY_BOOKED`. A patient can also hold a slot for 5 minutes before confirming; expired holds are ignored
by availability, swept by the worker, and confirming one returns `410 HOLD_EXPIRED`.

**A doctor adds leave over existing bookings.** Booking inside leave returns `409 DOCTOR_ON_LEAVE`. Creating leave
that overlaps bookings returns `409 LEAVE_CONFLICTS` with the list and changes nothing. With `cancelConflicts: true`
those bookings become `CANCELLED_LEAVE`, patients are notified, and their reminders and calendar events are cancelled.
Leave creation and booking take the same row lock, so they can't race; the test for this runs the race 8 times.

**An email that never arrives.** Notifications use a transactional outbox: the email row is written in the same
transaction as the booking, so "booked" and "email will be sent" can't disagree. A dispatcher
(`FOR UPDATE SKIP LOCKED`) moves due rows to BullMQ. A worker claims a row with an atomic `UPDATE`, so two workers
can't send the same email, retries with exponential backoff, and after 5 attempts marks it `DEAD`. Dead rows show up at
`GET /admin/notifications` and can be requeued. A 30-second sweep re-arms rows lost to a crash or a Redis flush.
Delivery is at-least-once, and a stable `Message-ID` lets mail servers drop duplicates. Reminders are re-checked at
send time, so a cancelled appointment never gets one. Emails contain no clinical content.

**A language model that gets it wrong.** Prompts are versioned (`prompts.ts`), told to use only the facts inside a
`<data>` block, and treat the input as untrusted to guard against prompt injection. Only the clinically needed fields
are sent, never names, emails or IDs. Output is parsed and validated with zod, and post-visit summaries are checked so
the model can't mention a drug the doctor didn't prescribe. On a timeout, 5xx, bad JSON, schema violation or invented
drug, the system stores a deterministic fallback summary and retries in the background; a later success replaces it.
Summaries never block booking, and a patient only sees a visit summary after the doctor approves or edits it.

**Keeping all of this testable.** Services are plain functions that take a database pool and injected integrations
(`Llm`, `Mailer`, `CalendarClient`, `Jobs`). The tests swap in fakes, which is how every failure path above is covered
without calling OpenAI, an SMTP server or Google.

## API

| Endpoint | What it does |
|---|---|
| `POST /auth/register`, `POST /auth/login` | Patient sign-up; JWT login, throttled |
| `POST /admin/doctors` | Admin creates a doctor with working hours |
| `GET /doctors`, `GET /doctors/:id/slots?date=YYYY-MM-DD` | Browse doctors and their free slots |
| `POST /appointments` | Book directly (409 `SLOT_ALREADY_BOOKED`, `DOCTOR_ON_LEAVE`, `PATIENT_TIME_CONFLICT`; 422 `INVALID_SLOT`, `SLOT_IN_PAST`) |
| `POST /appointments/hold`, `POST /appointments/:id/confirm` | Hold a slot for 5 minutes, then confirm |
| `GET /appointments`, `DELETE /appointments/:id` | List your appointments (scoped by role), cancel |
| `POST /appointments/:id/complete` | Doctor records notes and prescriptions; creates medication reminders |
| `GET /appointments/:id/summaries`, `POST /summaries/:id/approve` | Pre- and post-visit summaries; doctor approval |
| `POST/GET/DELETE /doctors/me/leaves` | Doctor leave management |
| `GET /admin/notifications`, `POST /admin/notifications/:id/retry` | Inspect and requeue dead-lettered emails |

The schema is in `server/sql/001_init.sql`.

## Tests

| File | Covers |
|---|---|
| `concurrency.test.ts` | 20 patients racing for one slot, overlaps rejected by the database itself, holds and expiry, patient time conflicts |
| `leave.test.ts` | Leave over bookings, cancel-on-leave, the booking/leave race |
| `notifications.test.ts` | Atomic outbox writes, two workers racing on one email, retries, dead-letter, queue outage and crash recovery |
| `summaries.test.ts` | LLM validation, invented-drug check, fallback and upgrade |
| `calendar_meds.test.ts` | Calendar sync through a Google outage, visit completion rules, medication reminders, background sweeps |
| `security.test.ts` | Password hashing, login throttling, rejected tokens (including `alg=none`), role gates, input validation, cancellation rules |

## Known limits

- This repository is the backend only. There is no web front end.
- The data layer uses `pg` with plain SQL rather than an ORM, because the exclusion constraints and `FOR UPDATE`
  locking are easier to express and test directly in SQL.
- The Google Calendar and OpenAI integrations are tested with fakes; they have not been run against the live services.
- Login throttling is in memory, so it needs Redis if you run more than one API instance.
- This is not HIPAA-compliant as it stands. Real patient data would need encryption at rest, audit logging and a
  retention policy.

## License

MIT. See [LICENSE](LICENSE).
