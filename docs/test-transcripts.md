# Testing Report — Bright Smile Dental Voice Agent

This document contains sample call transcripts and logs demonstrating each supported flow, captured from real Vapi calls.

---

## 1. Scenario: New Appointment Booking (+ Dentist Change)

**Test method:** Vapi Test button / inbound call
**Date tested:** 2026-06-17
**Outcome:** ✅ Pass

**Transcript:**
```
Assistant: Hello. Thank you for calling Bright Smile Dental Clinic. I'm your virtual
receptionist. I can help you schedule, reschedule, or cancel an appointment.
How can I help you today?

User: Hello. I want to book an appointment.

Assistant: I'd be happy to help you book an appointment. May I please have your full
name, phone number, preferred date and time, and the reason for your visit?
If you have a dentist preference, let me know. Otherwise, we'll assign you
the first available dentist.

User: So my name is, uh, Shreya, and my number is nine eight zero seven three
five two four zero five. I would like to come visit tomorrow at ten AM,
and I don't really have a preference.

Assistant: Thank you. Just to confirm, name Shreya. Phone, nine eight zero seven three
five two four zero five. Date tomorrow. Time, ten AM reason. Is there a
specific reason for your visit you'd like to mention? For example, cleaning,
tooth pain, checkup, etcetera. Once you let me know, I'll confirm and proceed.

User: It's just for routine checkup.

Assistant: Just to confirm, Shreya, nine eight zero seven three five two four zero
five. Tomorrow at ten AM for routine checkup. Is that correct?

User: Is correct.

[Tool call: CheckAvailability — Completed successfully]

Assistant: Great. That slot is available. You're all set, Shreya. Your appointment is
confirmed for tomorrow, June eighteenth at ten AM. Your booking reference is
nine four eight seven. Please save this four digit number for rescheduling
or cancellation. We'll see you then. Is there anything else I can help you with?

[Tool call: BookAppointment — Completed successfully]

User: Want to know which doctor am I assigned to?

Assistant: You are assigned to Doctor Priya Sharma for your appointment tomorrow at
ten AM. If you'd like to change your dentist, just let me know.

User: I would like to change.

Assistant: No problem. Could you please share which dentist you'd like to switch to?
Here are your options for tomorrow, Thursday: Doctor Priya Sharma, general
dentist; Doctor Anita Rai, pediatric dentist; Doctor Rohan Mehta, cosmetic
dentist; Doctor Kavya Nair, endodontist. Also, please confirm your four
digit booking reference for the change.

User: So I would like to go with Doctor Rohan Mehta.

Assistant: Thank you. Could you please confirm your four digit booking reference so
I can process the change to Doctor Rohan Mehta for you?

User: Yeah, sure. My reference is nine four... let me see. Nine four eight seven.

Assistant: Done. Your appointment tomorrow at ten AM has been updated to Doctor Rohan
Mehta. Your booking reference remains nine four eight seven. Is there
anything else I can help you with?

[Tool call: UpdateAppointment (action: changeDentist) — Completed successfully]

User: Now that'll be all. Thank you.

Assistant: You're welcome, Shreya. Your appointment is all set. We look forward to
seeing you tomorrow at ten AM with Doctor Rohan Mehta. Have a great day.

[Customer ended the call]
```

**Backend confirmation:**
- `checkAvailability` called, returned slot available
- `bookAppointment` called, booking reference issued: `9487`
- Mid-call follow-up: `updateAppointment` called with `action: "changeDentist"`, `newDentist: "Dr. Rohan Mehta"` — also succeeded
- Appointment confirmed in `dental.db`: Yes

**Notes:** Demonstrates both the core booking flow and a same-call dentist-change request handled correctly without triggering escalation, per the "never escalate just because a patient wants to change doctors" rule.

---

## 2. Scenario: Appointment Rescheduling

**Test method:** Vapi Test button / inbound call
**Date tested:** 2026-06-21
**Outcome:** ✅ Pass (with a minor prompt-adherence issue noted below)

