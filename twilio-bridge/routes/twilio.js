const express = require('express');
const router = express.Router();
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_PHONE_NUMBER,
  TWILIO_APP_SID,       // You'll add this after creating your TwiML App
  SUPPORT_PHONE_NUMBER, // The number your kiosk calls
} = process.env;

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── Validate required env vars on startup ────────────────────────────────────
const required = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_PHONE_NUMBER',
  'SUPPORT_PHONE_NUMBER',
  'BACKUP_PHONE_NUMBER'
];

required.forEach((key) => {
  if (!process.env[key]) {
    console.warn(`⚠️  Missing env var: ${key}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/twilio/voice-token
// Called by the frontend (CheckReservation.jsx) on mount.
// Returns a short-lived JWT that authorises the browser to make/receive calls.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/voice-token', (req, res) => {
  try {
    const identity = req.body.identity || 'kiosk-user';

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: TWILIO_APP_SID, // Links to your TwiML App
      incomingAllow: true,                     // Allows inbound calls to reach this browser
    });

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      {
        identity,
        ttl: 3600, // Token valid for 1 hour,
        region:'sg1', // Use 'sg1' for Asia Pacific, 'us1' for US, etc. (optional but recommended)
      }
    );

    token.addGrant(voiceGrant);

    console.log(`[voice-token] Issued token for identity: ${identity}`);
    res.json({ token: token.toJwt(), identity });

  } catch (err) {
    console.error('[voice-token] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate voice token' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/twilio/voice
// This is your TwiML App's "Voice Request URL".
// Twilio calls this endpoint when the browser initiates an outbound call.
// We respond with TwiML that dials the support number.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/voice', (req, res) => {
  console.log('To from frontend:', req.body.To);
  console.log('Caller ID:', TWILIO_PHONE_NUMBER);
  console.log('Support number:', SUPPORT_PHONE_NUMBER);

  const twiml = new VoiceResponse();
  const dial = twiml.dial({ callerId: TWILIO_PHONE_NUMBER });
  dial.number(SUPPORT_PHONE_NUMBER);

  console.log('TwiML generated:', twiml.toString());  // ← add this

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/twilio/inbound
// Set this as your Twilio phone number's incoming call webhook.
// Handles calls made TO your Twilio number (e.g. someone calling the kiosk).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/inbound', (req, res) => {
  const from = req.body.From;
  console.log(`[inbound] Incoming call from: ${from}`);

  const twiml = new VoiceResponse();

  // Forward inbound calls to the browser client named 'kiosk-user'
  const dial = twiml.dial();
  dial.client('kiosk-user');

  // Optional: if nobody answers in 20s, play a message
  twiml.say('No one is available at the kiosk. Please try again later.');

  res.type('text/xml');
  res.send(twiml.toString());
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/twilio/status
// Optional: Twilio calls this with real-time call status updates.
// Set this as the "Status Callback URL" on your TwiML App or phone number.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/status', (req, res) => {
  const { CallSid, CallStatus, From, To, Duration } = req.body;

  console.log(`[status] CallSid: ${CallSid} | Status: ${CallStatus} | From: ${From} | To: ${To} | Duration: ${Duration || 'N/A'}s`);

  // You can save this to a database here if needed
  // e.g. db.calls.insert({ CallSid, CallStatus, From, To, Duration, timestamp: new Date() })

  res.sendStatus(200); // Twilio expects a 200 response
});

module.exports = router;