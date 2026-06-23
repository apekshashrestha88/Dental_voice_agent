/**
 * db.js
 * Opens (or creates) dental.db, creates tables on first run, seeds dentists.
 * Every other file does: const db = require('./db')
 *
 * better-sqlite3 is synchronous by design — no callbacks, no .then().
 * All reads and writes are atomic at the SQLite level, so the write-queue
 * hack from the JSON version is no longer needed.
 */

const Database = require("better-sqlite3");
const path     = require("path");

const db = new Database(path.join(__dirname, "dental.db"));

// WAL mode: readers and writers no longer block each other.
// Single most impactful pragma for any web-server workload.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dentists (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    specialty      TEXT NOT NULL,
    available_days TEXT NOT NULL   -- JSON array, e.g. '["monday","tuesday"]'
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id                 TEXT PRIMARY KEY,
    booking_ref        TEXT UNIQUE NOT NULL,
    patient_name       TEXT NOT NULL,
    phone              TEXT NOT NULL,
    date               TEXT NOT NULL,   -- YYYY-MM-DD
    time               TEXT NOT NULL,   -- e.g. "10:00 AM"
    reason             TEXT NOT NULL,
    dentist            TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'confirmed',
    created_at         TEXT NOT NULL,
    rescheduled_at     TEXT,
    cancelled_at       TEXT,
    dentist_updated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_appt_date   ON appointments(date);
  CREATE INDEX IF NOT EXISTS idx_appt_ref    ON appointments(booking_ref);
  CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);

  CREATE TABLE IF NOT EXISTS call_logs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id          TEXT NOT NULL,
    ended_at         TEXT NOT NULL,
    ended_reason     TEXT,
    duration_seconds INTEGER,
    cost             TEXT,
    summary          TEXT,
    transcript       TEXT,
    recording_url    TEXT
  );
`);

// ─── Seed dentists (INSERT OR IGNORE — safe to run on every startup) ──────────
const seedDentist = db.prepare(`
  INSERT OR IGNORE INTO dentists (id, name, specialty, available_days)
  VALUES (@id, @name, @specialty, @availableDays)
`);

const seedAll = db.transaction((rows) => {
  for (const row of rows) seedDentist.run(row);
});

seedAll([
  {
    id: "d1",
    name: "Dr. Priya Sharma",
    specialty: "General Dentist",
    availableDays: JSON.stringify(["monday","tuesday","wednesday","thursday","friday"]),
  },
  {
    id: "d2",
    name: "Dr. Sanjay Verma",
    specialty: "Orthodontist",
    availableDays: JSON.stringify(["monday","wednesday","friday","saturday"]),
  },
  {
    id: "d3",
    name: "Dr. Anita Rai",
    specialty: "Pediatric Dentist",
    availableDays: JSON.stringify(["tuesday","thursday","saturday"]),
  },
  {
    id: "d4",
    name: "Dr. Rohan Mehta",
    specialty: "Cosmetic Dentist",
    availableDays: JSON.stringify(["monday","tuesday","thursday","friday"]),
  },
  {
    id: "d5",
    name: "Dr. Kavya Nair",
    specialty: "Endodontist",
    availableDays: JSON.stringify(["wednesday","thursday","friday","saturday"]),
  },
]);

// ─── Helper: deserialize a dentist row from the DB ───────────────────────────
// available_days is stored as a JSON string; parse it back to an array
// so callers get the same shape as the old appointments.json dentist objects.
function parseDentist(row) {
  if (!row) return null;
  return { ...row, availableDays: JSON.parse(row.available_days) };
}

db.parseDentist = parseDentist;

module.exports = db;