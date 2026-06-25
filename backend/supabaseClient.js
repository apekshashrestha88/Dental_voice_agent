/**
 * supabaseClient.js
 * Replaces the old db.js (better-sqlite3 connection).
 *
 * Why this exists: Vercel serverless functions have an ephemeral filesystem
 * and spin up fresh instances per request, so a local SQLite file can't be
 * relied on to persist data. Supabase (hosted Postgres) gives every
 * serverless invocation a shared, durable place to read/write.
 *
 * IMPORTANT: this uses the SERVICE ROLE key, which bypasses Row Level
 * Security. That's intentional here because this file is only ever
 * imported by server-side code (this Express app), never shipped to the
 * browser. Never expose SUPABASE_SERVICE_ROLE_KEY in any client-side code.
 */

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

module.exports = supabase;