**Transcript:**
```
Assistant: Hello. Thank you for calling Bright Smile Dental Clinic. I'm your virtual
receptionist. I can help you schedule, reschedule, or cancel an appointment.
How can I help you today?

User: Hello. I wanted to reschedule my appointment.

Assistant: Of course, could you please share your four digit booking reference?

User: My... the digits are six five five four.

Assistant: Thank you. What new date and time would you prefer?

User: Instead of tomorrow, I want to book, uh, the appointment for the day
after tomorrow.

Assistant: Sure, that would be two zero two six dash zero six dash two three.
What time would you prefer?

User: Nine AM.

[Tool call: CheckAvailability — Completed successfully]
[Tool call: UpdateAppointment (action: reschedule) — Completed successfully]

Assistant: Done. Your appointment has been moved to Tuesday, June twenty third
twenty twenty six at nine AM. Your booking reference remains sixty five
fifty four.

User: Thank you.

Assistant: You're welcome. Is there anything else I can help you with?

User: No. No need.

Assistant: Alright. Have a great day.

[Customer ended the call]
```

**Backend confirmation:**
- Original booking reference: `6554`
- `checkAvailability` called for new slot (2026-06-23, 9:00 AM): succeeded
- `updateAppointment` called with `action: "reschedule"`: succeeded
- New date/time confirmed: Tuesday, June 23, 2026 at 9:00 AM, booking reference retained

