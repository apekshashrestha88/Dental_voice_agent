# Conversation Flow Design — Bright Smile Dental Voice Agent

This document describes the conversational logic for all supported use cases, as implemented in the Vapi assistant's system prompt.

---

## 1. Appointment Scheduling (New Booking)

```
[Assistant greets caller]
        │
        ▼
[Collect 4 details in one pass]
  - Full name
  - Phone number
  - Preferred date & time
  - Reason for visit
        │
        ▼
[Confirm details back to patient]
  "Just to confirm — [name], [phone], [date] at [time]
   for [reason]. Is that correct?"
        │
   ┌────┴────┐
   ▼         ▼
 Wrong     Correct
   │         │
   ▼         ▼
[Re-collect] [Call checkAvailability]
                  │
             ┌────┴────┐
             ▼         ▼
         Available   Not available
             │         │
             ▼         ▼
       [Call          [List alternative
        bookAppointment]  slots, ask patient
             │            to choose]
             ▼                │
       [Confirm booking,      └──► back to
        give bookingRef]          checkAvailability
             │
             ▼
       [Ask: "Anything else?"]
```

**Key rules:**
- All 4 details must be collected before moving to confirmation — no partial bookings.
- `checkAvailability` is always called silently (no "let me check" filler) immediately after confirmation.
- The assistant never confirms a slot or dentist is available without a tool response saying so.
- Dates/times/phone numbers are always spoken in natural format, never read as raw ISO strings or digit strings.

---

## 2. Appointment Rescheduling

```
[Patient requests reschedule]
        │
        ▼
[Ask for 4-digit booking reference]
        │
        ▼
[Ask for new preferred date/time]
        │
        ▼
[Call checkAvailability for new slot]
        │
   ┌────┴────┐
   ▼         ▼
Available   Not available
   │         │
   ▼         ▼
[Call updateAppointment   [Offer alternatives,
 action="reschedule"]      retry checkAvailability]
   │
   ▼
[Confirm new date/time,
 same bookingRef retained]
```

---

## 3. Appointment Cancellation

```
[Patient requests cancellation]
        │
        ▼
[Ask for 4-digit booking reference]
        │
        ▼
[Confirm: "I found your appointment on
 [date] at [time]. Shall I cancel it?"]
        │
   ┌────┴────┐
   ▼         ▼
  Yes        No
   │         │
   ▼         ▼
[Call         [End or
 updateAppointment    redirect]
 action="cancel"]
   │
   ▼
[Confirm cancellation]
```

---

## 4. Dentist Change (Secondary Flow)

```
[Patient asks to change assigned dentist]
        │
        ▼
[Ask for booking reference + preferred dentist]
        │
        ▼
[Call updateAppointment
 action="changeDentist"]
        │
   ┌────┴────┐
   ▼         ▼
Dentist available    Dentist not available
on appt day          that day
   │                       │
   ▼                       ▼
[Confirm change]    [Inform patient, suggest
                      who IS available]
```

Note: this never triggers escalation — it's treated as a routine request.

---

## 5. Escalation / Human Transfer

```
[Trigger conditions met — ANY of:]
  - Patient explicitly asks for a human
  - True emergency (knocked-out tooth, broken jaw,
    facial swelling blocking breathing, severe
    uncontrollable bleeding)
  - Assistant fails to understand patient after
    3 attempts
  - Patient asks about billing, insurance,
    or medical records
        │
        ▼
[Assistant says: "Let me transfer you to our
 staff who can better assist you."]
        │
        ▼
[transferCall tool invoked → call bridged
 to staff number]
```

**Explicit exclusions:** routine tooth pain, wisdom tooth pain, or any common dental complaint does NOT trigger escalation — the assistant books a normal appointment instead.

---

## 6. Outbound Reminder Calls (Admin-Triggered)

```
[Staff clicks "Call" on an appointment
 in the admin dashboard]
        │
        ▼
[Dashboard sends POST /api/outbound-call
 with patientPhone, patientName, reason]
        │
        ▼
[Backend calls Vapi API to place
 outbound call to patient]
        │
        ▼
[Same Dental Assistant handles the
 conversation as it would inbound]
```