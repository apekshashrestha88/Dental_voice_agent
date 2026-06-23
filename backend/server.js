/**
 * server.js — Bright Smile Dental Voice Agent — Main Backend (port 3000)
 *
 * Storage: better-sqlite3 (dental.db) — replaces appointments.json
 *   - Atomic writes at the SQLite layer; no write-queue needed
 *   - WAL mode set in db.js: readers never block writers
 *   - Survives crashes without data corruption
 *
 * Run:
 *   npm install better-sqlite3 express-rate-limit   (first time only)
 *   node server.js
 */

require("dotenv").config();

const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");

// db is the better-sqlite3 connection — synchronous, already open, tables exist
const db = require("./db");

const app  = express();
const PORT = 3000;

// ─── Trust proxy — required for correct IP detection behind ngrok ─────────────
// Without this, express-rate-limit sees every request as coming from ngrok's
// server IP instead of the real caller IP, making per-IP limiting useless.
app.set("trust proxy", 1);

// ─── Clinic slot schedule ─────────────────────────────────────────────────────
const SLOTS = {
  monday:    ["09:00 AM","10:00 AM","11:00 AM","12:00 PM","02:00 PM","03:00 PM","04:00 PM","05:00 PM"],
  tuesday:   ["09:00 AM","10:00 AM","11:00 AM","12:00 PM","02:00 PM","03:00 PM","04:00 PM","05:00 PM"],
  wednesday: ["09:00 AM","10:00 AM","11:00 AM","12:00 PM","02:00 PM","03:00 PM","04:00 PM","05:00 PM"],
  thursday:  ["09:00 AM","10:00 AM","11:00 AM","12:00 PM","02:00 PM","03:00 PM","04:00 PM","05:00 PM"],
  friday:    ["09:00 AM","10:00 AM","11:00 AM","12:00 PM","02:00 PM","03:00 PM","04:00 PM","05:00 PM"],
  saturday:  ["09:00 AM","10:00 AM","11:00 AM","12:00 PM","02:00 PM","03:00 PM"],
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Request Logger ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`\n ${req.method} ${req.path}`);
  if (req.body  && Object.keys(req.body).length)  console.log("   Body:",  JSON.stringify(req.body));
  if (req.query && Object.keys(req.query).length) console.log("   Query:", JSON.stringify(req.query));
  next();
});

// ─── Rate Limiters ────────────────────────────────────────────────────────────
// Two separate limiters because the two classes of endpoint have different
// risk profiles:
//
//  vapiLimiter  — public endpoints Vapi calls during a live call.
//                 A single call can trigger 3-4 tool calls in quick succession,
//                 so the limit is generous (60/min) — tight enough to block
//                 programmatic abuse, loose enough to never throttle a real call.
//
//  adminLimiter — endpoints that trigger outbound Vapi/Twilio calls or expose
//                 patient data. Much tighter (100 per 15 min) to cap cost damage
//                 and slow brute-force attempts against the API key.

const vapiLimiter = rateLimit({
  windowMs:        60 * 1000,  // 1-minute window
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: "Too many requests — please try again shortly." },
});

const adminLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,  // 15-minute window
  max:             100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: "Too many requests." },
});

// ─── Admin API Key Auth ───────────────────────────────────────────────────────
// Vapi tool endpoints are intentionally left open — Vapi calls them directly
// during live calls and cannot send custom headers.
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }
  next();
}

// ─── Input Sanitization ───────────────────────────────────────────────────────
// Applied to all public Vapi endpoints. Trims whitespace and enforces length
// caps so a caller spelling something unusual can't write unbounded data to
// the database. Limits are generous for real patient data but stop abuse.
const LIMITS = {
  patientName: 100,
  phone:        30,
  reason:      300,
  dentist:     100,
  date:         20,
  time:         20,
  bookingRef:   10,
  action:       20,
};

function sanitizeString(value, maxLen) {
  if (value === undefined || value === null) return value;
  return String(value).trim().slice(0, maxLen);
}

