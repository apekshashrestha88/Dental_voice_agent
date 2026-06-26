/**
 * server.js — Bright Smile Dental Voice Agent — Main Backend
 *
 * MIGRATED FROM: better-sqlite3 (local dental.db) → Supabase (hosted Postgres)
 * MIGRATED FOR: Vercel serverless deployment (no app.listen — see api/index.js)
 *
 * All route logic is unchanged from the original. The only differences are:
 *   - DB calls go through queries.js (Supabase) and are now async/await
 *   - app.listen() removed; this file exports the Express app instance
 *
 * FIX (2026-06): Time format mismatch resolved. SLOTS uses 12-hour format
 *   ("02:00 PM") but Vapi was sending 24-hour ("14:00"). Added to12Hour()
 *   utility and applied it in all booking/rescheduling paths so the DB
 *   always stores 12-hour times — matching the SLOTS array for correct
 *   availability filtering.
 *
 * Local dev: you can still run this directly with `node server.js` —
 * see the bottom of this file for the dev-only listen guard.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");

const queries = require("./queries");

const app = express();

// ─── Trust proxy — needed for correct IP detection behind Vercel/ngrok ───────
app.set("trust proxy", 1);

// ─── Clinic slot schedule ─────────────────────────────────────────────────────
const SLOTS = {
  monday: ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM", "04:00 PM", "05:00 PM"],
  tuesday: ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM", "04:00 PM", "05:00 PM"],
  wednesday: ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM", "04:00 PM", "05:00 PM"],
  thursday: ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM", "04:00 PM", "05:00 PM"],
  friday: ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM", "04:00 PM", "05:00 PM"],
  saturday: ["09:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM"],
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  console.log(`\n ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length) console.log("   Body:", JSON.stringify(req.body));
  if (req.query && Object.keys(req.query).length) console.log("   Query:", JSON.stringify(req.query));
  next();
});

// ─── Rate Limiters ────────────────────────────────────────────────────────────
const vapiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests — please try again shortly." },
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests." },
});

// ─── Admin API Key Auth ───────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  next();
}

// ─── Input Sanitization ───────────────────────────────────────────────────────
const LIMITS = {
  patientName: 100,
  phone: 30,
  reason: 300,
  dentist: 100,
  date: 20,
  time: 20,
  bookingRef: 10,
  action: 20,
};

function sanitizeString(value, maxLen) {
  if (value === undefined || value === null) return value;
  return String(value).trim().slice(0, maxLen);
}

function sanitizeBody(raw) {
  return {
    patientName: sanitizeString(raw.patientName, LIMITS.patientName),
    phone: sanitizeString(raw.phone, LIMITS.phone),
    date: sanitizeString(raw.date, LIMITS.date),
    time: sanitizeString(raw.time, LIMITS.time),
    reason: sanitizeString(raw.reason, LIMITS.reason),
    dentist: sanitizeString(raw.dentist, LIMITS.dentist),
    bookingRef: sanitizeString(raw.bookingRef, LIMITS.bookingRef),
    action: sanitizeString(raw.action, LIMITS.action),
    newDate: sanitizeString(raw.newDate, LIMITS.date),
    newTime: sanitizeString(raw.newTime, LIMITS.time),
    newDentist: sanitizeString(raw.newDentist, LIMITS.dentist),
  };
}

// ─── Utility: shape a DB row into the API response shape ─────────────────────
function formatAppointment(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingRef: row.booking_ref,
    patientName: row.patient_name,
    phone: row.phone,
    date: row.date,
    time: row.time,
    reason: row.reason,
    dentist: row.dentist,
    status: row.status,
    createdAt: row.created_at,
    rescheduledAt: row.rescheduled_at || undefined,
    cancelledAt: row.cancelled_at || undefined,
    dentistUpdatedAt: row.dentist_updated_at || undefined,
  };
}

// ─── Utility: generate a unique 4-digit booking reference ────────────────────
async function generateBookingRef() {
  let ref;
  let exists = true;
  do {
    ref = String(Math.floor(1000 + Math.random() * 9000));
    exists = await queries.refExists(ref);
  } while (exists);
  return ref;
}

// ─── Utility: normalize date to YYYY-MM-DD ───────────────────────────────────
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  dateStr = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  if (/^\d{2}-\d{2}-\d{2}$/.test(dateStr)) {
    const [yy, mm, dd] = dateStr.split("-");
    return `20${yy}-${mm}-${dd}`;
  }
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0];
  return dateStr;
}

// ─── Utility: get lowercase day name from a date string ──────────────────────
function getDayName(dateStr) {
  const normalized = normalizeDate(dateStr);
  if (!normalized) return null;
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const date = new Date(normalized + "T00:00:00");
  if (isNaN(date.getTime())) return null;
  return days[date.getDay()];
}

function isClinicOpen(dateStr) {
  const day = getDayName(dateStr);
  return day && day !== "sunday";
}

// ─── Utility: normalize time to 12-hour format to match SLOTS ────────────────
// FIX: Vapi sends times in 24-hour format ("14:00") but SLOTS stores them in
// 12-hour format ("02:00 PM"). This caused checkAvailability to never filter
// out booked slots because the formats never matched. Always call this before
// saving or comparing a time value.
function to12Hour(time) {
  if (!time) return time;
  // Already in 12-hour format — pass through unchanged
  if (/AM|PM/i.test(time)) return time.toUpperCase();
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}

// ─── Utility: normalize phone to E.164 ───────────────────────────────────────
function toE164Nepal(phone) {
  const s = String(phone).trim();
  if (s.startsWith("+")) return s;
  if (s.startsWith("977")) return `+${s}`;
  return `+977${s}`;
}

// ─── Utility: build date variables for Vapi prompt injection ─────────────────
// FIX: Use Nepal timezone (UTC+5:45) so "today" and "tomorrow" are correct
// for the clinic's local time, not Vercel's UTC server time.
function getDateVariables() {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Get current date/time offset to Nepal timezone (UTC+5:45)
  const nowUtc = new Date();
  const nepalOffsetMs = (5 * 60 + 45) * 60 * 1000;
  const now = new Date(nowUtc.getTime() + nepalOffsetMs);
  const tomorrow = new Date(nowUtc.getTime() + nepalOffsetMs + 24 * 60 * 60 * 1000);

  // Use UTC getters on the offset date to read Nepal local values
  const toISO = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const toNatural = (d) =>
    `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

  return {
    today_date: toNatural(now),
    today_iso: toISO(now),
    tomorrow_day: days[tomorrow.getUTCDay()],
    tomorrow_iso: toISO(tomorrow),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. GET ALL DENTISTS  [admin]
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/dentists", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const dentists = await queries.getAllDentists();
    res.json({ success: true, dentists });
  } catch (err) {
    console.error("GET /api/dentists error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. GET DENTISTS AVAILABLE ON A SPECIFIC DATE  [admin]
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/dentists/available", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: "Date is required." });

    const day = getDayName(date);

    if (day === "sunday") {
      return res.json({ success: true, available: false, message: "The clinic is closed on Sundays.", dentists: [] });
    }

    const dentists = await queries.getDentistsForDay(day);

    res.json({
      success: true,
      date,
      day: day.charAt(0).toUpperCase() + day.slice(1),
      dentists,
      message:
        dentists.length > 0
          ? `${dentists.length} dentists available on ${date}: ${dentists.map((d) => d.name).join(", ")}.`
          : "No dentists available on this date.",
    });
  } catch (err) {
    console.error("GET /api/dentists/available error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. CHECK AVAILABILITY  [public — called by Vapi]
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/check-availability", vapiLimiter, async (req, res) => {
  try {
    const { date, dentist } = sanitizeBody(req.body);

    if (!date) return res.status(400).json({ success: false, message: "Date is required." });

    const normalizedDate = normalizeDate(date);

    if (!isClinicOpen(normalizedDate)) {
      return res.json({
        success: true,
        available: false,
        date: normalizedDate,
        message: "The clinic is closed on Sundays. Please choose Monday to Saturday.",
        availableSlots: [],
      });
    }

    const day = getDayName(normalizedDate);
    const allSlots = SLOTS[day] || [];

    if (dentist && dentist !== "Any available dentist") {
      const dentistRecord = await queries.findDentist(dentist);
      if (dentistRecord && !dentistRecord.availableDays.includes(day)) {
        return res.json({
          success: true,
          available: false,
          date: normalizedDate,
          message: `${dentistRecord.name} is not available on ${day}. Available days: ${dentistRecord.availableDays.join(", ")}.`,
          availableSlots: [],
          suggestion: "Would you like to book with another dentist or choose a different date?",
        });
      }
    }

    // Check if the requested time (if any) even exists in this day's slots
    const { time: rawRequestedTime } = sanitizeBody(req.body);
    const requestedTime = rawRequestedTime ? to12Hour(rawRequestedTime) : null;

    if (requestedTime && !allSlots.includes(requestedTime)) {
      const availableDentistsEarly = (await queries.getDentistsForDay(day)).map((d) => `${d.name} (${d.specialty})`);
      return res.json({
        success: true,
        available: false,
        date: normalizedDate,
        day: day.charAt(0).toUpperCase() + day.slice(1),
        requestedTime,
        requestedDentist: dentist || "Any available dentist",
        availableSlots: allSlots,
        availableDentists: availableDentistsEarly,
        slotStatus: "invalid_time",
        reason: "outside_clinic_hours",
        message: `Sorry, ${requestedTime} is not a valid appointment time. Our Saturday clinic closes at 03:00 PM. Please choose from the available slots: ${allSlots.join(", ")}.`,
      });
    }

    const bookedRows =
      dentist && dentist !== "Any available dentist"
        ? await queries.getBookedSlotsByDentist(normalizedDate, dentist)
        : await queries.getBookedSlots(normalizedDate);

    // bookedRows come from the DB; normalize each stored time to 12-hour so
    // the comparison against SLOTS (which is always 12-hour) is reliable.
    const bookedSet = new Set(bookedRows.map((r) => to12Hour(r.time)));
    const availableSlots = allSlots.filter((s) => !bookedSet.has(s));
    const availableDentists = (await queries.getDentistsForDay(day)).map((d) => `${d.name} (${d.specialty})`);

    return res.json({
      success: true,
      available: availableSlots.length > 0,
      date: normalizedDate,
      day: day.charAt(0).toUpperCase() + day.slice(1),
      requestedDentist: dentist || "Any available dentist",
      availableSlots,
      availableDentists,
      message:
        availableSlots.length > 0
          ? `${availableSlots.length} slots available on ${normalizedDate}.`
          : `No slots available on ${normalizedDate}. Please try another date.`,
    });
  } catch (err) {
    console.error("checkAvailability error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. BOOK APPOINTMENT  [public — called by Vapi]
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/book-appointment", vapiLimiter, async (req, res) => {
  try {
    const { patientName, phone, date, reason, dentist } = sanitizeBody(req.body);
    const normalizedTime = to12Hour(sanitizeBody(req.body).time); // FIX: normalize to 12-hour

    if (!patientName || !phone || !date || !normalizedTime || !reason) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: patientName, phone, date, time, reason.",
      });
    }

    const normalizedDate = normalizeDate(date);

    if (!isClinicOpen(normalizedDate)) {
      return res.status(400).json({ success: false, message: "The clinic is closed on Sundays. Please choose another date." });
    }

    const day = getDayName(normalizedDate);

    const taken =
      dentist && dentist !== "Any available dentist"
        ? await queries.slotTakenForDentist(normalizedDate, normalizedTime, dentist)
        : await queries.slotTaken(normalizedDate, normalizedTime);

    if (taken) {
      return res.status(409).json({
        success: false,
        message: `The ${normalizedTime} slot on ${normalizedDate} is already booked. Please choose a different time.`,
      });
    }

    let assignedDentist = dentist || null;
    if (!dentist || dentist === "Any available dentist") {
      const available = await queries.getDentistsForDay(day);
      assignedDentist = available.length > 0 ? available[0].name : "Any available dentist";
    }

    const bookingRef = await generateBookingRef();
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    await queries.insertAppointment({
      id, bookingRef, patientName, phone: String(phone),
      date: normalizedDate, time: normalizedTime, reason, dentist: assignedDentist, createdAt,
    });

    const newAppointment = formatAppointment(await queries.findByRef(bookingRef));

    console.log(`Booked: ${patientName} on ${normalizedDate} at ${normalizedTime} with ${assignedDentist} | Ref: ${bookingRef}`);

    return res.status(201).json({
      success: true,
      bookingRef,
      assignedDentist,
      message: `Appointment confirmed! ${patientName}, your appointment is booked for ${normalizedDate} at ${normalizedTime} with ${assignedDentist} for ${reason}. Your booking reference is ${bookingRef}.`,
      appointment: newAppointment,
    });
  } catch (err) {
    console.error("bookAppointment error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. UPDATE APPOINTMENT  [public — called by Vapi]
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/update-appointment", vapiLimiter, async (req, res) => {
  try {
    const { bookingRef, action, newDate, newDentist } = sanitizeBody(req.body);
    const normalizedNewTime = to12Hour(sanitizeBody(req.body).newTime); // FIX: normalize to 12-hour

    if (!bookingRef || !action) {
      return res.status(400).json({ success: false, message: "Booking reference and action are required." });
    }

    const appt = await queries.findConfirmed(bookingRef);

    if (!appt) {
      return res.status(404).json({ success: false, message: `No confirmed appointment found for booking reference ${bookingRef}.` });
    }

    const now = new Date().toISOString();

    // ── cancel ────────────────────────────────────────────────────────────────
    if (action === "cancel") {
      await queries.cancelAppointment(bookingRef, now);
      const updated = formatAppointment(await queries.findByRef(bookingRef));
      console.log(`Cancelled: ${appt.patient_name} | Ref: ${bookingRef}`);
      return res.json({
        success: true,
        message: `Done! ${appt.patient_name}, your appointment on ${appt.date} at ${appt.time} with ${appt.dentist} has been cancelled.`,
        appointment: updated,
      });
    }

    // ── reschedule ────────────────────────────────────────────────────────────
    if (action === "reschedule") {
      if (!newDate || !normalizedNewTime) {
        return res.status(400).json({ success: false, message: "New date and new time are required for rescheduling." });
      }

      const normalizedNewDate = normalizeDate(newDate);

      if (!isClinicOpen(normalizedNewDate)) {
        return res.status(400).json({ success: false, message: "The clinic is closed on Sundays. Please choose another date." });
      }

      const taken = await queries.slotTakenExcluding(normalizedNewDate, normalizedNewTime, appt.id);
      if (taken) {
        return res.status(409).json({ success: false, message: `The ${normalizedNewTime} slot on ${normalizedNewDate} is already booked. Please choose a different time.` });
      }

      await queries.rescheduleAppointment(bookingRef, normalizedNewDate, normalizedNewTime, now);
      const updated = formatAppointment(await queries.findByRef(bookingRef));
      console.log(`Rescheduled: ${appt.patient_name} → ${normalizedNewDate} ${normalizedNewTime} | Ref: ${bookingRef}`);
      return res.json({
        success: true,
        message: `All set! ${appt.patient_name}, your appointment has been moved to ${normalizedNewDate} at ${normalizedNewTime} with ${appt.dentist}. Booking reference: ${bookingRef}.`,
        appointment: updated,
      });
    }

    // ── changeDentist ─────────────────────────────────────────────────────────
    if (action === "changeDentist") {
      if (!newDentist) {
        return res.status(400).json({ success: false, message: "Please provide the name of the dentist you'd like to switch to." });
      }

      const dentistRecord = await queries.findDentist(newDentist);

      if (!dentistRecord) {
        const allNames = (await queries.getAllDentists()).map((d) => d.name).join(", ");
        return res.status(404).json({ success: false, message: `I couldn't find "${newDentist}". Our dentists are: ${allNames}.` });
      }

      const day = getDayName(appt.date);

      if (!dentistRecord.availableDays.includes(day)) {
        const availableOnDay = (await queries.getDentistsForDay(day)).map((d) => d.name).join(", ");
        return res.status(409).json({ success: false, message: `${dentistRecord.name} is not available on ${day}. Available dentists that day: ${availableOnDay}.` });
      }

      await queries.changeDentistOnAppointment(bookingRef, dentistRecord.name, now);
      const updated = formatAppointment(await queries.findByRef(bookingRef));
      console.log(`Dentist changed: ${appt.patient_name} → ${dentistRecord.name} | Ref: ${bookingRef}`);
      return res.json({
        success: true,
        message: `Done! ${appt.patient_name}, your appointment on ${appt.date} at ${appt.time} has been updated to ${dentistRecord.name} (${dentistRecord.specialty}). Booking reference: ${bookingRef}.`,
        appointment: updated,
      });
    }

    return res.status(400).json({ success: false, message: `Unknown action "${action}". Valid actions are: cancel, reschedule, changeDentist.` });
  } catch (err) {
    console.error("updateAppointment error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. GET ALL APPOINTMENTS  [admin]
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/appointments", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const rows = await queries.getAllAppointments();
    const appointments = rows.map(formatAppointment);
    res.json({ success: true, count: appointments.length, appointments });
  } catch (err) {
    console.error("GET /api/appointments error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. LOOKUP BY BOOKING REF  [admin]
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/appointments/ref/:bookingRef", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const row = await queries.findByRef(req.params.bookingRef);
    if (!row) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, appointment: formatAppointment(row) });
  } catch (err) {
    console.error("GET /api/appointments/ref error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  8. OUTBOUND CALL  [admin]
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/outbound-call", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const { patientPhone, patientName, reason } = req.body;

    if (!patientPhone) {
      return res.status(400).json({ success: false, message: "patientPhone is required." });
    }

    const response = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: process.env.ASSISTANT_ID,
        phoneNumberId: process.env.PHONE_NUMBER_ID,
        customer: { number: patientPhone, name: patientName || "Patient" },
        assistantOverrides: {
          firstMessage: `Hello! This is a call from Bright Smile Dental Clinic. ${reason || "We are reaching out regarding your dental appointment."} How can I assist you today?`,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ success: false, message: "Failed to trigger outbound call.", error: data });
    }

    console.log(`Outbound call triggered to ${patientPhone} (${patientName || "Patient"})`);
    res.json({ success: true, message: `Calling ${patientPhone}...`, callId: data.id, call: data });
  } catch (err) {
    console.error("outbound-call error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  9. SEND REMINDERS  [admin]
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/send-reminders", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const todayAppointments = (await queries.getTodayAppointments(today)).map(formatAppointment);

    if (todayAppointments.length === 0) {
      return res.json({ success: true, message: "No appointments today to remind.", reminded: 0 });
    }

    const results = [];

    for (const appt of todayAppointments) {
      try {
        const phone = toE164Nepal(appt.phone);

        const response = await fetch("https://api.vapi.ai/call", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            assistantId: process.env.ASSISTANT_ID,
            phoneNumberId: process.env.PHONE_NUMBER_ID,
            customer: { number: phone, name: appt.patientName },
            assistantOverrides: {
              firstMessage: `Hello ${appt.patientName}! This is a reminder from Bright Smile Dental Clinic. You have an appointment today at ${appt.time} with ${appt.dentist || "your dentist"} for ${appt.reason}. Please call us if you need to reschedule. Your booking reference is ${appt.bookingRef || "on file"}. See you soon!`,
            },
          }),
        });

        const data = await response.json();
        results.push({ patient: appt.patientName, phone, status: response.ok ? "called" : "failed", callId: data.id || null });

        console.log(`Reminder sent to ${appt.patientName} at ${phone}`);
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        results.push({ patient: appt.patientName, phone: appt.phone, status: "error" });
      }
    }

    res.json({ success: true, message: `Reminders sent to ${results.length} patient(s).`, reminded: results.length, results });
  } catch (err) {
    console.error("send-reminders error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  10. VAPI WEBHOOK — DATE INJECTION + CALL LIFECYCLE  [public]
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/vapi-system", vapiLimiter, async (req, res) => {
  const message = req.body?.message;

  if (message) {
    const { type, call } = message;
    const callId = call?.id || "unknown";
    console.log(`\nVapi webhook — type: ${type} | callId: ${callId}`);

    if (type === "assistant-request") {
      const vars = getDateVariables();
      console.log("   Injecting date variables:", vars);
      return res.status(200).json({ assistantOverrides: { variableValues: vars } });
    }

    if (type === "status-update") {
      console.log(`   Call status: ${message.status}`);
      return res.status(200).json({ received: true });
    }

    if (type === "end-of-call-report") {
      const { endedReason, durationSeconds, cost, summary, transcript, recordingUrl } = message;
      console.log(`   Call ended — reason: ${endedReason} | duration: ${durationSeconds}s`);
      if (summary) console.log(`   Summary: ${summary}`);

      try {
        await queries.insertCallLog({
          callId,
          endedAt: new Date().toISOString(),
          endedReason: endedReason || null,
          durationSeconds: durationSeconds || null,
          cost: cost != null ? String(cost) : null,
          summary: summary || null,
          transcript: transcript || null,
          recordingUrl: recordingUrl || null,
        });
        console.log("Call log saved to Supabase");
      } catch (err) {
        console.error("Failed to save call log:", err.message);
      }

      return res.status(200).json({ received: true });
    }

    if (type === "transcript") return res.status(200).json({ received: true });

    if (type === "hang") {
      console.log("Assistant silence timeout triggered");
      return res.status(200).json({ received: true });
    }

    if (type === "tool-calls") {
      const toolCallList = message.toolCallList || [];
      console.log(`   Tool calls received: ${toolCallList.map((t) => t.function?.name).join(", ")}`);
      const results = toolCallList.map((tc) => ({
        toolCallId: tc.id,
        result: "Tool is handled via apiRequest — this handler is a no-op.",
      }));
      return res.status(200).json({ results });
    }

    console.log(`   Unhandled event type: ${type}`);
    return res.status(200).json({ received: true });
  }

  return res.status(200).json({ assistantOverrides: { variableValues: getDateVariables() } });
});

// ─────────────────────────────────────────────────────────────────────────────
//  11. VAPI TOOLS — unified tool-call dispatcher  [public — called by Vapi]
//
//  Vapi sends a POST to this endpoint when the assistant calls any tool.
//  Payload shape:
//    { message: { type: "tool-calls", toolCallList: [{ id, function: { name, arguments } }] } }
//
//  We dispatch to the same logic used by the individual routes, then return
//  results in the shape Vapi expects:
//    { results: [{ toolCallId, result }] }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/vapi-tools", vapiLimiter, async (req, res) => {
  try {
    const toolCallList = req.body?.message?.toolCallList || [];

    if (!toolCallList.length) {
      return res.status(400).json({ success: false, message: "No tool calls received." });
    }

    console.log(`\nVapi tool calls: ${toolCallList.map((t) => t.function?.name).join(", ")}`);

    const results = await Promise.all(
      toolCallList.map(async (tc) => {
        const name = tc.function?.name;
        let args = {};
        try {
          args = typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {};
        } catch {
          return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "Invalid arguments JSON." }) };
        }

        try {
          // ── checkAvailability ──────────────────────────────────────────────
          if (name === "checkAvailability") {
            const { date, dentist } = args;
            if (!date) return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "Date is required." }) };

            const normalizedDate = normalizeDate(date);
            if (!isClinicOpen(normalizedDate)) {
              return { toolCallId: tc.id, result: JSON.stringify({ success: true, available: false, date: normalizedDate, message: "The clinic is closed on Sundays. Please choose Monday to Saturday.", availableSlots: [] }) };
            }

            const day = getDayName(normalizedDate);
            const allSlots = SLOTS[day] || [];

            if (dentist && dentist !== "Any available dentist") {
              const dentistRecord = await queries.findDentist(dentist);
              if (dentistRecord && !dentistRecord.availableDays.includes(day)) {
                return { toolCallId: tc.id, result: JSON.stringify({ success: true, available: false, date: normalizedDate, message: `${dentistRecord.name} is not available on ${day}. Available days: ${dentistRecord.availableDays.join(", ")}.`, availableSlots: [], suggestion: "Would you like to book with another dentist or choose a different date?" }) };
              }
            }

            // Check if the requested time exists in this day's slots at all
            const requestedTime = args.time ? to12Hour(args.time) : null;
            if (requestedTime && !allSlots.includes(requestedTime)) {
              const availableDentistsEarly = (await queries.getDentistsForDay(day)).map((d) => `${d.name} (${d.specialty})`);
              return {
                toolCallId: tc.id, result: JSON.stringify({
                  success: true, available: false, date: normalizedDate,
                  day: day.charAt(0).toUpperCase() + day.slice(1),
                  requestedTime,
                  requestedDentist: dentist || "Any available dentist",
                  availableSlots: allSlots,
                  availableDentists: availableDentistsEarly,
                  slotStatus: "invalid_time",
                  reason: "outside_clinic_hours",
                  message: `Sorry, ${requestedTime} is not a valid appointment time on ${day.charAt(0).toUpperCase() + day.slice(1)}. The clinic closes earlier that day. Please choose from: ${allSlots.join(", ")}.`,
                })
              };
            }

            const bookedRows = dentist && dentist !== "Any available dentist"
              ? await queries.getBookedSlotsByDentist(normalizedDate, dentist)
              : await queries.getBookedSlots(normalizedDate);

            // FIX: normalize stored times to 12-hour before comparing with SLOTS
            const bookedSet = new Set(bookedRows.map((r) => to12Hour(r.time)));
            const availableSlots = allSlots.filter((s) => !bookedSet.has(s));
            const availableDentists = (await queries.getDentistsForDay(day)).map((d) => `${d.name} (${d.specialty})`);

            return {
              toolCallId: tc.id, result: JSON.stringify({
                success: true, available: availableSlots.length > 0, date: normalizedDate,
                day: day.charAt(0).toUpperCase() + day.slice(1),
                requestedDentist: dentist || "Any available dentist",
                availableSlots, availableDentists,
                message: availableSlots.length > 0
                  ? `${availableSlots.length} slots available on ${normalizedDate}.`
                  : `No slots available on ${normalizedDate}. Please try another date.`,
              })
            };
          }

          // ── bookAppointment ────────────────────────────────────────────────
          if (name === "bookAppointment") {
            const { patientName, phone, date, reason, dentist } = args;
            const normalizedTime = to12Hour(args.time); // FIX: normalize to 12-hour

            if (!patientName || !phone || !date || !normalizedTime || !reason) {
              return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "Missing required fields: patientName, phone, date, time, reason." }) };
            }

            const normalizedDate = normalizeDate(date);
            if (!isClinicOpen(normalizedDate)) {
              return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "The clinic is closed on Sundays. Please choose another date." }) };
            }

            const day = getDayName(normalizedDate);
            const taken = dentist && dentist !== "Any available dentist"
              ? await queries.slotTakenForDentist(normalizedDate, normalizedTime, dentist)
              : await queries.slotTaken(normalizedDate, normalizedTime);

            if (taken) {
              return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: `The ${normalizedTime} slot on ${normalizedDate} is already booked. Please choose a different time.` }) };
            }

            let assignedDentist = dentist || null;
            if (!dentist || dentist === "Any available dentist") {
              const available = await queries.getDentistsForDay(day);
              assignedDentist = available.length > 0 ? available[0].name : "Any available dentist";
            }

            const bookingRef = await generateBookingRef();
            const id = uuidv4();
            const createdAt = new Date().toISOString();

            await queries.insertAppointment({
              id, bookingRef, patientName, phone: String(phone),
              date: normalizedDate, time: normalizedTime, reason, dentist: assignedDentist, createdAt,
            });

            const newAppointment = formatAppointment(await queries.findByRef(bookingRef));
            console.log(`Booked: ${patientName} on ${normalizedDate} at ${normalizedTime} with ${assignedDentist} | Ref: ${bookingRef}`);

            return {
              toolCallId: tc.id, result: JSON.stringify({
                success: true, bookingRef, assignedDentist,
                message: `Appointment confirmed! ${patientName}, your appointment is booked for ${normalizedDate} at ${normalizedTime} with ${assignedDentist} for ${reason}. Your booking reference is ${bookingRef}.`,
                appointment: newAppointment,
              })
            };
          }

          // ── updateAppointment ──────────────────────────────────────────────
          if (name === "updateAppointment") {
            const { bookingRef, action, newDate, newDentist } = args;
            const normalizedNewTime = to12Hour(args.newTime); // FIX: normalize to 12-hour

            if (!bookingRef || !action) {
              return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "Booking reference and action are required." }) };
            }

            const appt = await queries.findConfirmed(bookingRef);
            if (!appt) {
              return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: `No confirmed appointment found for booking reference ${bookingRef}.` }) };
            }

            const now = new Date().toISOString();

            if (action === "cancel") {
              await queries.cancelAppointment(bookingRef, now);
              const updated = formatAppointment(await queries.findByRef(bookingRef));
              return { toolCallId: tc.id, result: JSON.stringify({ success: true, message: `Done! ${appt.patient_name}, your appointment on ${appt.date} at ${appt.time} with ${appt.dentist} has been cancelled.`, appointment: updated }) };
            }

            if (action === "reschedule") {
              if (!newDate || !normalizedNewTime) {
                return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "New date and new time are required for rescheduling." }) };
              }
              const normalizedNewDate = normalizeDate(newDate);
              if (!isClinicOpen(normalizedNewDate)) {
                return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "The clinic is closed on Sundays. Please choose another date." }) };
              }
              const taken = await queries.slotTakenExcluding(normalizedNewDate, normalizedNewTime, appt.id);
              if (taken) {
                return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: `The ${normalizedNewTime} slot on ${normalizedNewDate} is already booked. Please choose a different time.` }) };
              }
              await queries.rescheduleAppointment(bookingRef, normalizedNewDate, normalizedNewTime, now);
              const updated = formatAppointment(await queries.findByRef(bookingRef));
              return { toolCallId: tc.id, result: JSON.stringify({ success: true, message: `All set! ${appt.patient_name}, your appointment has been moved to ${normalizedNewDate} at ${normalizedNewTime} with ${appt.dentist}. Booking reference: ${bookingRef}.`, appointment: updated }) };
            }

            if (action === "changeDentist") {
              if (!newDentist) {
                return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "Please provide the name of the dentist you'd like to switch to." }) };
              }
              const dentistRecord = await queries.findDentist(newDentist);
              if (!dentistRecord) {
                const allNames = (await queries.getAllDentists()).map((d) => d.name).join(", ");
                return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: `I couldn't find "${newDentist}". Our dentists are: ${allNames}.` }) };
              }
              const day = getDayName(appt.date);
              if (!dentistRecord.availableDays.includes(day)) {
                const availableOnDay = (await queries.getDentistsForDay(day)).map((d) => d.name).join(", ");
                return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: `${dentistRecord.name} is not available on ${day}. Available dentists that day: ${availableOnDay}.` }) };
              }
              await queries.changeDentistOnAppointment(bookingRef, dentistRecord.name, now);
              const updated = formatAppointment(await queries.findByRef(bookingRef));
              return { toolCallId: tc.id, result: JSON.stringify({ success: true, message: `Done! ${appt.patient_name}, your appointment on ${appt.date} at ${appt.time} has been updated to ${dentistRecord.name} (${dentistRecord.specialty}). Booking reference: ${bookingRef}.`, appointment: updated }) };
            }

            return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: `Unknown action "${action}". Valid actions are: cancel, reschedule, changeDentist.` }) };
          }

          // ── unknown tool ───────────────────────────────────────────────────
          return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: `Unknown tool: ${name}` }) };

        } catch (err) {
          console.error(`Tool "${name}" error:`, err);
          return { toolCallId: tc.id, result: JSON.stringify({ success: false, message: "Internal server error." }) };
        }
      })
    );

    return res.status(200).json({ results });
  } catch (err) {
    console.error("vapi-tools error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────────────────────────────────────────
// app.get("/", (req, res) => {
//   res.json({
//     status: "Bright Smile Dental Voice Agent — Backend Running",
//     storage: "Supabase (Postgres)",
//     endpoints: {
//       checkAvailability: "POST /api/check-availability",
//       bookAppointment: "POST /api/book-appointment",
//       updateAppointment: "POST /api/update-appointment",
//       vapiTools: "POST /api/vapi-tools",
//       vapiSystem: "POST /api/vapi-system",
//       dentists: "GET  /api/dentists              [admin]",
//       dentistsByDate: "GET  /api/dentists/available    [admin]",
//       allAppointments: "GET  /api/appointments          [admin]",
//       byBookingRef: "GET  /api/appointments/ref/:ref [admin]",
//       outboundCall: "POST /api/outbound-call         [admin]",
//       sendReminders: "POST /api/send-reminders        [admin]",
//     },
//   });
// });

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: no app.listen() here at module scope — Vercel's serverless
// runtime imports this file and calls the exported `app` directly per
// request (see api/index.js). Calling .listen() would have no effect on
// Vercel and isn't needed.
//
// For local development, run `node server.js` directly — this guard makes
// it listen on a port only when the file is executed directly, not when
// it's required by api/index.js.
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nBright Smile Dental Backend running on http://localhost:${PORT}`);
    console.log(`Storage: Supabase (Postgres)`);
  });
}

module.exports = app;