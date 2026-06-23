/**
 * Bright Smile Dental Voice Agent — API Tests
 * Run with: node tests/api-test.js
 * Make sure your backend is running on localhost:3000 before running tests.
 *
 * Each test owns its own year (2030–2035) so date/slot conflicts are
 * impossible no matter how many times the suite is run.
 */

const BASE_URL = "http://localhost:3000";

let passed = 0;
let failed = 0;

// ─── Fixed dates — each test group owns a unique year ────────────────────────
// Verified with Date arithmetic: day-of-week is correct for every entry.
//
//  SUNDAY (clinic closed)  : 2099-01-04  Sunday  ✓
//  AVAILABILITY / BOOK     : 2030-06-03  Monday  ✓  (Dr. Priya works Mon ✓)
//  DUPLICATE SLOT          : 2032-06-02  Wednesday ✓
//  RESCHEDULE source       : 2031-06-02  Monday  ✓
//  RESCHEDULE target       : 2035-06-04  Monday  ✓  (different year = no conflict)
//  RESCHEDULE-SUN source   : 2034-06-06  Tuesday ✓
//  CHANGE DENTIST          : 2032-06-02  Wednesday ✓ (Kavya: Wed/Thu/Fri/Sat ✓)
//  CANCEL                  : 2033-06-04  Saturday ✓
//  DOUBLE-CANCEL source    : 2035-06-04  Monday  ✓  (same year as reschedule target,
//                                                      different time slot)
//  NO-ACTION source        : 2034-06-06  Tuesday ✓  (same year as reschedule-sun,
//                                                      different time slot)
//  LOOKUP                  : 2033-06-04  Saturday ✓  (same year as cancel,
//                                                      different time slot)

const SUN = "2099-01-04"; // Sunday  — clinic always closed

const DATES = {
  // availability & basic booking — Monday 2030
  availability:     "2030-06-03",
  booking:          "2030-06-03",

  // duplicate slot test — Wednesday 2032 (shares with changeDentist but different times)
  duplicateSlot:    "2032-06-02",

  // reschedule — source Monday 2031, target Monday 2035
  reschedule:       "2031-06-02",
  rescheduleTarget: "2035-06-04",

  // reschedule-to-sunday source — Tuesday 2034 (shares with noAction, diff time)
  rescheduleSunSrc: "2034-06-06",

  // changeDentist — Wednesday 2032 (Kavya works Wed ✓; shares with duplicate, diff time)
  changeDentist:    "2032-06-02",

  // cancel — Saturday 2033 (shares with lookup, diff time)
  cancel:           "2033-06-04",

  // double-cancel source — Monday 2035 (shares with rescheduleTarget, diff time)
  doubleCancelSrc:  "2035-06-04",

  // no-action source — Tuesday 2034 (shares with rescheduleSunSrc, diff time)
  noActionSrc:      "2034-06-06",

  // lookup — Saturday 2033 (shares with cancel, diff time)
  lookup:           "2033-06-04",

  // all Sunday tests use the same fixed Sunday
  sun: SUN,
};

// Slot assignments — dates that are shared between tests get different time slots:
//
//  2030-06-03 Mon : 09:00 (book basic), 11:00 (book dentist pref)
//  2031-06-02 Mon : 09:00 (reschedule source)
//  2032-06-02 Wed : 02:00 (duplicate x2), 12:00 (changeDentist success), 03:00 (changeDentist fail)
//  2033-06-04 Sat : 09:00 (cancel), 10:00 (lookup)
//  2034-06-06 Tue : 09:00 (reschedule-to-sun source), 10:00 (no-action source)
//  2035-06-04 Mon : 11:00 (reschedule target), 02:00 (double-cancel source)

