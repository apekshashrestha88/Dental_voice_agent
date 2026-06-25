/**
 * queries.js
 * Replaces the `stmts = { ... db.prepare(...) }` block from the old server.js.
 *
 * Every function here is async (Supabase calls are network requests, unlike
 * better-sqlite3 which was synchronous). Route handlers that use these must
 * `await` them.
 *
 * Table shapes (see supabase-schema.sql):
 *   dentists(id, name, specialty, available_days text[])
 *   appointments(id, booking_ref, patient_name, phone, date, time, reason,
 *                dentist, status, created_at, rescheduled_at, cancelled_at,
 *                dentist_updated_at)
 *   call_logs(id, call_id, ended_at, ended_reason, duration_seconds, cost,
 *             summary, transcript, recording_url)
 */

const supabase = require("./supabaseClient");

function throwIfError(error, context) {
  if (error) {
    const err = new Error(`${context}: ${error.message}`);
    err.cause = error;
    throw err;
  }
}

// ─── Dentist helper: convert DB row → API shape (available_days → availableDays) ─
function parseDentist(row) {
  if (!row) return null;
  return { ...row, availableDays: row.available_days || [] };
}

// ─── Dentists ─────────────────────────────────────────────────────────────────

async function getAllDentists() {
  const { data, error } = await supabase.from("dentists").select("*");
  throwIfError(error, "getAllDentists");
  return (data || []).map(parseDentist);
}

async function findDentist(nameQuery) {
  const { data, error } = await supabase
    .from("dentists")
    .select("*")
    .ilike("name", `%${nameQuery}%`)
    .limit(1)
    .maybeSingle();
  throwIfError(error, "findDentist");
  return parseDentist(data);
}

async function getDentistsForDay(day) {
  const { data, error } = await supabase
    .from("dentists")
    .select("*")
    .contains("available_days", [day]);
  throwIfError(error, "getDentistsForDay");
  return (data || []).map(parseDentist);
}

// ─── Appointment lookups used during booking ──────────────────────────────────

async function refExists(ref) {
  const { data, error } = await supabase
    .from("appointments")
    .select("id")
    .eq("booking_ref", ref)
    .maybeSingle();
  throwIfError(error, "refExists");
  return !!data;
}

async function getBookedSlots(date) {
  const { data, error } = await supabase
    .from("appointments")
    .select("time")
    .eq("date", date)
    .eq("status", "confirmed");
  throwIfError(error, "getBookedSlots");
  return data || [];
}

async function getBookedSlotsByDentist(date, dentist) {
  const { data, error } = await supabase
    .from("appointments")
    .select("time")
    .eq("date", date)
    .eq("status", "confirmed")
    .ilike("dentist", `%${dentist}%`);
  throwIfError(error, "getBookedSlotsByDentist");
  return data || [];
}

async function slotTaken(date, time) {
  const { data, error } = await supabase
    .from("appointments")
    .select("id")
    .eq("date", date)
    .eq("time", time)
    .eq("status", "confirmed")
    .maybeSingle();
  throwIfError(error, "slotTaken");
  return !!data;
}

async function slotTakenForDentist(date, time, dentist) {
  const { data, error } = await supabase
    .from("appointments")
    .select("id")
    .eq("date", date)
    .eq("time", time)
    .eq("status", "confirmed")
    .ilike("dentist", `%${dentist}%`)
    .maybeSingle();
  throwIfError(error, "slotTakenForDentist");
  return !!data;
}

async function slotTakenExcluding(date, time, excludeId) {
  const { data, error } = await supabase
    .from("appointments")
    .select("id")
    .eq("date", date)
    .eq("time", time)
    .eq("status", "confirmed")
    .neq("id", excludeId)
    .maybeSingle();
  throwIfError(error, "slotTakenExcluding");
  return !!data;
}

// ─── Create / read / update appointments ──────────────────────────────────────

async function insertAppointment(row) {
  const { error } = await supabase.from("appointments").insert({
    id: row.id,
    booking_ref: row.bookingRef,
    patient_name: row.patientName,
    phone: row.phone,
    date: row.date,
    time: row.time,
    reason: row.reason,
    dentist: row.dentist,
    status: "confirmed",
    created_at: row.createdAt,
  });
  throwIfError(error, "insertAppointment");
}

async function findConfirmed(ref) {
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("booking_ref", ref)
    .eq("status", "confirmed")
    .maybeSingle();
  throwIfError(error, "findConfirmed");
  return data;
}

async function findByRef(ref) {
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("booking_ref", ref)
    .maybeSingle();
  throwIfError(error, "findByRef");
  return data;
}

async function cancelAppointment(ref, now) {
  const { error } = await supabase
    .from("appointments")
    .update({ status: "cancelled", cancelled_at: now })
    .eq("booking_ref", ref);
  throwIfError(error, "cancelAppointment");
}

async function rescheduleAppointment(ref, date, time, now) {
  const { error } = await supabase
    .from("appointments")
    .update({ date, time, rescheduled_at: now })
    .eq("booking_ref", ref);
  throwIfError(error, "rescheduleAppointment");
}

async function changeDentistOnAppointment(ref, dentist, now) {
  const { error } = await supabase
    .from("appointments")
    .update({ dentist, dentist_updated_at: now })
    .eq("booking_ref", ref);
  throwIfError(error, "changeDentistOnAppointment");
}

async function getAllAppointments() {
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .order("created_at", { ascending: false });
  throwIfError(error, "getAllAppointments");
  return data || [];
}

async function getTodayAppointments(today) {
  const { data, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("date", today)
    .eq("status", "confirmed");
  throwIfError(error, "getTodayAppointments");
  return data || [];
}

// ─── Call logs (from the Vapi end-of-call-report webhook) ────────────────────

async function insertCallLog(row) {
  const { error } = await supabase.from("call_logs").insert({
    call_id: row.callId,
    ended_at: row.endedAt,
    ended_reason: row.endedReason,
    duration_seconds: row.durationSeconds,
    cost: row.cost,
    summary: row.summary,
    transcript: row.transcript,
    recording_url: row.recordingUrl,
  });
  throwIfError(error, "insertCallLog");
}

module.exports = {
  parseDentist,
  getAllDentists,
  findDentist,
  getDentistsForDay,
  refExists,
  getBookedSlots,
  getBookedSlotsByDentist,
  slotTaken,
  slotTakenForDentist,
  slotTakenExcluding,
  insertAppointment,
  findConfirmed,
  findByRef,
  cancelAppointment,
  rescheduleAppointment,
  changeDentistOnAppointment,
  getAllAppointments,
  getTodayAppointments,
  insertCallLog,
};