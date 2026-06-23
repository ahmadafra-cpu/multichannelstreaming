// Vercel serverless entrypoint. vercel.json rewrites /auth/*, /api/*, /healthz
// (and /stream/* if used) to this function; the exported Express app handles them.
module.exports = require("../server/app.js");
