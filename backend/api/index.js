/**
 * api/index.js
 * Vercel entry point. Vercel treats every file in /api as a serverless
 * function. This one just re-exports your existing Express app — combined
 * with the rewrite rule in vercel.json (which sends ALL paths to this
 * function), your original routes keep working unchanged:
 *
 *   /api/check-availability
 *   /api/book-appointment
 *   /api/update-appointment
 *   /api/vapi-system
 *   /api/dentists, etc.
 */

const app = require("../server");

module.exports = app;