function sanitizeBody(raw) {
  return {
    patientName: sanitizeString(raw.patientName, LIMITS.patientName),
    phone:       sanitizeString(raw.phone,       LIMITS.phone),
    date:        sanitizeString(raw.date,        LIMITS.date),
    time:        sanitizeString(raw.time,        LIMITS.time),
    reason:      sanitizeString(raw.reason,      LIMITS.reason),
    dentist:     sanitizeString(raw.dentist,     LIMITS.dentist),
    bookingRef:  sanitizeString(raw.bookingRef,  LIMITS.bookingRef),
    action:      sanitizeString(raw.action,      LIMITS.action),
    newDate:     sanitizeString(raw.newDate,     LIMITS.date),
    newTime:     sanitizeString(raw.newTime,     LIMITS.time),
    newDentist:  sanitizeString(raw.newDentist,  LIMITS.dentist),
  };
}

// ─── Prepared statements (compiled once, reused on every request) ─────────────
const stmts = {
  getAllDentists:      db.prepare("SELECT * FROM dentists"),
  getDentistByName:   db.prepare("SELECT * FROM dentists WHERE lower(name) LIKE lower(@pattern)"),
  getDentistsByDay:   db.prepare("SELECT * FROM dentists WHERE available_days LIKE @pattern"),

  getBookedSlots:     db.prepare(`
    SELECT time FROM appointments
    WHERE date = @date AND status = 'confirmed'
  `),
  getBookedSlotsByDentist: db.prepare(`
    SELECT time FROM appointments
    WHERE date = @date AND status = 'confirmed' AND lower(dentist) LIKE lower(@pattern)
  `),

  refExists:          db.prepare("SELECT 1 FROM appointments WHERE booking_ref = @ref"),
  slotTaken:          db.prepare(`
    SELECT 1 FROM appointments
    WHERE date = @date AND time = @time AND status = 'confirmed'
  `),
  slotTakenForDentist: db.prepare(`
    SELECT 1 FROM appointments
    WHERE date = @date AND time = @time AND status = 'confirmed'
      AND lower(dentist) LIKE lower(@pattern)
  `),
  slotTakenExcluding: db.prepare(`
    SELECT 1 FROM appointments
    WHERE date = @date AND time = @time AND status = 'confirmed' AND id != @id
  `),

  insertAppointment:  db.prepare(`
    INSERT INTO appointments
      (id, booking_ref, patient_name, phone, date, time, reason, dentist, status, created_at)
    VALUES
      (@id, @bookingRef, @patientName, @phone, @date, @time, @reason, @dentist, 'confirmed', @createdAt)
  `),

  findConfirmed:      db.prepare(`
    SELECT * FROM appointments WHERE booking_ref = @ref AND status = 'confirmed'
  `),
  findByRef:          db.prepare("SELECT * FROM appointments WHERE booking_ref = @ref"),

  cancel:             db.prepare(`
    UPDATE appointments SET status = 'cancelled', cancelled_at = @now WHERE booking_ref = @ref
  `),
  reschedule:         db.prepare(`
    UPDATE appointments SET date = @date, time = @time, rescheduled_at = @now WHERE booking_ref = @ref
  `),
  changeDentist:      db.prepare(`
    UPDATE appointments SET dentist = @dentist, dentist_updated_at = @now WHERE booking_ref = @ref
  `),

  getAllAppointments:    db.prepare("SELECT * FROM appointments ORDER BY created_at DESC"),
  getTodayAppointments: db.prepare(`
    SELECT * FROM appointments WHERE date = @today AND status = 'confirmed'
  `),

  // Call log — persisted from the end-of-call-report Vapi webhook event.
  // Table is created in db.js alongside the appointments schema.
  insertCallLog: db.prepare(`
    INSERT INTO call_logs
      (call_id, ended_at, ended_reason, duration_seconds, cost, summary, transcript, recording_url)
    VALUES
      (@callId, @endedAt, @endedReason, @durationSeconds, @cost, @summary, @transcript, @recordingUrl)
  `),
};

