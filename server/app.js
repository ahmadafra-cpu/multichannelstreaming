"use strict";
/**
 * Multi-Camera Live View — Express app (exported; the listener lives in server.js).
 *
 * Runs in two shapes from the SAME code:
 *   - Long-running server (Docker / VM / PaaS): server.js calls app.listen().
 *   - Vercel serverless function: api/index.js exports this app as the handler.
 *
 * Responsibilities: serve the static app, proxy the Trax one-service JSON-RPC API
 * with credentials injected SERVER-SIDE, and expose the live FLV streams either
 * directly (STREAM_MODE=direct, required on Vercel — serverless can't hold a long
 * stream open) or via a signed same-origin proxy (STREAM_MODE=proxy, firewall-proof).
 *
 * Sessions are STATELESS: the Trax credentials are encrypted (AES-256-GCM) into the
 * token the client holds, so nothing needs to be stored server-side. Works across
 * serverless invocations and multiple instances as long as SESSION_SECRET is stable.
 */

const path = require("path");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

// ---------------------------------------------------------------- config (env)
const ONE_SERVICE_URL = process.env.ONE_SERVICE_URL || "https://one-service.zenduit.com/api/";
const STREAM_HOST = process.env.STREAM_HOST || "streamax-api.zenduit.com";
const STREAM_PORT = Number(process.env.STREAM_PORT || 22001);
// 'direct' = browser connects straight to the camera host (works on serverless/Vercel).
// 'proxy'  = stream is proxied through this origin on 443 (firewall-proof; needs a
//            long-running host, NOT Vercel). Auto-picks 'direct' on Vercel.
const STREAM_MODE = (process.env.STREAM_MODE || (process.env.VERCEL ? "direct" : "proxy")).toLowerCase();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000); // 8h fallback cap
const STREAM_TOKEN_TTL_MS = Number(process.env.STREAM_TOKEN_TTL_MS || 2 * 60 * 1000);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const STREAM_SECRET = process.env.STREAM_SECRET || SESSION_SECRET;
const STATUS_CONCURRENCY = Number(process.env.STATUS_CONCURRENCY || 6);
const FRAME_ANCESTORS = (process.env.CSP_FRAME_ANCESTORS || "'self' https://*.zenduit.com").trim();
const TRUST_PROXY = process.env.TRUST_PROXY || "1";
const STREAM_ORIGIN = "https://" + STREAM_HOST + (STREAM_PORT === 443 ? "" : ":" + STREAM_PORT);

if (!process.env.SESSION_SECRET) {
  console.warn("[mcv] SESSION_SECRET not set — using a random per-boot secret. " +
    "On Vercel/serverless or multi-instance you MUST set SESSION_SECRET, or users get logged out on every cold start.");
}

const SKEY = crypto.createHash("sha256").update(SESSION_SECRET).digest(); // 32 bytes

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY === "false" ? false : (isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY)));

// ---------------------------------------------------------------- security headers / CSP
const connectSrc = ["'self'"];
const mediaSrc = ["'self'", "blob:"];
if (STREAM_MODE === "direct") { connectSrc.push(STREAM_ORIGIN); mediaSrc.push(STREAM_ORIGIN); }

app.use(helmet({
  frameguard: false,                       // embedding governed by CSP frame-ancestors
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],            // no inline script -> XSS hardened
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": mediaSrc,
      "connect-src": connectSrc,
      "font-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": FRAME_ANCESTORS.split(/\s+/),
      "upgrade-insecure-requests": [],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: "64kb" }));

// ---------------------------------------------------------------- rate limiting
// NOTE: on serverless the default memory store is per-warm-instance (best effort).
// For robust cross-instance limiting use a shared store (e.g. @upstash/ratelimit).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_MAX || 600),
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX || 20),
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req.ip || "") + "|" + ((req.body && typeof req.body.userName === "string") ? req.body.userName.toLowerCase() : ""),
  message: { error: "Too many sign-in attempts. Try again later." },
});

// ---------------------------------------------------------------- stateless session token
function makeToken(creds) {
  const upstreamExp = creds.sessionExpire ? Date.parse(creds.sessionExpire) : NaN;
  const exp = Math.min(isNaN(upstreamExp) ? Infinity : upstreamExp, Date.now() + SESSION_TTL_MS);
  const payload = Buffer.from(JSON.stringify({ c: creds, e: exp }), "utf8");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SKEY, iv);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}
function readToken(token) {
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", SKEY, iv);
    d.setAuthTag(tag);
    const obj = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
    if (!obj || !obj.c || !obj.e || Date.now() > obj.e) return null;
    return obj.c;
  } catch (e) { return null; }
}
function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}
function requireAuth(req, res, next) {
  const creds = readToken(bearer(req));
  if (!creds) return res.status(401).json({ error: "Not authenticated" });
  req.creds = creds;
  next();
}

// ---------------------------------------------------------------- one-service client
function callOne(method, params, withType) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  const body = withType ? { method, params, type: "trax" } : { method, params };
  return fetch(ONE_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "JSON-RPC=" + encodeURIComponent(JSON.stringify(body)),
    signal: ctrl.signal,
  }).then(async (res) => {
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { const er = new Error("Upstream error (" + res.status + ")"); er.status = 502; throw er; }
    if (data && data.error !== undefined) {
      const msg = typeof data.error === "string" ? data.error : (data.error && data.error.message) || "Request failed";
      const er = new Error(msg);
      er.status = /credential|session|not logged in|authenticate/i.test(msg) ? 401 : 400;
      throw er;
    }
    return data ? data.result : undefined;
  }).finally(() => clearTimeout(timer));
}
const getTrax = (creds, typeName, search) => callOne("Get", { typeName, search, credentials: creds }, true);

