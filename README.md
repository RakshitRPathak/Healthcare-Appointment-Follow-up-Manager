# Healthcare Appointment & Follow-up Manager: server

Node + TypeScript + Express, PostgreSQL, JWT (PATIENT / DOCTOR / ADMIN), BullMQ + Redis.
51 tests run against a real Postgres. `npm test` (needs Postgres with a `ham_test` DB).

## Run
```bash
cd server && npm install
export DATABASE_URL=postgresql://ham:ham@localhost:5432/ham REDIS_URL=redis://localhost:6379 JWT_SECRET=<long random>
npm run seed      # applies sql/001_init.sql, creates admin + one doctor
npm start         # API on :3000
npm run worker    # emails, LLM summaries, calendar sync, sweeps (separate process)
```
Optional: `OPENAI_API_KEY`, `SMTP_HOST/PORT/USER/PASS`, `GOOGLE_CLIENT_ID/SECRET`. Without them the system still runs:
emails are logged, summaries use the deterministic fallback, calendar sync is skipped.

## Design decisions, in the spec's priority order

**1. Slot conflicts.** Bookings run in one transaction that locks the doctor row, validates the slot against the doctor's
working-hours grid (in the doctor's time zone), checks leave, expires stale holds, then inserts. Two Postgres
`EXCLUDE USING gist` constraints on the appointment time range (doctor and patient) are the last line of defence, so
double-booking is impossible even if application code has a bug. The loser gets `409 SLOT_ALREADY_BOOKED`.
Holds are `HELD` rows with an expiry (5 min); expired holds are ignored by availability, swept by the worker, and
`confirm` after expiry returns `410 HOLD_EXPIRED`.

**2. Doctor leave.** Booking inside leave -> `409 DOCTOR_ON_LEAVE`. Creating leave over existing bookings -> `409 LEAVE_CONFLICTS`
listing them and changing nothing. With `cancelConflicts: true` they become `CANCELLED_LEAVE`, patients are notified,
reminders and calendar events are cancelled. Leave creation and booking take the same doctor-row lock, so they can't race
(tested 8x).

**3. Notification reliability.** Transactional outbox: the email row is inserted in the same transaction as the booking,
so "booked" and "email will be sent" can't diverge. A dispatcher (`FOR UPDATE SKIP LOCKED`) moves due rows to BullMQ; the
worker claims a row with an atomic UPDATE (two workers can't double-send), retries with exponential backoff, and after
5 attempts marks it `DEAD` (dead-letter, visible at `GET /admin/notifications`, requeue with `POST .../retry`).
A 30 s reconcile sweep re-arms rows lost to a crash or Redis flush. Delivery is at-least-once; a stable `Message-ID` lets
mail servers de-duplicate. Reminders are re-checked at send time so a cancelled appointment is never reminded.
Emails contain no clinical content.

**4/5. LLM quality and failure handling.** Prompts are versioned (`prompts.ts`), grounded ("only facts inside `<data>`"),
schema-constrained, and treat input as untrusted (prompt-injection guard). Only clinically needed fields are sent (no
name/email/ids). Output is parsed and validated with zod; the post-visit output is also checked so the model can't invent a
drug the doctor didn't prescribe. On timeout, 5xx, bad JSON, schema violation or invented drug the system stores a
deterministic `FALLBACK` summary and rethrows so the queue retries; a later success upgrades it. Summaries never block
booking. The patient sees the visit summary only after the doctor approves (and can edit) it.

**6/7/8. Schema, API, architecture.** See `sql/001_init.sql`. Services are plain functions taking a pool and injected
integrations (`Llm`, `Mailer`, `CalendarClient`, `Jobs`), which is why every failure mode above is unit-testable.

## API
| | |
|---|---|
| `POST /auth/register`, `POST /auth/login` | patient sign-up, JWT login (throttled) |
| `POST /admin/doctors` | ADMIN creates a doctor with working hours |
| `GET /doctors`, `GET /doctors/:id/slots?date=YYYY-MM-DD` | browse, available slots |
| `POST /appointments` | book directly (409 `SLOT_ALREADY_BOOKED`, `DOCTOR_ON_LEAVE`, `PATIENT_TIME_CONFLICT`; 422 `INVALID_SLOT`, `SLOT_IN_PAST`) |
| `POST /appointments/hold`, `POST /appointments/:id/confirm` | 5-minute hold, then confirm |
| `GET /appointments`, `DELETE /appointments/:id` | role-scoped list, cancel |
| `POST /appointments/:id/complete` | DOCTOR: notes + prescriptions (creates medication reminders) |
| `GET /appointments/:id/summaries`, `POST /summaries/:id/approve` | pre/post-visit summaries, doctor approval |
| `POST/GET/DELETE /doctors/me/leaves` | DOCTOR leave management |
| `GET /admin/notifications`, `POST /admin/notifications/:id/retry` | dead-letter inspection |

## Known limits
- **Prisma:** its engine binaries could not be downloaded in the sandbox where this was built, so the data layer uses
  `pg` with plain SQL (which also suits the exclusion constraints and `FOR UPDATE` locking). To get a Prisma schema locally:
  run the migration, then `npx prisma db pull`.
- **Client:** the React/Vite/Tailwind portals are not included in this delivery.
- Google Calendar and OpenAI integrations are unit-tested with fakes; they were not exercised against the live services.
- Login throttling is in-memory (use Redis if you run several API instances). Not a HIPAA-compliance claim: add
  encryption at rest, audit logging and retention policy before real patient data.