// ─── Utility: shape a DB row into the API response shape ─────────────────────
function formatAppointment(row) {
  if (!row) return null;
  return {
    id:               row.id,
    bookingRef:       row.booking_ref,
    patientName:      row.patient_name,
    phone:            row.phone,
    date:             row.date,
    time:             row.time,
    reason:           row.reason,
    dentist:          row.dentist,
    status:           row.status,
    createdAt:        row.created_at,
    rescheduledAt:    row.rescheduled_at     || undefined,
    cancelledAt:      row.cancelled_at       || undefined,
    dentistUpdatedAt: row.dentist_updated_at || undefined,
  };
}

// ─── Utility: generate a unique 4-digit booking reference ────────────────────
function generateBookingRef() {
  let ref;
  do {
    ref = String(Math.floor(1000 + Math.random() * 9000));
  } while (stmts.refExists.get({ ref }));
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
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const date = new Date(normalized + "T00:00:00");
  if (isNaN(date.getTime())) return null;
  return days[date.getDay()];
}

function isClinicOpen(dateStr) {
  const day = getDayName(dateStr);
  return day && day !== "sunday";
}

// ─── Utility: normalize phone to E.164 ───────────────────────────────────────
function toE164Nepal(phone) {
  const s = String(phone).trim();
  if (s.startsWith("+"))   return s;
  if (s.startsWith("977")) return `+${s}`;
  return `+977${s}`;
}

// ─── Utility: find a dentist by partial name match ───────────────────────────
function findDentist(nameQuery) {
  const row = stmts.getDentistByName.get({ pattern: `%${nameQuery}%` });
  return db.parseDentist(row);
}

// ─── Utility: get all dentists available on a given day ──────────────────────
function getDentistsForDay(day) {
  const rows = stmts.getDentistsByDay.all({ pattern: `%${day}%` });
  return rows.map(db.parseDentist);
}

