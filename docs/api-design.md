# API Design — Bright Smile Dental Voice Agent Backend

Base URL (local dev): `http://localhost:3000`
Exposed publicly via ngrok for Vapi tool calls: `https://eve-brainlike-yoshie.ngrok-free.dev`

All endpoints accept and return JSON. All POST endpoints are called directly by Vapi as tool functions during a live call, except `/api/outbound-call` and `/api/send-reminders`, which are triggered manually from the admin dashboard.

---

## Rate Limiting

All endpoints are rate-limited per IP address. Requests that exceed the limit receive
HTTP `429` with `{ "success": false, "message": "Too many requests..." }`.

| Endpoint class  | Limit                  | Rationale                                                      |
|-----------------|------------------------|----------------------------------------------------------------|
| Public (Vapi)   | 60 requests / IP / min | Loose enough for real calls (3–4 tool calls each), tight enough to block abuse |
| Admin           | 100 requests / IP / 15 min | Caps cost exposure from outbound calls; slows brute-force on the API key |

Rate limits use the real caller IP, not the ngrok proxy IP (`app.set("trust proxy", 1)`
is set in `server.js` to ensure this).

---

## 1. `POST /api/check-availability`

Checks open appointment slots for a given date, optionally filtered by dentist.

**Called by:** Vapi tool `checkAvailability`, during booking and rescheduling flows.

**Input sanitization:** all string fields are trimmed and capped before hitting the database (`patientName` ≤ 100 chars, `reason` ≤ 300 chars, `phone` ≤ 30 chars, date/time fields ≤ 20 chars). Malformed or overlong values are silently truncated, not rejected, to avoid breaking Vapi mid-call.

**Request body:**
```json
{
  "date": "2026-06-22",
  "dentist": "Dr. Priya Sharma"
}
```
| Field   | Type   | Required | Notes                                  |
|---------|--------|----------|-----------------------------------------|
| date    | string | Yes      | Format YYYY-MM-DD                       |
| dentist | string | No       | Optional preferred dentist name         |

**Response:**
```json
{
  "success": true,
  "available": true,
  "availableSlots": ["10:00 AM", "2:30 PM", "4:00 PM"],
  "availableDentists": ["Dr. Priya Sharma"]
}
```

---

## 2. `POST /api/book-appointment`

Creates a new appointment after availability has been confirmed.

**Called by:** Vapi tool `bookAppointment`.

**Request body:**
```json
{
  "patientName": "Apeksha Karki",
  "phone": "+9779807352405",
  "date": "2026-06-22",
  "time": "10:00 AM",
  "reason": "Routine cleaning",
  "dentist": "Dr. Priya Sharma"
}
```
| Field       | Type   | Required | Notes                          |
|-------------|--------|----------|---------------------------------|
| patientName | string | Yes      |                                  |
| phone       | string | Yes      |                                  |
| date        | string | Yes      | YYYY-MM-DD                      |
| time        | string | Yes      |                                  |
| reason      | string | Yes      |                                  |
| dentist     | string | No       | Defaults to "Any available"     |

**Response:**
```json
{
  "success": true,
  "bookingRef": "4821",
  "message": "Appointment confirmed"
}
```

---

## 3. `POST /api/update-appointment`

Handles rescheduling, cancellation, and dentist changes for an existing appointment.

**Called by:** Vapi tool `updateAppointment`.

**Request body:**
```json
{
  "action": "reschedule",
  "bookingRef": "4821",
  "newDate": "2026-06-25",
  "newTime": "3:00 PM",
  "newDentist": "Dr. Rohan Mehta"
}
```
| Field      | Type   | Required | Notes                                            |
|------------|--------|----------|---------------------------------------------------|
| action     | enum   | Yes      | `"reschedule"` \| `"cancel"` \| `"changeDentist"`  |
| bookingRef | string | Yes      | 4-digit reference                                  |
| newDate    | string | Conditional | Required for reschedule                       |
| newTime    | string | Conditional | Required for reschedule                       |
| newDentist | string | Conditional | Required for changeDentist                    |

**Response:**
```json
{
  "success": true,
  "message": "Appointment updated",
  "appointment": { "...": "updated appointment object" }
}
```

---

## 4. `POST /api/outbound-call`

Triggers an outbound call from the assistant to a patient. Used by the admin dashboard's "Call" button, not by Vapi during a live call.

**Request body:**
```json
{
  "patientPhone": "+9779807352405",
  "patientName": "Apeksha Karki",
  "reason": "Reminder about your appointment tomorrow at 10:00 AM"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Calling +9779807352405...",
  "call": { "...": "Vapi call object" }
}
```

**Errors:**
```json
{
  "success": false,
  "message": "patientPhone is required."
}
```

---

## 5. `GET /api/appointments`

Returns all appointments for the admin dashboard.

**Called by:** Admin dashboard frontend (`frontend/index.html`).

**Response:**
```json
{
  "success": true,
  "appointments": [
    {
      "id": "abc123",
      "patientName": "Apeksha Karki",
      "phone": "+9779807352405",
      "date": "2026-06-22",
      "time": "10:00 AM",
      "dentist": "Dr. Priya Sharma",
      "reason": "Routine cleaning",
      "bookingRef": "4821",
      "status": "confirmed",
      "rescheduledAt": null
    }
  ]
}
```

---

## Escalation (Out-of-Band)

Escalation to a human is **not** handled via this backend — it's a native Vapi `transferCall` tool configured directly on the assistant in the Vapi dashboard, which bridges the live call to a staff phone number (`+9779807352405`) without going through this API. See `conversation-flows.md` section 5 for the trigger logic.

---

## Error Handling Convention

All endpoints follow the same shape on failure:
```json
{
  "success": false,
  "message": "Human-readable error description",
  "error": "optional, raw error object for debugging"
}
```

| HTTP status | Meaning                                              |
|-------------|------------------------------------------------------|
| 400         | Missing or invalid request fields                    |
| 401         | Missing or incorrect `x-api-key` (admin routes only) |
| 404         | Booking reference not found                          |
| 409         | Slot already booked / dentist unavailable that day   |
| 429         | Rate limit exceeded — retry after the window resets  |
| 500         | Internal server error                                |