function pool(items, worker, concurrency) {
  return new Promise((resolve) => {
    let i = 0, active = 0, done = 0;
    const total = items.length, out = new Array(total);
    if (!total) return resolve(out);
    function next() {
      while (active < concurrency && i < total) {
        const idx = i++; active++;
        Promise.resolve(worker(items[idx], idx))
          .then((v) => { out[idx] = v; }).catch(() => { out[idx] = null; })
          .then(() => { active--; done++; (done === total) ? resolve(out) : next(); });
      }
    }
    next();
  });
}

// ---------------------------------------------------------------- signed stream URLs (proxy mode)
function signStream(streamPath) {
  const exp = Date.now() + STREAM_TOKEN_TTL_MS;
  const sig = crypto.createHmac("sha256", STREAM_SECRET).update(streamPath + "|" + exp).digest("hex");
  return exp + "." + sig;
}
function verifyStream(streamPath, token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot)), sig = token.slice(dot + 1);
  if (!exp || Date.now() > exp) return false;
  const expect = crypto.createHmac("sha256", STREAM_SECRET).update(streamPath + "|" + exp).digest("hex");
  try { return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expect, "hex")); }
  catch (e) { return false; }
}

// =================================================================== routes
app.get("/healthz", (req, res) => res.json({ ok: true, streamMode: STREAM_MODE }));

app.post("/auth/login", loginLimiter, async (req, res) => {
  const { database, userName, password } = req.body || {};
  if (!database || !userName || !password) return res.status(400).json({ error: "database, userName and password are required" });
  try {
    const result = await callOne("Authenticate", { database, userName, password });
    const creds = result && result.credentials;
    if (!creds || !creds.sessionId) throw Object.assign(new Error("Authentication failed"), { status: 401 });
    res.json({ token: makeToken(creds), userName: creds.userName, database: creds.database });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: status === 401 ? "Incorrect database, username, or password." : (e.message || "Sign in failed") });
  }
});
app.post("/auth/logout", (req, res) => res.json({ ok: true })); // stateless: client just drops the token
app.get("/auth/me", apiLimiter, requireAuth, (req, res) => res.json({ userName: req.creds.userName, database: req.creds.database }));

app.get("/api/devices", apiLimiter, requireAuth, async (req, res) => {
  try {
    const types = (process.env.CAMERA_DEVICE_TYPES || "StreamMax").split(",").map((s) => s.trim()).filter(Boolean);
    const lists = await Promise.all(types.map((dt) => getTrax(req.creds, "Device", { deviceType: dt })));
    res.json([].concat(...lists.map((l) => l || [])));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post("/api/statuses", apiLimiter, requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.deviceIds) ? req.body.deviceIds.filter((x) => typeof x === "string").slice(0, 1000) : [];
  if (!ids.length) return res.json({});
  try {
    const results = await pool(ids, async (id) => {
      const r = await getTrax(req.creds, "DeviceStatusInfo", { deviceSearch: { id } });
      return (r && r[0]) || null;
    }, STATUS_CONCURRENCY);
    const out = {};
    ids.forEach((id, i) => { if (results[i]) out[id] = results[i]; });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post("/api/livemedia", apiLimiter, requireAuth, async (req, res) => {
  const deviceId = req.body && req.body.deviceId;
  if (typeof deviceId !== "string" || !deviceId) return res.status(400).json({ error: "deviceId required" });
  try {
    const media = await getTrax(req.creds, "LiveMedia", { device: { id: deviceId } });
    const channels = (Array.isArray(media) ? media : []).map((m) => {
      let u; try { u = new URL(m.url); } catch (e) { return null; }
      if (u.hostname !== STREAM_HOST) return null;          // only ever expose the known stream host
      if (!/^\/video\/[\w.-]+\.flv$/.test(u.pathname)) return null;
      if (STREAM_MODE === "direct") return { channel: m.channel, url: m.url };
      return { channel: m.channel, url: "/stream" + u.pathname + "?t=" + signStream(u.pathname) };
    }).filter(Boolean);
    res.json(channels);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// FLV proxy (used only in STREAM_MODE=proxy; requires a long-running host, not serverless)
app.get(/^\/stream\/video\/[\w.-]+\.flv$/, (req, res) => {
  const streamPath = req.path.replace(/^\/stream/, "");
  if (!verifyStream(streamPath, req.query.t)) return res.status(403).end("forbidden");
  const upstream = https.request({
    host: STREAM_HOST, port: STREAM_PORT, path: streamPath, method: "GET",
    headers: { "User-Agent": "mcv-proxy", "Accept": "*/*" },
  }, (r) => {
    res.writeHead(r.statusCode || 502, { "Content-Type": r.headers["content-type"] || "video/x-flv", "Cache-Control": "no-store" });
    r.pipe(res);
    r.on("error", () => res.destroy());
  });
  upstream.on("error", () => { if (!res.headersSent) res.status(502).end("upstream error"); else res.destroy(); });
  req.on("close", () => upstream.destroy());
  upstream.end();
});

// static app (served by the platform on Vercel; by Express on Docker/VM)
const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR, {
  index: "index.html",
  setHeaders: (res, p) => { if (p.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache"); },
}));
app.get("*", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.locals.config = { ONE_SERVICE_URL, STREAM_HOST, STREAM_PORT, STREAM_MODE, FRAME_ANCESTORS };
module.exports = app;