// ─── Utility: build date variables for Vapi prompt injection ─────────────────
function getDateVariables() {
  const now      = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  const days   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];

  const toISO     = d => d.toISOString().split("T")[0];
  const toNatural = d => `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  return {
    today_date:   toNatural(now),
    today_iso:    toISO(now),
    tomorrow_day: days[tomorrow.getDay()],
    tomorrow_iso: toISO(tomorrow),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. GET ALL DENTISTS  [admin]
//  GET /api/dentists
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/dentists", adminLimiter, requireApiKey, (req, res) => {
  try {
    const rows = stmts.getAllDentists.all();
    res.json({ success: true, dentists: rows.map(db.parseDentist) });
  } catch (err) {
    console.error("GET /api/dentists error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. GET DENTISTS AVAILABLE ON A SPECIFIC DATE  [admin]
//  GET /api/dentists/available?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/dentists/available", adminLimiter, requireApiKey, (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: "Date is required." });

    const day = getDayName(date);

    if (day === "sunday") {
      return res.json({
        success:  true,
        available: false,
        message:  "The clinic is closed on Sundays.",
        dentists: [],
      });
    }

    const dentists = getDentistsForDay(day);

    res.json({
      success:  true,
      date,
      day:      day.charAt(0).toUpperCase() + day.slice(1),
      dentists,
      message:  dentists.length > 0
        ? `${dentists.length} dentists available on ${date}: ${dentists.map(d => d.name).join(", ")}.`
        : "No dentists available on this date.",
    });
  } catch (err) {
    console.error("GET /api/dentists/available error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. CHECK AVAILABILITY  [public — called by Vapi]
//  POST /api/check-availability
//  Body: { date, dentist? }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/check-availability", vapiLimiter, (req, res) => {
  try {
    const { date, dentist } = sanitizeBody(req.body);

    if (!date) return res.status(400).json({ success: false, message: "Date is required." });

    const normalizedDate = normalizeDate(date);

    if (!isClinicOpen(normalizedDate)) {
      return res.json({
        success:        true,
        available:      false,
        date:           normalizedDate,
        message:        "The clinic is closed on Sundays. Please choose Monday to Saturday.",
        availableSlots: [],
      });
    }

    const day      = getDayName(normalizedDate);
    const allSlots = SLOTS[day] || [];

    // If a specific dentist is requested, verify they work that day
    if (dentist && dentist !== "Any available dentist") {
      const dentistRecord = findDentist(dentist);
      if (dentistRecord && !dentistRecord.availableDays.includes(day)) {
        return res.json({
          success:        true,
          available:      false,
          date:           normalizedDate,
          message:        `${dentistRecord.name} is not available on ${day}. Available days: ${dentistRecord.availableDays.join(", ")}.`,
          availableSlots: [],
          suggestion:     "Would you like to book with another dentist or choose a different date?",
        });
      }
    }

    const bookedRows = (dentist && dentist !== "Any available dentist")
      ? stmts.getBookedSlotsByDentist.all({ date: normalizedDate, pattern: `%${dentist}%` })
      : stmts.getBookedSlots.all({ date: normalizedDate });

    const bookedSet         = new Set(bookedRows.map(r => r.time));
    const availableSlots    = allSlots.filter(s => !bookedSet.has(s));
    const availableDentists = getDentistsForDay(day).map(d => `${d.name} (${d.specialty})`);

    return res.json({
      success:            true,
      available:          availableSlots.length > 0,
      date:               normalizedDate,
      day:                day.charAt(0).toUpperCase() + day.slice(1),
      requestedDentist:   dentist || "Any available dentist",
      availableSlots,
      availableDentists,
      message: availableSlots.length > 0
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
//  POST /api/book-appointment
//  Body: { patientName, phone, date, time, reason, dentist? }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/book-appointment", vapiLimiter, (req, res) => {
  try {
    const { patientName, phone, date, time, reason, dentist } = sanitizeBody(req.body);

    if (!patientName || !phone || !date || !time || !reason) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: patientName, phone, date, time, reason.",
      });
    }

    const normalizedDate = normalizeDate(date);

    if (!isClinicOpen(normalizedDate)) {
      return res.status(400).json({
        success: false,
        message: "The clinic is closed on Sundays. Please choose another date.",
      });
    }

    const day = getDayName(normalizedDate);

    const taken = (dentist && dentist !== "Any available dentist")
      ? stmts.slotTakenForDentist.get({ date: normalizedDate, time, pattern: `%${dentist}%` })
      : stmts.slotTaken.get({ date: normalizedDate, time });

    if (taken) {
      return res.status(409).json({
        success: false,
        message: `The ${time} slot on ${normalizedDate} is already booked. Please choose a different time.`,
      });
    }

    let assignedDentist = dentist || null;
    if (!dentist || dentist === "Any available dentist") {
      const available = getDentistsForDay(day);
      assignedDentist = available.length > 0 ? available[0].name : "Any available dentist";
    }

    const bookingRef = generateBookingRef();
    const id         = uuidv4();
    const createdAt  = new Date().toISOString();

    stmts.insertAppointment.run({
      id, bookingRef, patientName, phone: String(phone),
      date: normalizedDate, time, reason, dentist: assignedDentist, createdAt,
    });

    const newAppointment = formatAppointment(stmts.findByRef.get({ ref: bookingRef }));

    console.log(`Booked: ${patientName} on ${normalizedDate} at ${time} with ${assignedDentist} | Ref: ${bookingRef}`);

    return res.status(201).json({
      success:         true,
      bookingRef,
      assignedDentist,
      message:         `Appointment confirmed! ${patientName}, your appointment is booked for ${normalizedDate} at ${time} with ${assignedDentist} for ${reason}. Your booking reference is ${bookingRef}.`,
      appointment:     newAppointment,
    });
  } catch (err) {
    console.error("bookAppointment error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. UPDATE APPOINTMENT  [public — called by Vapi]
//  POST /api/update-appointment
//  Body: { bookingRef, action, newDate?, newTime?, newDentist? }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/update-appointment", vapiLimiter, (req, res) => {
  try {
    const { bookingRef, action, newDate, newTime, newDentist } = sanitizeBody(req.body);

    if (!bookingRef || !action) {
      return res.status(400).json({
        success: false,
        message: "Booking reference and action are required.",
      });
    }

    const appt = stmts.findConfirmed.get({ ref: bookingRef });

    if (!appt) {
      return res.status(404).json({
        success: false,
        message: `No confirmed appointment found for booking reference ${bookingRef}.`,
      });
    }

    const now = new Date().toISOString();

    // ── cancel ────────────────────────────────────────────────────────────────
    if (action === "cancel") {
      stmts.cancel.run({ ref: bookingRef, now });
      const updated = formatAppointment(stmts.findByRef.get({ ref: bookingRef }));
      console.log(`Cancelled: ${appt.patient_name} | Ref: ${bookingRef}`);
      return res.json({
        success:     true,
        message:     `Done! ${appt.patient_name}, your appointment on ${appt.date} at ${appt.time} with ${appt.dentist} has been cancelled.`,
        appointment: updated,
      });
    }

    // ── reschedule ────────────────────────────────────────────────────────────
    if (action === "reschedule") {
      if (!newDate || !newTime) {
        return res.status(400).json({
          success: false,
          message: "New date and new time are required for rescheduling.",
        });
      }

      const normalizedNewDate = normalizeDate(newDate);

      if (!isClinicOpen(normalizedNewDate)) {
        return res.status(400).json({
          success: false,
          message: "The clinic is closed on Sundays. Please choose another date.",
        });
      }

      const taken = stmts.slotTakenExcluding.get({ date: normalizedNewDate, time: newTime, id: appt.id });
      if (taken) {
        return res.status(409).json({
          success: false,
          message: `The ${newTime} slot on ${normalizedNewDate} is already booked. Please choose a different time.`,
        });
      }

      stmts.reschedule.run({ ref: bookingRef, date: normalizedNewDate, time: newTime, now });
      const updated = formatAppointment(stmts.findByRef.get({ ref: bookingRef }));
      console.log(`Rescheduled: ${appt.patient_name} → ${normalizedNewDate} ${newTime} | Ref: ${bookingRef}`);
      return res.json({
        success:     true,
        message:     `All set! ${appt.patient_name}, your appointment has been moved to ${normalizedNewDate} at ${newTime} with ${appt.dentist}. Booking reference: ${bookingRef}.`,
        appointment: updated,
      });
    }

    // ── changeDentist ─────────────────────────────────────────────────────────
    if (action === "changeDentist") {
      if (!newDentist) {
        return res.status(400).json({
          success: false,
          message: "Please provide the name of the dentist you'd like to switch to.",
        });
      }

      const dentistRecord = findDentist(newDentist);

      if (!dentistRecord) {
        const allNames = stmts.getAllDentists.all().map(d => d.name).join(", ");
        return res.status(404).json({
          success: false,
          message: `I couldn't find "${newDentist}". Our dentists are: ${allNames}.`,
        });
      }

      const day = getDayName(appt.date);

      if (!dentistRecord.availableDays.includes(day)) {
        const availableOnDay = getDentistsForDay(day).map(d => d.name).join(", ");
        return res.status(409).json({
          success: false,
          message: `${dentistRecord.name} is not available on ${day}. Available dentists that day: ${availableOnDay}.`,
        });
      }

      stmts.changeDentist.run({ ref: bookingRef, dentist: dentistRecord.name, now });
      const updated = formatAppointment(stmts.findByRef.get({ ref: bookingRef }));
      console.log(`Dentist changed: ${appt.patient_name} → ${dentistRecord.name} | Ref: ${bookingRef}`);
      return res.json({
        success:     true,
        message:     `Done! ${appt.patient_name}, your appointment on ${appt.date} at ${appt.time} has been updated to ${dentistRecord.name} (${dentistRecord.specialty}). Booking reference: ${bookingRef}.`,
        appointment: updated,
      });
    }

    // ── unknown action ────────────────────────────────────────────────────────
    return res.status(400).json({
      success: false,
      message: `Unknown action "${action}". Valid actions are: cancel, reschedule, changeDentist.`,
    });

  } catch (err) {
    console.error("updateAppointment error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. GET ALL APPOINTMENTS  [admin]
//  GET /api/appointments
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/appointments", adminLimiter, requireApiKey, (req, res) => {
  try {
    const rows         = stmts.getAllAppointments.all();
    const appointments = rows.map(formatAppointment);
    res.json({ success: true, count: appointments.length, appointments });
  } catch (err) {
    console.error("GET /api/appointments error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. LOOKUP BY BOOKING REF  [admin]
//  GET /api/appointments/ref/:bookingRef
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/appointments/ref/:bookingRef", adminLimiter, requireApiKey, (req, res) => {
  try {
    const row = stmts.findByRef.get({ ref: req.params.bookingRef });
    if (!row) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, appointment: formatAppointment(row) });
  } catch (err) {
    console.error("GET /api/appointments/ref error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  8. OUTBOUND CALL  [admin]
//  POST /api/outbound-call
//  Body: { patientPhone, patientName, reason }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/outbound-call", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const { patientPhone, patientName, reason } = req.body;

    if (!patientPhone) {
      return res.status(400).json({ success: false, message: "patientPhone is required." });
    }

    const response = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${process.env.VAPI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId:   process.env.ASSISTANT_ID,
        phoneNumberId: process.env.PHONE_NUMBER_ID,
        customer: {
          number: patientPhone,
          name:   patientName || "Patient",
        },
        assistantOverrides: {
          firstMessage: `Hello! This is a call from Bright Smile Dental Clinic. ${
            reason || "We are reaching out regarding your dental appointment."
          } How can I assist you today?`,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("VAPI outbound error:", JSON.stringify(data));
      return res.status(500).json({
        success: false,
        message: "Failed to trigger outbound call.",
        error:   data,
      });
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
//  POST /api/send-reminders
//  Calls all patients with confirmed appointments today
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/send-reminders", adminLimiter, requireApiKey, async (req, res) => {
  try {
    const today             = new Date().toISOString().split("T")[0];
    const todayAppointments = stmts.getTodayAppointments.all({ today }).map(formatAppointment);

    if (todayAppointments.length === 0) {
      return res.json({ success: true, message: "No appointments today to remind.", reminded: 0 });
    }

    const results = [];

    for (const appt of todayAppointments) {
      try {
        const phone = toE164Nepal(appt.phone);

        const response = await fetch("https://api.vapi.ai/call", {
          method: "POST",
          headers: {
            Authorization:  `Bearer ${process.env.VAPI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            assistantId:   process.env.ASSISTANT_ID,
            phoneNumberId: process.env.PHONE_NUMBER_ID,
            customer: { number: phone, name: appt.patientName },
            assistantOverrides: {
              firstMessage: `Hello ${appt.patientName}! This is a reminder from Bright Smile Dental Clinic. You have an appointment today at ${appt.time} with ${appt.dentist || "your dentist"} for ${appt.reason}. Please call us if you need to reschedule. Your booking reference is ${appt.bookingRef || "on file"}. See you soon!`,
            },
          }),
        });

        const data = await response.json();
        results.push({
          patient: appt.patientName,
          phone,
          status: response.ok ? "called" : "failed",
          callId: data.id || null,
        });

        console.log(`Reminder sent to ${appt.patientName} at ${phone}`);
        await new Promise(r => setTimeout(r, 1000)); // avoid Vapi rate limits

      } catch (err) {
        results.push({ patient: appt.patientName, phone: appt.phone, status: "error" });
      }
    }

    res.json({
      success:  true,
      message:  `Reminders sent to ${results.length} patient(s).`,
      reminded: results.length,
      results,
    });

  } catch (err) {
    console.error("send-reminders error:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  10. VAPI WEBHOOK — DATE INJECTION + CALL LIFECYCLE  [public]
//  POST /api/vapi-system
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/vapi-system", vapiLimiter, (req, res) => {
  const message = req.body?.message;

  if (message) {
    const { type, call } = message;
    const callId = call?.id || "unknown";
    console.log(`\nVapi webhook — type: ${type} | callId: ${callId}`);

    // ── assistant-request ─────────────────────────────────────────────────────
    // Inject today's date variables into the assistant's system prompt at call start.
    if (type === "assistant-request") {
      const vars = getDateVariables();
      console.log("   Injecting date variables:", vars);
      return res.status(200).json({ assistantOverrides: { variableValues: vars } });
    }

    // ── status-update ─────────────────────────────────────────────────────────
    if (type === "status-update") {
      console.log(`   Call status: ${message.status}`);
      return res.status(200).json({ received: true });
    }

    // ── end-of-call-report ────────────────────────────────────────────────────
    // Persist the call log to SQLite so it's available for audit/debugging.
    // Non-fatal: a failed write logs the error but still returns 200 to Vapi
    // so the webhook doesn't get retried in a loop.
    if (type === "end-of-call-report") {
      const { endedReason, durationSeconds, cost, summary, transcript, recordingUrl } = message;
      console.log(`   Call ended — reason: ${endedReason} | duration: ${durationSeconds}s`);
      if (summary) console.log(`   Summary: ${summary}`);

      try {
        stmts.insertCallLog.run({
          callId,
          endedAt:         new Date().toISOString(),
          endedReason:     endedReason     || null,
          durationSeconds: durationSeconds || null,
          cost:            cost != null ? String(cost) : null,
          summary:         summary         || null,
          transcript:      transcript      || null,
          recordingUrl:    recordingUrl    || null,
        });
        console.log(" Call log saved to dental.db");
      } catch (err) {
        console.error(" Failed to save call log:", err.message);
      }

      return res.status(200).json({ received: true });
    }

    // ── transcript ────────────────────────────────────────────────────────────
    if (type === "transcript") return res.status(200).json({ received: true });

    // ── hang ──────────────────────────────────────────────────────────────────
    if (type === "hang") {
      console.log("Assistant silence timeout triggered");
      return res.status(200).json({ received: true });
    }

    // ── tool-calls (server-side tool mode — not used, included as safety net) ─
    if (type === "tool-calls") {
      const toolCallList = message.toolCallList || [];
      console.log(`   Tool calls received: ${toolCallList.map(t => t.function?.name).join(", ")}`);
      const results = toolCallList.map(tc => ({
        toolCallId: tc.id,
        result: "Tool is handled via apiRequest — this handler is a no-op.",
      }));
      return res.status(200).json({ results });
    }

    console.log(`   Unhandled event type: ${type}`);
    return res.status(200).json({ received: true });
  }

  // Bare POST (e.g. manual curl test) — return dates in correct Vapi format
  return res.status(200).json({ assistantOverrides: { variableValues: getDateVariables() } });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:    "Bright Smile Dental Voice Agent — Backend Running",
    storage:   "SQLite (dental.db)",
    endpoints: {
      checkAvailability: "POST /api/check-availability",
      bookAppointment:   "POST /api/book-appointment",
      updateAppointment: "POST /api/update-appointment",
      vapiSystem:        "POST /api/vapi-system",
      dentists:          "GET  /api/dentists              [admin]",
      dentistsByDate:    "GET  /api/dentists/available    [admin]",
      allAppointments:   "GET  /api/appointments          [admin]",
      byBookingRef:      "GET  /api/appointments/ref/:ref [admin]",
      outboundCall:      "POST /api/outbound-call         [admin]",
      sendReminders:     "POST /api/send-reminders        [admin]",
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nBright Smile Dental Backend running on http://localhost:${PORT}`);
  console.log(`Storage: SQLite (dental.db)`);
  console.log(`Ngrok:   https://eve-brainlike-yoshie.ngrok-free.dev`);
  console.log(`\nDentists loaded: Dr. Priya Sharma, Dr. Sanjay Verma, Dr. Anita Rai, Dr. Rohan Mehta, Dr. Kavya Nair\n`);
});