**Notes:** Functionally correct end-to-end, but a minor prompt-adherence bug was observed:
when confirming the resolved date back to the patient mid-call, the assistant read it
as a raw ISO string ("two zero two six dash zero six dash two three") instead of
natural speech, briefly violating the "Never read ISO dates aloud" rule in the system
prompt. It self-corrected in the final confirmation ("Tuesday, June twenty third twenty
twenty six"). Worth tightening the prompt to explicitly cover this intermediate
"let me confirm the date before asking for time" moment, not just the final confirmation.

---

## 3. Scenario: Appointment Cancellation

**Test method:** Vapi Test button / inbound call
**Date tested:** 2026-06-17
**Outcome:** ✅ Pass

**Transcript:**
```
Assistant: Hello? Thank you for calling Bright Smile Dental Clinic. I'm your virtual
receptionist. I can help you schedule, reschedule, or cancel an appointment.
How could I help you today?

User: Hello. So I wanted to cancel my appointment.

Assistant: Could you please share your four digit booking reference?

User: Uh, my digit reference was nine five one eight.

[Tool call: UpdateAppointment (action: cancel) — Completed successfully]

Assistant: Your appointment has been canceled. We hope to see you again soon. Is
there anything else I can help you with?

User: No.

Assistant: Thank you for calling Bright Smile Dental Clinic. Have a wonderful day.

[Customer ended the call]
```

**Backend confirmation:**
- Booking reference: `9518`
- `updateAppointment` called with `action: "cancel"`: succeeded
- Status updated to `cancelled` in `dental.db+`: Yes

**Notes:** Clean, efficient flow — patient gave booking reference directly, no clarification needed.

---

## 4. Scenario: Escalation to Human Staff

**Test method:** Inbound call to Vapi number
**Outcome:** ✅ Pass (both cases)

### Case A — Explicit request for human

**Date tested:** 2026-06-19

**Transcript:**
```
Assistant: Hello. Thank you for calling Bright Smile Dental Clinic. I'm your virtual
receptionist. I can help you schedule, reschedule, or cancel an appointment.
How can I help you today?

User: Can I speak to a human, please?

[Tool call: TransferCall — Completed successfully]

Assistant: Connecting now.

[assistant-forwarded-call]
```

**Backend confirmation:**
- Trigger condition: explicit request for human
- `transfer_call_tool` invoked: Yes
- Transfer connected to staff number successfully: Yes

### Case B — Dental emergency

**Date tested:** 2026-06-19

**Transcript:**
```
Assistant: Hello. Thank you for calling Bright Smile Dental Clinic. I'm your virtual
receptionist. I can help you schedule, reschedule, or cancel an appointment.
How can I help you today?

User: Hello. I have broken my jaw.

[Tool call: TransferCall — Completed successfully]

Assistant: Transferring the call

[assistant-forwarded-call]
```

**Backend confirmation:**
- Trigger condition: described emergency (broken jaw)
- `transfer_call_tool` invoked: Yes
- Transfer connected to staff number successfully: Yes
- Correctly distinguished from routine complaints — assistant did not attempt to book
  an appointment instead, per the "true emergency" escalation rule

**Notes / known constraints encountered during development:**
> Earlier test attempts surfaced two telephony-layer issues unrelated to the assistant's
> logic: (1) Twilio trial-account restrictions required verifying the destination number
> before outbound transfer calls would connect, and (2) the testing phone's carrier
> intermittently blocked international call attempts during high-frequency testing. Both
> were infrastructure/account-level constraints rather than agent or backend bugs, and
> were resolved by [verifying the Twilio Caller ID / upgrading the Twilio account —
> update to whichever you ultimately did].

---

## 5. Scenario: Outbound Reminder Call (Admin Dashboard)

**Test method:** Triggered via admin dashboard "Call" button → `POST /api/outbound-call`
**Date tested:** 2026-06-21
**Outcome:** ⚠️ Partial — implementation verified working up to the telephony layer; live
call blocked by a Twilio account-tier restriction (not an application defect).

**What was confirmed working:**
1. Dashboard "Call" button correctly triggers `POST /api/outbound-call` (confirmed via
   browser DevTools Network tab — successful CORS preflight, 200 response from backend)
2. Backend correctly receives the request and logs it (`📞 Outbound call triggered to
   +9779807352405 (Jasmine)`)
3. Backend successfully calls the Vapi API (`https://api.vapi.ai/call`) with the correct
   assistant ID, phone number ID, and customer details
4. Vapi accepts the request and creates the outbound call object — confirmed in the
   Vapi dashboard call log:

   ```
   Type:     outboundPhoneCall
   Customer: Jasmine • +977 (980) 7352405
   Assistant Phone Number: +1 (256) 871 3120
   Ended Reason: Call.start.error get transport
   Call ID: 019eea11-e58...
   ```

**Root cause:** the project's Twilio account is on the trial tier, which restricts
outbound calls to destination numbers that have been explicitly verified in the Twilio
Console. The test destination number could not be successfully verified — SMS-based
verification did not deliver, and voice-based verification was blocked by Twilio
("calling is not allowed" for this number/region), independent of any code in this
project. Multiple outbound attempts (6+) all failed at the identical point with the
identical Twilio-level error, confirming this is a consistent infrastructure
restriction rather than an intermittent bug.

**Why this doesn't affect the implementation's correctness:** the entire application
layer — dashboard trigger, backend endpoint, Vapi API integration, request payload — is
confirmed working end-to-end. The failure occurs strictly at the carrier/account layer,
after the application has done everything correctly. On a paid Twilio account (or with
any pre-verified destination number), this flow would complete successfully with no
code changes required.

**Note:** This is distinct from the call-transfer/escalation flow above, which uses
Twilio's SIP REFER-based transfer (redirecting an already-active call) rather than
originating a brand-new outbound call leg — which is why escalation transfers succeeded
while this fresh outbound call did not, under the same trial account.

---

## Summary

| Flow                  | Status     | Notes |
|------------------------|-----------|-------|
| New booking             | ✅ Pass    | Includes mid-call dentist change |
| Reschedule               | ✅ Pass    | Minor ISO-date-readback bug noted, self-corrected |
| Cancellation             | ✅ Pass    | |
| Escalation/transfer      | ✅ Pass    | 2 cases: explicit request + emergency |
| Outbound reminder call   | ⚠️ Partial | App layer confirmed working; blocked by Twilio trial-account verification limit |

---

## Supplementary Evidence

In addition to the text transcripts above, **audio recordings** of the booking,
rescheduling, and cancellation calls were captured and are included in this submission
(see `/docs/recordings` or `/tests` folder in the repository) as further evidence of natural,
end-to-end voice interaction quality beyond what a text transcript alone can convey.