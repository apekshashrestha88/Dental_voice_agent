# Bright Smile Dental — AI Voice Agent

An AI-powered inbound/outbound voice receptionist for a dental clinic, built with
[Vapi](https://vapi.ai/), Express, and Twilio. Patients can book, reschedule, and
cancel appointments through natural voice conversation, with automatic escalation to
human staff when needed. Includes an admin dashboard for staff to view appointments
and trigger outbound reminder calls.

---

## Features

- **Inbound calls** — patients call in to schedule, reschedule, or cancel appointments
- **Outbound calls** — staff can trigger reminder calls to patients from the admin dashboard
- **Bulk reminders** — one-click to call all patients with appointments today
- **Live escalation** — calls are transferred to a human staff member when a patient
  asks for one, describes an emergency, or the assistant can't resolve the request
- **Admin dashboard** — view all appointments, filter by status, trigger outbound calls
- **Admin API key auth** — admin endpoints protected with a secret key; Vapi tool endpoints left open
- **Natural conversation handling** — letter-by-letter name spelling, natural date/time
  read-back, slot availability checking, dentist assignment and switching

---

## Tech Stack

| Layer              | Technology                                                        |
|--------------------|-------------------------------------------------------------------|
| Voice AI platform  | [Vapi](https://vapi.ai/)                                          |
| Telephony provider | Twilio (connected via Vapi)                                       |
| Main backend       | Node.js + Express (port 3000)                                     |
| Twilio bridge      | Node.js + Express (port 5000) — optional, handles Twilio webhooks |
| Data storage       | SQLite (`dental.db`) via `better-sqlite3`                         |
| Rate limiting      | `express-rate-limit` — per-route, IP-aware via trust proxy        |
| Admin dashboard    | Static HTML/CSS/JS (no framework)                                 |
| Local tunnel       | ngrok (exposes backend to Vapi for tool calls)                    |

---

## Project Structure

```
Internship/
├── backend/                   # ◀ MAIN SERVICE (port 3000) — start this first
│   ├── server.js              # All booking, availability, outbound call,
│   │                          #   Vapi webhook, and date-injection endpoints
│   ├── db.js                  # Opens dental.db, runs schema migrations, seeds dentists
│   ├── dental.db              # SQLite database (WAL mode) — appointments + dentists
│   ├── .env                   # Secret credentials — never committed (see Setup)
│   ├── .env.example           # Template showing required variables
│   └── package.json
│
├── twilio-bridge/             # OPTIONAL SERVICE (port 5000)
│   ├── server.js              # Twilio-specific webhook routing
│   ├── routes/                # Twilio route handlers
│   ├── .env                   # Twilio credentials — never committed
│   ├── .env.example           # Template showing required variables
│   └── package.json
│
├── frontend/
│   └── index.html             # Admin dashboard — self-contained, no build step
│
├── tests/
│   └── api-test.js            # Automated API test suite
│
├── vapi-config/
│   ├── assistant.json         # Vapi assistant configuration + system prompt
│   └── tools.json             # All 4 Vapi tool definitions
│
├── docs/
│   ├── conversation-flows.md  # Flow diagrams for all call types
│   ├── api-design.md          # Full API specification
│   ├── test-transcripts.md    # Real call transcripts + testing report
│   ├── recordings/            # Audio recordings of real calls
│   └── screenshots/           # Outbound call evidence screenshots
│
├── .gitignore
└── README.md
```

> **Two servers explained:**
> - `backend/` (port 3000) is the **main service**. It handles all appointment logic,
>   Vapi tool calls, outbound calls, and date injection. This is the only server Vapi
>   communicates with and the only one you must run.
> - `twilio-bridge/` (port 5000) handles raw Twilio webhook events (status callbacks,
>   etc.) separately, keeping Twilio-specific concerns out of the main booking logic.
>   It is **optional** — the core voice agent works without it.

---

## Setup

### Prerequisites
- Node.js 18+
- A [Vapi](https://vapi.ai/) account with an assistant created
- A Twilio account connected to Vapi (trial accounts work, with caveats — see
  [Known Limitations](#known-limitations))
- [ngrok](https://ngrok.com/) (or any tunneling tool) for exposing your local backend
  to Vapi

---

### 1. Clone and install

```bash
git clone <this-repo-url>
cd Internship

# Install main backend dependencies
cd backend && npm install

# Includes: express, better-sqlite3, express-rate-limit, uuid, dotenv

# Optional: install Twilio bridge dependencies
cd ../twilio-bridge && npm install
```

---

### 2. Configure environment variables

**Main backend** — create `backend/.env` (copy from `backend/.env.example`):
```
VAPI_API_KEY=your-vapi-private-key-here
ASSISTANT_ID=your-assistant-id-here
PHONE_NUMBER_ID=your-phone-number-id-here
ADMIN_API_KEY=your-generated-admin-key-here
```

Get your Vapi key from **Vapi Dashboard → Settings → API Keys**.
Get Assistant ID and Phone Number ID from **Vapi Dashboard → Assistants / Phone Numbers**.

Generate the `ADMIN_API_KEY` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
This key protects all admin endpoints (`/api/appointments`, `/api/dentists`,
`/api/outbound-call`, etc.). Keep it secret — paste it into the dashboard's
**Admin Key** field when you open it.

**Twilio bridge (optional)** — create `twilio-bridge/.env` (copy from `twilio-bridge/.env.example`):
```
PORT=5000
FRONTEND_URL=http://localhost:5173
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx
TWILIO_APP_SID=APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SUPPORT_PHONE_NUMBER=+977xxxxxxxxxx
BACKUP_PHONE_NUMBER=+977xxxxxxxxxx
```
Get these from **Twilio Console → Account Info** and **API Keys & Tokens**.

---

### 3. Start the main backend

```bash
cd backend
node server.js
```

Should print:
```
🦷 Bright Smile Dental Backend running on http://localhost:3000
🌐 Ngrok: https://eve-brainlike-yoshie.ngrok-free.dev
```

---

### 4. (Optional) Start the Twilio bridge

Only needed if you are handling raw Twilio webhook events separately:

```bash
cd twilio-bridge
node server.js
```

Should print:
```
✅ Twilio backend running on http://localhost:5000
```

---

### 5. Expose the main backend with ngrok

```bash
ngrok http 3000
```

Copy the generated `https://....ngrok-free.dev` URL. All Vapi tool calls and the
server webhook point here — **only port 3000 needs to be exposed**.

---

### 6. Configure Vapi

In your assistant's settings (**Vapi Dashboard → Assistant → Advanced**):
- Set **Server URL** to `https://<your-ngrok-url>/api/vapi-system`
- In **Tools**, attach `checkAvailability`, `bookAppointment`, `updateAppointment`,
  and `transfer_call_tool`, each pointing to the corresponding endpoint under
  `https://<your-ngrok-url>/api/...`
  (see [`docs/api-design.md`](docs/api-design.md) for exact paths)
- The full system prompt is in [`vapi-config/assistant.json`](vapi-config/assistant.json)

---

### 7. Run the admin dashboard

Open `frontend/index.html` directly in your browser — no build step or server needed.

In the dashboard's config bar:
- **Backend URL** — enter `http://localhost:3000`
- **Admin Key** — paste your `ADMIN_API_KEY` value

Click **Connect**. The key is session-only and clears when you close the tab.

---

### 8. Run the API test suite

Make sure the backend is running on port 3000, then:

```bash
cd tests
ADMIN_API_KEY=your-admin-api-key node api-test.js
```

The suite runs 27 tests covering all endpoints, automatically cleans up leftover
test appointments before starting, and uses far-future dates (2030–2035) so it
can be run repeatedly without conflicts.

---

### 9. Test the voice agent

- **Inbound:** call your Vapi phone number, or use the **Talk** button in the Vapi dashboard
- **Outbound (single):** click **Call** on any confirmed appointment in the admin dashboard
- **Outbound (bulk reminders):** click **Send Reminders** to call all patients with appointments today

---

## API Endpoints

All endpoints are on the main backend (`http://localhost:3000`).

| Method | Endpoint                          | Auth       | Rate limit        | Description                               |
|--------|-----------------------------------|------------|-------------------|-------------------------------------------|
| GET    | `/`                               | Public     | —                 | Health check + endpoint list              |
| POST   | `/api/check-availability`         | Public     | 60 req/IP/min     | Check open slots for a date               |
| POST   | `/api/book-appointment`           | Public     | 60 req/IP/min     | Book a new appointment                    |
| POST   | `/api/update-appointment`         | Public     | 60 req/IP/min     | Reschedule, cancel, or change dentist     |
| POST   | `/api/vapi-system`                | Public     | 60 req/IP/min     | Vapi webhook — date injection + call logs |
| GET    | `/api/dentists`                   | Admin key  | 100 req/IP/15 min | List all dentists                         |
| GET    | `/api/dentists/available?date=`   | Admin key  | 100 req/IP/15 min | Dentists available on a specific date     |
| GET    | `/api/appointments`               | Admin key  | 100 req/IP/15 min | All appointments (admin dashboard)        |
| GET    | `/api/appointments/ref/:ref`      | Admin key  | 100 req/IP/15 min | Look up appointment by booking ref        |
| POST   | `/api/outbound-call`              | Admin key  | 100 req/IP/15 min | Trigger a single outbound call            |
| POST   | `/api/send-reminders`             | Admin key  | 100 req/IP/15 min | Call all patients with appointments today |

Public endpoints are intentionally open — Vapi calls them directly during live calls
and cannot send custom auth headers. They are rate-limited to 60 requests/IP/minute,
which is well above what any real call requires (3–4 tool calls per call) but blocks
programmatic abuse. Admin endpoints require `x-api-key: <ADMIN_API_KEY>` in the
request header. Exceeded limits return HTTP `429`.

See [`docs/api-design.md`](docs/api-design.md) for full request/response specs.

---

## Known Limitations

This project's Twilio account is on the **trial tier**, which imposes two restrictions
relevant to testing:

1. **Verified Caller ID required for outbound calls.** Trial accounts can only place
   calls to destination numbers that have been explicitly verified in the Twilio Console.
2. **SMS verification is blocked for some countries** (including Nepal, the number
   used for testing in this project), and **voice-based verification is disabled
   entirely on trial accounts**, regardless of country.

As a result, outbound calls may fail with a `Call.start.error` at the Twilio layer,
even though the full application stack — dashboard, backend, and Vapi API integration —
is confirmed working correctly up to that point. See
[`docs/test-transcripts.md`](docs/test-transcripts.md) for full evidence, including
screenshots showing the failure occurs at the telephony/account layer, not in the
application code.

**On a paid Twilio account, or with a pre-verified destination number, this flow
completes successfully with no code changes required.**

---

## Known Constraints (Data Layer)

`dental.db` is a local SQLite database managed by `better-sqlite3`, running in WAL
mode so reads and writes don't block each other and all operations are atomic at the
SQLite level. For a single-clinic POC this is more than sufficient. A production
deployment would replace this with a hosted database (e.g. PostgreSQL) for
multi-instance scalability and managed backups.

---

## Documentation

- [`docs/conversation-flows.md`](docs/conversation-flows.md) — flow diagrams for all call types
- [`docs/api-design.md`](docs/api-design.md) — full API specification
- [`docs/test-transcripts.md`](docs/test-transcripts.md) — real call transcripts and testing report
- [`docs/recordings/`](docs/recordings/) — audio recordings of real inbound calls
- [`docs/screenshots/`](docs/screenshots/) — outbound call evidence screenshots
- [`vapi-config/assistant.json`](vapi-config/assistant.json) — full assistant configuration and system prompt
- [`vapi-config/tools.json`](vapi-config/tools.json) — all 4 Vapi tool definitions