// ─── Test runner ──────────────────────────────────────────────────────────────
async function test(name, fn) {
  try {
    await fn();
    console.log(` ${name}`);
    passed++;
  } catch (err) {
    console.log(` ${name}`);
    console.log(`   → ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

// Admin API key for protected routes — reads from env so the key is never
// hardcoded in source. Run with: ADMIN_API_KEY=yourkey node tests/api-test.js
const AUTH = { "x-api-key": process.env.ADMIN_API_KEY || "" };

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// Optional headers argument — pass AUTH for admin endpoints.
async function get(path, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  return { status: res.status, data: await res.json() };
}

// Helper: book a fresh appointment and return its bookingRef.
async function createAppointment(overrides = {}) {
  const { status, data } = await post("/api/book-appointment", overrides);
  if (status !== 201 || !data.bookingRef) {
    throw new Error(
      `createAppointment helper failed (status ${status}): ${data.message}`
    );
  }
  return data.bookingRef;
}

// ─── Cleanup — cancel all test appointments from previous runs ────────────────
// Test phone numbers are in the range 9800000010–9800000030.
// This cancels any confirmed appointments left over from prior runs so
// slots are free before the suite begins. Safe to run repeatedly.
async function cleanupTestAppointments() {
  const { status, data } = await get("/api/appointments", AUTH);
  if (status !== 200) {
    console.warn(" Cleanup skipped — could not fetch appointments (auth issue?)");
    return;
  }

  const testPhones = new Set(
    Array.from({ length: 21 }, (_, i) => `980000001${String(i).padStart(1, "0")}`)
      .concat(["9800000030"])
  );

  // More robust: match any phone starting with 98000000
  const testAppointments = data.appointments.filter(
    (a) => a.status === "confirmed" && String(a.phone).startsWith("98000000")
  );

  let cleaned = 0;
  for (const appt of testAppointments) {
    await post("/api/update-appointment", {
      bookingRef: appt.bookingRef,
      action: "cancel",
    });
    cleaned++;
  }

  if (cleaned > 0) {
    console.log(` Cleaned up ${cleaned} leftover test appointment(s)\n`);
  }
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function runHealthCheck() {
  console.log("\nHealth Check");

  await test("GET / returns server status", async () => {
    const { status, data } = await get("/");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.status, "Missing status field");
  });
}

async function runCheckAvailabilityTests() {
  console.log("\nCheck Availability");

  await test("Valid weekday returns available slots", async () => {
    const { status, data } = await post("/api/check-availability", {
      date: DATES.availability, // Monday
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(Array.isArray(data.availableSlots), "Expected availableSlots array");
    assert(data.availableSlots.length > 0, "Expected at least one available slot");
  });

  await test("Sunday returns closed message", async () => {
    const { status, data } = await post("/api/check-availability", {
      date: DATES.sun,
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.available === false, "Expected available: false for Sunday");
    assert(
      data.message.toLowerCase().includes("sunday"),
      `Expected 'sunday' in message, got: ${data.message}`
    );
  });

  await test("Missing date returns 400", async () => {
    const { status, data } = await post("/api/check-availability", {});
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("With dentist preference returns availableDentists", async () => {
    const { status, data } = await post("/api/check-availability", {
      date:    DATES.availability,
      dentist: "Dr. Priya Sharma",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(
      Array.isArray(data.availableDentists),
      "Expected availableDentists array"
    );
  });

  await test("Short date format YY-MM-DD is handled", async () => {
    // "30-06-03" → "2030-06-03" (Monday)
    const { status, data } = await post("/api/check-availability", {
      date: "30-06-03",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
  });
}

async function runBookAppointmentTests() {
  console.log("\nBook Appointment");

  await test("Valid booking creates appointment and returns 4-digit ref", async () => {
    const { status, data } = await post("/api/book-appointment", {
      patientName: "Book Test Patient",
      phone:       "9800000010",
      date:        DATES.booking,  // Monday 2030
      time:        "09:00 AM",
      reason:      "Routine checkup",
    });
    assert(status === 201, `Expected 201, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(data.bookingRef, "Expected bookingRef in response");
    assert(data.bookingRef.length === 4, "Expected 4-digit bookingRef");
    assert(
      data.appointment.patientName === "Book Test Patient",
      "Wrong patient name"
    );
    assert(data.appointment.dentist, "Expected dentist to be assigned");
    console.log(`     → Booking ref: ${data.bookingRef}`);
  });

  await test("Missing required fields returns 400", async () => {
    const { status, data } = await post("/api/book-appointment", {
      patientName: "Incomplete Patient",
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("Sunday booking returns 400", async () => {
    const { status, data } = await post("/api/book-appointment", {
      patientName: "Sunday Patient",
      phone:       "9800000011",
      date:        DATES.sun,
      time:        "10:00 AM",
      reason:      "Checkup",
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("Duplicate slot returns 409", async () => {
    // Book 2032-06-02 Wed 02:00 PM, then try again
    const firstBook = await post("/api/book-appointment", {
      patientName: "First Duplicate Patient",
      phone:       "9800000012",
      date:        DATES.duplicateSlot, // Wednesday 2032
      time:        "02:00 PM",
      reason:      "Cleaning",
    });
    assert(
      firstBook.status === 201,
      `First booking failed (${firstBook.status}): ${firstBook.data.message}`
    );

    const { status, data } = await post("/api/book-appointment", {
      patientName: "Second Duplicate Patient",
      phone:       "9800000013",
      date:        DATES.duplicateSlot,
      time:        "02:00 PM",
      reason:      "Cleaning",
    });
    assert(status === 409, `Expected 409, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("With dentist preference assigns correct dentist", async () => {
    // Dr. Priya Sharma works Mon–Fri; booking date is Monday ✓
    const { status, data } = await post("/api/book-appointment", {
      patientName: "Dentist Pref Patient",
      phone:       "9800000014",
      date:        DATES.booking,  // Monday 2030 — 11:00 AM slot (09:00 already used)
      time:        "11:00 AM",
      reason:      "Teeth cleaning",
      dentist:     "Dr. Priya Sharma",
    });
    assert(status === 201, `Expected 201, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(
      data.appointment.dentist === "Dr. Priya Sharma",
      `Expected Dr. Priya Sharma, got ${data.appointment.dentist}`
    );
  });
}

async function runUpdateAppointmentTests() {
  console.log("\nUpdate Appointment");

  await test("Reschedule moves appointment to new date and time", async () => {
    const ref = await createAppointment({
      patientName: "Reschedule Patient",
      phone:       "9800000020",
      date:        DATES.reschedule,       // Monday 2031 — 09:00 AM
      time:        "09:00 AM",
      reason:      "Checkup",
    });

    const { status, data } = await post("/api/update-appointment", {
      bookingRef: ref,
      action:     "reschedule",
      newDate:    DATES.rescheduleTarget,  // Monday 2035 — 11:00 AM
      newTime:    "11:00 AM",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(data.appointment.date === DATES.rescheduleTarget, "Date not updated");
    assert(data.appointment.time === "11:00 AM", "Time not updated");
    console.log(`     → Rescheduled ref: ${ref}`);
  });

  await test("Reschedule to Sunday returns 400", async () => {
    const ref = await createAppointment({
      patientName: "Sunday Reschedule Patient",
      phone:       "9800000021",
      date:        DATES.rescheduleSunSrc, // Tuesday 2034 — 09:00 AM
      time:        "09:00 AM",
      reason:      "Checkup",
    });

    const { status, data } = await post("/api/update-appointment", {
      bookingRef: ref,
      action:     "reschedule",
      newDate:    DATES.sun,
      newTime:    "10:00 AM",
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("changeDentist updates dentist when available on appointment day", async () => {
    // Wednesday 2032 — Dr. Kavya Nair works Wed/Thu/Fri/Sat ✓
    const ref = await createAppointment({
      patientName: "Dentist Change Patient",
      phone:       "9800000022",
      date:        DATES.changeDentist,    // Wednesday 2032 — 12:00 PM
      time:        "12:00 PM",
      reason:      "Checkup",
    });

    const { status, data } = await post("/api/update-appointment", {
      bookingRef: ref,
      action:     "changeDentist",
      newDentist: "Dr. Kavya Nair",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(
      data.appointment.dentist === "Dr. Kavya Nair",
      `Expected Dr. Kavya Nair, got ${data.appointment.dentist}`
    );
    console.log(`     → Dentist changed for ref: ${ref}`);
  });

  await test("changeDentist fails when dentist not available on appointment day", async () => {
    // Wednesday 2032 — Dr. Anita Rai works Tue/Thu/Sat only — NOT Wednesday ✗
    const ref = await createAppointment({
      patientName: "Bad Dentist Change Patient",
      phone:       "9800000023",
      date:        DATES.changeDentist,    // Wednesday 2032 — 03:00 PM
      time:        "03:00 PM",
      reason:      "Checkup",
    });

    const { status, data } = await post("/api/update-appointment", {
      bookingRef: ref,
      action:     "changeDentist",
      newDentist: "Dr. Anita Rai",
    });
    assert(status === 409, `Expected 409, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("Cancel marks appointment as cancelled", async () => {
    const ref = await createAppointment({
      patientName: "Cancel Patient",
      phone:       "9800000024",
      date:        DATES.cancel,           // Saturday 2033 — 09:00 AM
      time:        "09:00 AM",
      reason:      "Checkup",
    });

    const { status, data } = await post("/api/update-appointment", {
      bookingRef: ref,
      action:     "cancel",
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(data.appointment.status === "cancelled", "Status not cancelled");
    console.log(`     → Cancelled ref: ${ref}`);
  });

  await test("Cancel already-cancelled appointment returns 404", async () => {
    const ref = await createAppointment({
      patientName: "Double Cancel Patient",
      phone:       "9800000025",
      date:        DATES.doubleCancelSrc,  // Monday 2035 — 02:00 PM
      time:        "02:00 PM",
      reason:      "Checkup",
    });

    await post("/api/update-appointment", { bookingRef: ref, action: "cancel" });

    const { status, data } = await post("/api/update-appointment", {
      bookingRef: ref,
      action:     "cancel",
    });
    assert(status === 404, `Expected 404, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("Invalid bookingRef returns 404", async () => {
    const { status, data } = await post("/api/update-appointment", {
      bookingRef: "0000",
      action:     "cancel",
    });
    assert(status === 404, `Expected 404, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });

  await test("Missing action returns 400", async () => {
    const ref = await createAppointment({
      patientName: "No Action Patient",
      phone:       "9800000026",
      date:        DATES.noActionSrc,      // Tuesday 2034 — 10:00 AM
      time:        "10:00 AM",
      reason:      "Checkup",
    });

    const { status, data } = await post("/api/update-appointment", {
      bookingRef: ref,
    });
    assert(status === 400, `Expected 400, got ${status}`);
    assert(data.success === false, "Expected success: false");
  });
}

async function runGetAppointmentsTests() {
  console.log("\n Get Appointments");

  await test("GET /api/appointments returns appointments array with count", async () => {
    const { status, data } = await get("/api/appointments", AUTH);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(Array.isArray(data.appointments), "Expected appointments array");
    assert(typeof data.count === "number", "Expected count field");
  });

  await test("GET /api/appointments/ref/:ref returns correct appointment", async () => {
    const ref = await createAppointment({
      patientName: "Lookup Patient",
      phone:       "9800000030",
      date:        DATES.lookup,           // Saturday 2033 — 10:00 AM
      time:        "10:00 AM",
      reason:      "Cleaning",
    });

    const res  = await fetch(`${BASE_URL}/api/appointments/ref/${ref}`, { headers: AUTH });
    const data = await res.json();
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(data.success === true, "Expected success: true");
    assert(data.appointment.bookingRef === ref, "Wrong booking ref returned");
    assert(
      data.appointment.patientName === "Lookup Patient",
      "Wrong patient name returned"
    );
  });

  await test("GET /api/appointments/ref/0000 returns 404", async () => {
    const res = await fetch(`${BASE_URL}/api/appointments/ref/0000`, { headers: AUTH });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });
}

async function runDentistTests() {
  console.log("\n Dentists");

  await test("GET /api/dentists returns exactly 5 dentists", async () => {
    const { status, data } = await get("/api/dentists", AUTH);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.success === true, "Expected success: true");
    assert(
      data.dentists.length === 5,
      `Expected 5 dentists, got ${data.dentists.length}`
    );
  });

  await test("GET /api/dentists/available on Monday returns dentists", async () => {
    const res  = await fetch(`${BASE_URL}/api/dentists/available?date=2030-06-03`, { headers: AUTH });
    const data = await res.json();
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(data.success === true, "Expected success: true");
    assert(data.dentists.length > 0, "Expected dentists on Monday");
  });

  await test("GET /api/dentists/available on Sunday returns empty list", async () => {
    const res  = await fetch(`${BASE_URL}/api/dentists/available?date=${DATES.sun}`, { headers: AUTH });
    const data = await res.json();
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(data.dentists.length === 0, "Expected 0 dentists on Sunday");
  });

  await test("Dr. Priya Sharma available on weekdays, not Sunday", async () => {
    const { data } = await get("/api/dentists", AUTH);
    const priya = data.dentists.find((d) => d.name === "Dr. Priya Sharma");
    assert(priya, "Dr. Priya Sharma not found");
    assert(priya.availableDays.includes("monday"), "Expected available Monday");
    assert(!priya.availableDays.includes("sunday"), "Should not be available Sunday");
  });

  await test("Dr. Kavya Nair available on Wednesday", async () => {
    const { data } = await get("/api/dentists", AUTH);
    const kavya = data.dentists.find((d) => d.name === "Dr. Kavya Nair");
    assert(kavya, "Dr. Kavya Nair not found");
    assert(kavya.availableDays.includes("wednesday"), "Expected available Wednesday");
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("Bright Smile Dental — API Test Suite");
  console.log("═══════════════════════════════════════════════");
  console.log(`   Backend: ${BASE_URL}`);
  console.log(`   Note: Each test owns its own year (2030–2035)`);
  console.log(`         so slot conflicts are impossible.`);
  console.log(`   Run:  ADMIN_API_KEY=yourkey node tests/api-test.js\n`);
  if (!process.env.ADMIN_API_KEY) {
    console.warn("ADMIN_API_KEY not set — admin route tests will return 401\n");
  }

  try {
    await cleanupTestAppointments();
    await runHealthCheck();
    await runCheckAvailabilityTests();
    await runBookAppointmentTests();
    await runUpdateAppointmentTests();
    await runGetAppointmentsTests();
    await runDentistTests();
  } catch (err) {
    console.error("\nFatal error:", err.message);
  }

  console.log("\n═══════════════════════════════════════════════");
  console.log(`   Results: ${passed} passed, ${failed} failed`);
  console.log(`   Total:   ${passed + failed} tests`);
  if (failed === 0) {
    console.log("   Status:  All tests passed!");
  } else {
    console.log("   Status:  Some tests failed");
  }
  console.log("═══════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();