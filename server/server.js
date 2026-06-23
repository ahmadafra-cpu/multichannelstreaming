"use strict";
// Long-running entrypoint (Docker / VM / PaaS). On Vercel this file is unused —
// api/index.js exports the app as a serverless function instead.
const app = require("./app");
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  const c = app.locals.config;
  console.log("[mcv] listening on :" + PORT);
  console.log("[mcv] one-service: " + c.ONE_SERVICE_URL);
  console.log("[mcv] stream: " + c.STREAM_HOST + ":" + c.STREAM_PORT + " (mode=" + c.STREAM_MODE + ")");
  console.log("[mcv] frame-ancestors: " + c.FRAME_ANCESTORS);
});
