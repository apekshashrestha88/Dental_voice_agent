/**
 * vapi-webhook.js
 * Vapi server-side webhook handler for Bright Smile Dental Voice Agent.
 *
 * Mount this in your Express app as:
 *   app.use('/api/vapi-system', require('./vapi-webhook'));
 *
 * Vapi calls this URL for every call lifecycle event.
 * Main responsibilities:
 *   1. Inject today's / tomorrow's date into the assistant's system prompt variables
 *   2. Log call events for debugging
 *   3. Persist end-of-call transcripts / summaries for audit trail
 */

const express = require('express');
const router = express.Router();
const db = require('./db');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns date strings Vapi injects into the assistant's system prompt.
 * The assistant prompt uses {{today_date}}, {{today_iso}}, {{tomorrow_day}},
 * and {{tomorrow_iso}} — all resolved here at call-start time so the assistant
 * always has the correct current date, not a stale build-time value.
 */
function getDateVariables() {
  const now = new Date();

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toNatural = (d) =>
    `${dayNames[d.getDay()]}, ${monthNames[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;

  return {
    today_date: toNatural(now),       // e.g. "Sunday, June 22 2026"
    today_iso: toISO(now),            // e.g. "2026-06-22"
    tomorrow_day: dayNames[tomorrow.getDay()], // e.g. "Monday"
    tomorrow_iso: toISO(tomorrow),    // e.g. "2026-06-23"
  };
}


// ─── Main Webhook Endpoint ────────────────────────────────────────────────────

/**
 * POST /api/vapi-system
 *
 * Vapi sends all call events here. The event type is in req.body.message.type.
 *
 * Handled event types:
 *   assistant-request   — Vapi asks for assistant config at call start.
 *                         We return dynamic date variables to inject into the prompt.
 *   status-update       — Call lifecycle updates (ringing, in-progress, ended).
 *   end-of-call-report  — Full transcript + summary after the call ends.
 *   transcript          — Real-time partial transcript chunks (optional logging).
 *   tool-calls          — Only fires if tools are set to "server" mode in Vapi.
 *                         In this project tools use "apiRequest" mode (direct HTTP),
 *                         so this block is included as a safety net / future hook.
 *   hang                — Vapi signals the assistant has been silent too long.
 */
router.post('/', (req, res) => {
  const message = req.body?.message;

  if (!message) {
    return res.status(400).json({ error: 'No message in request body' });
  }

  const { type, call } = message;
  const callId = call?.id || 'unknown';

  console.log(`\n📞 Vapi webhook — type: ${type} | callId: ${callId}`);

  // ── 1. assistant-request ──────────────────────────────────────────────────
  // Vapi fires this at the very start of a call when the assistant has
  // {{variable}} placeholders in its system prompt.  We return the values
  // to substitute so the assistant knows today's actual date.
  if (type === 'assistant-request') {
    const vars = getDateVariables();
    console.log('   Injecting date variables:', vars);

    return res.status(200).json({
      assistantOverrides: {
        variableValues: vars,
      },
    });
  }

  // ── 2. status-update ─────────────────────────────────────────────────────
  // Useful for logging call progress. No action required.
  if (type === 'status-update') {
    const status = message.status;
    console.log(`   Call status: ${status}`);
    return res.status(200).json({ received: true });
  }

  // ── 3. end-of-call-report ────────────────────────────────────────────────
  // Fired after every call ends. Contains the full transcript, summary,
  // duration, end reason, and cost. We persist this to appointments.json
  // so it's available in the admin dashboard for audit purposes.
  if (type === 'end-of-call-report') {
    const { summary, transcript, recordingUrl, endedReason, durationSeconds, cost } = message;

    console.log(`   Call ended — reason: ${endedReason} | duration: ${durationSeconds}s`);
    if (summary) console.log(`   Summary: ${summary}`);

    try {
      db.prepare(`
        INSERT INTO call_logs
          (call_id, ended_at, ended_reason, duration_seconds, cost, summary, transcript, recording_url)
        VALUES
          (@callId, @endedAt, @endedReason, @durationSeconds, @cost, @summary, @transcript, @recordingUrl)
      `).run({
        callId,
        endedAt:         new Date().toISOString(),
        endedReason:     endedReason     || null,
        durationSeconds: durationSeconds || null,
        cost:            cost != null ? String(cost) : null,
        summary:         summary         || null,
        transcript:      transcript      || null,
        recordingUrl:    recordingUrl    || null,
      });
      console.log('   ✅ Call log saved to dental.db');
    } catch (err) {
      // Non-fatal — log but don't fail the webhook response
      console.error('   ⚠️  Failed to save call log:', err.message);
    }

    return res.status(200).json({ received: true });
  }

  // ── 4. transcript ────────────────────────────────────────────────────────
  // Real-time transcript chunks. Useful for live monitoring; skipped here
  // to keep noise down, but easy to enable.
  if (type === 'transcript') {
    // Uncomment to log live transcript:
    // const { role, transcript: chunk } = message;
    // console.log(`   [${role}] ${chunk}`);
    return res.status(200).json({ received: true });
  }

  // ── 5. tool-calls (server-side tool mode) ────────────────────────────────
  // Only fires if a tool is configured with type "function" (server mode)
  // rather than "apiRequest" (direct HTTP mode).  All tools in this project
  // use apiRequest, so this won't fire under normal operation — included as
  // a future extension point if you move to server-side tool handling.
  if (type === 'tool-calls') {
    const toolCallList = message.toolCallList || [];
    console.log(`   Tool calls received: ${toolCallList.map(t => t.function?.name).join(', ')}`);

    // Return empty results — tools should be handled by their own API endpoints
    const results = toolCallList.map((tc) => ({
      toolCallId: tc.id,
      result: 'Tool is handled server-side via apiRequest — this handler is a no-op.',
    }));

    return res.status(200).json({ results });
  }

  // ── 6. hang ───────────────────────────────────────────────────────────────
  // Vapi fires this when the assistant goes silent past silenceTimeoutSeconds.
  // Nothing to do on the backend for this — the assistant handles it via its
  // silence timeout config (set to 35s in assistant.json).
  if (type === 'hang') {
    console.log('   ⚠️  Assistant silence timeout triggered');
    return res.status(200).json({ received: true });
  }

  // ── Fallback for any other event types ────────────────────────────────────
  console.log(`   Unhandled event type: ${type}`);
  return res.status(200).json({ received: true });
});

module.exports = router;