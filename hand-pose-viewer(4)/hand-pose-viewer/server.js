// Hand pose server: serves the Three.js viewer and accepts poses via POST /pose.
// Zero dependencies. Run with:  node server.js   (Node 16+)
//
// Updates are pushed to every open viewer through Server-Sent Events (/events).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 1 << 20; // 1 MB

const PARTS = ['palm', 'thumb', 'index', 'middle', 'ring', 'pinky'];
const ALIASES = { little: 'pinky', pinkie: 'pinky', hand: 'palm', wrist: 'palm' };
const OPTION_KEYS = new Set(['space', 'order', 'mode', 'reset', 'hand', 'calibrated', 'pose', 'transforms']);
// 7 = pos + root quaternion; 11 / 15 = plus local quaternions for the 2nd / 3rd joint
const FINGER_LENGTHS = new Set([7, 11, 15]);

// Pose state, always stored in palm-local space, quaternions as [x, y, z, w].
// A part missing from `pose` is shown in its rest pose.
const state = { pose: {}, mode: 'distribute', seq: 0, updatedAt: null, calib: null };
const clients = new Set();

// ---------- quaternion helpers ([x, y, z, w]) ----------
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function qRotate(q, v) {
  const u = [q[0], q[1], q[2]];
  const t = cross(u, v).map((c) => 2 * c);
  const c2 = cross(u, t);
  return [v[0] + q[3] * t[0] + c2[0], v[1] + q[3] * t[1] + c2[1], v[2] + q[3] * t[2] + c2[2]];
}
function qNormalize(q, where) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 1e-9)) throw new HttpError(400, `${where}: quaternion has zero length`);
  return q.map((c) => c / l);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- request parsing ----------
function parseBody(text) {
  text = text.trim();
  if (!text) throw new HttpError(400, 'empty body');
  try { return JSON.parse(text); } catch { /* fall through to plain numbers */ }
  const nums = text.split(/[\s,;\[\]]+/).filter(Boolean).map(Number);
  if (!nums.length || nums.some((n) => !Number.isFinite(n))) {
    throw new HttpError(400, 'body is neither JSON nor a list of numbers');
  }
  return nums;
}

function partsFromArray(arr) {
  const parts = {};
  if (arr.length && arr.every((a) => Array.isArray(a) || a === null)) {
    if (arr.length > PARTS.length) throw new HttpError(400, `at most ${PARTS.length} transforms (palm, thumb, index, middle, ring, pinky)`);
    arr.forEach((a, i) => { parts[PARTS[i]] = a; });
    return parts;
  }
  if (arr.length % 7 !== 0 || arr.length === 0 || arr.length > 42) {
    throw new HttpError(400, `flat array must hold 7 floats per transform in the order ${PARTS.join(', ')} (got ${arr.length} values)`);
  }
  for (let i = 0; i < arr.length / 7; i++) parts[PARTS[i]] = arr.slice(i * 7, i * 7 + 7);
  return parts;
}

function extract(body) {
  if (Array.isArray(body)) return { parts: partsFromArray(body), options: {} };
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object or array');

  const options = { space: body.space, order: body.order, mode: body.mode, reset: body.reset, hand: body.hand, calibrated: body.calibrated };
  const src = body.pose ?? body.transforms ?? body;
  if (Array.isArray(src)) return { parts: partsFromArray(src), options };

  const parts = {};
  const unknown = [];
  for (const [rawKey, value] of Object.entries(src)) {
    const key = ALIASES[rawKey.toLowerCase()] ?? rawKey.toLowerCase();
    if (PARTS.includes(key)) parts[key] = value;
    else if (!(src === body && OPTION_KEYS.has(rawKey))) unknown.push(rawKey);
  }
  if (unknown.length) throw new HttpError(400, `unknown key(s): ${unknown.join(', ')}. Expected: ${PARTS.join(', ')}`);
  return { parts, options };
}

function pick(value, allowed, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const v = String(value).toLowerCase();
  if (!allowed.includes(v)) throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

function applyPose(parts, rawOpts) {
  const order = pick(rawOpts.order, ['xyzw', 'wxyz'], 'order') ?? 'xyzw';
  const space = pick(rawOpts.space, ['local', 'world'], 'space') ?? 'local';
  const mode = pick(rawOpts.mode, ['distribute', 'root'], 'mode');
  const reset = rawOpts.reset === true || rawOpts.reset === 'true' || rawOpts.reset === '1';

  // Validate everything before touching state.
  const next = {};
  for (const name of PARTS) {
    if (!(name in parts)) continue;
    const v = parts[name];
    if (v === null) { next[name] = null; continue; }
    const okLen = name === 'palm' ? v?.length === 7 : FINGER_LENGTHS.has(v?.length);
    if (!Array.isArray(v) || !okLen) {
      throw new HttpError(400, `${name}: expected ${name === 'palm' ? '7' : '7, 11 or 15'} floats [pos.x, pos.y, pos.z, q1, q2, q3, q4${name === 'palm' ? '' : ', ...'}]`);
    }
    const nums = v.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) throw new HttpError(400, `${name}: all values must be finite numbers`);
    const quats = [];
    for (let i = 3; i < nums.length; i += 4) {
      const q = nums.slice(i, i + 4);
      quats.push(qNormalize(order === 'wxyz' ? [q[1], q[2], q[3], q[0]] : q, name));
    }
    next[name] = { pos: nums.slice(0, 3), quats };
  }

  if (space === 'world' && !(state.calib && rawOpts.calibrated !== false)) {
    // Palm is the root, so its world transform is its local one. Fingers are converted into palm space.
    const prev = reset ? undefined : state.pose.palm;
    const palm = next.palm ?? (next.palm === null || !prev ? { pos: [0, 0, 0], quats: [[0, 0, 0, 1]] } : { pos: prev.slice(0, 3), quats: [prev.slice(3, 7)] });
    const inv = qConj(palm.quats[0]);
    for (const name of PARTS.slice(1)) {
      const p = next[name];
      if (!p) continue;
      p.pos = qRotate(inv, [p.pos[0] - palm.pos[0], p.pos[1] - palm.pos[1], p.pos[2] - palm.pos[2]]);
      p.quats[0] = qMul(inv, p.quats[0]); // extra joint quaternions are already parent-local
    }
  }

  if (state.calib && rawOpts.calibrated !== false) {
    // Calibrated: fingers arrive as raw glove data relative to the hub. Each finger's rotation since
    // the calibration pose is re-expressed in the viewer's axes and sent as a delta on top of the
    // viewer's rest pose. Positions are dropped (null = "use the viewer's rest knuckle").
    const missing = [];
    for (const name of PARTS.slice(1)) {
      const p = next[name];
      if (!p) continue;
      const qc = state.calib.q[name];
      if (!qc) { missing.push(name); continue; }
      next[name] = { pos: [null, null, null], quats: [toViewer(state.calib, name, p.quats[0])] };
    }
    if (missing.length) throw new HttpError(400, `not in the calibration pose: ${missing.join(', ')}. Recalibrate including them.`);
  }

  if (reset) state.pose = {};
  for (const [name, p] of Object.entries(next)) {
    if (p === null) delete state.pose[name];
    else state.pose[name] = [...p.pos, ...p.quats.flat()].map((n) => (n === null ? null : +n.toFixed(6)));
  }
  if (mode) state.mode = mode;
  state.seq++;
  state.updatedAt = Date.now();
  broadcast();
  return Object.keys(next);
}

// ---------- calibration ----------
// Hold an open, flat hand (fingers straight and together, thumb relaxed alongside) and POST it to
// /calibrate in the same format as /pose, with raw glove values relative to the hub.
// From the finger sensor positions the server finds the hand's axes in the hub frame:
//   +Y = toward the fingertips (mean direction of the finger sensors)
//   +X = toward the thumb side for a right hand (index minus pinky), pinky side for a left hand
//   +Z = X x Y = out of the palm, matching the viewer's rest hand.
// Each finger's orientation in that pose is stored as its neutral rotation.
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function vNormalize(v, what) {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 1e-6)) throw new HttpError(400, `calibration failed: ${what}`);
  return v.map((c) => c / l);
}
function quatFromRows(r0, r1, r2) { // rotation matrix given by its rows → [x, y, z, w]
  const [m11, m12, m13] = r0, [m21, m22, m23] = r1, [m31, m32, m33] = r2;
  const tr = m11 + m22 + m33;
  let q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]; }
  return qNormalize(q, 'axes');
}

// Works out the hand axes and neutral finger rotations from one open-hand frame. Pure: stores nothing.
function computeCalib(parts, order, hand) {
  const raw = {};
  for (const name of PARTS.slice(1)) {
    const v = parts[name];
    if (v == null) continue;
    if (!Array.isArray(v) || v.length < 7) throw new HttpError(400, `${name}: expected 7 floats`);
    const nums = v.slice(0, 7).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) throw new HttpError(400, `${name}: all values must be finite numbers`);
    const q = nums.slice(3, 7);
    raw[name] = { pos: nums.slice(0, 3), q: qNormalize(order === 'wxyz' ? [q[1], q[2], q[3], q[0]] : q, name) };
  }
  if (!raw.index || !raw.pinky) throw new HttpError(400, 'calibration needs at least index and pinky (their positions define the hand axes)');

  const fingers = ['index', 'middle', 'ring', 'pinky'].filter((n) => raw[n]);
  const mean = [0, 1, 2].map((i) => fingers.reduce((s, n) => s + raw[n].pos[i], 0) / fingers.length);
  const Y = vNormalize(mean, 'finger sensors sit at the hub, cannot tell where the fingertips point');
  const across = hand === 'right' ? sub(raw.index.pos, raw.pinky.pos) : sub(raw.pinky.pos, raw.index.pos);
  const d = dot(across, Y);
  const X = vNormalize([across[0] - d * Y[0], across[1] - d * Y[1], across[2] - d * Y[2]], 'index and pinky sensors are not side by side');
  const Z = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];

  const r3 = (v) => v.map((c) => +c.toFixed(3));
  return {
    calib: { hand, qA: quatFromRows(X, Y, Z), q: Object.fromEntries(Object.entries(raw).map(([n, r]) => [n, r.q])) },
    fingers: Object.keys(raw),
    // The hand's axes expressed in your glove's hub frame, handy for sanity-checking.
    axesInHubFrame: { fingertips: r3(Y), sideways: r3(X), outOfPalm: r3(Z) },
  };
}

// A finger's raw hub-frame rotation → rotation since calibration, in the viewer's axes.
function toViewer(calib, name, q) {
  const dHub = qMul(q, qConj(calib.q[name]));
  return qMul(qMul(calib.qA, dHub), qConj(calib.qA));
}

function calibrate(parts, rawOpts) {
  const order = pick(rawOpts.order, ['xyzw', 'wxyz'], 'order') ?? 'xyzw';
  const hand = pick(rawOpts.hand, ['right', 'left'], 'hand') ?? 'right';
  const { calib, fingers, axesInHubFrame } = computeCalib(parts, order, hand);
  state.calib = calib;
  // Show the calibration pose itself: every calibrated finger at rest.
  for (const n of fingers) state.pose[n] = [null, null, null, 0, 0, 0, 1];
  state.seq++;
  state.updatedAt = Date.now();
  broadcast();
  return { hand, fingers, axesInHubFrame };
}

// ---------- recorded signs (signs.csv) ----------
// One row per sign: a label, then 42 numbers = 6 blocks of [pos.x, pos.y, pos.z, qx, qy, qz, qw],
// relative to the glove hub, in the order below. The row labelled SIGN_NEUTRAL (an open, relaxed hand)
// calibrates the recording, so the signs display correctly whatever live calibration is active.
const SIGNS_FILE = process.env.SIGNS_FILE || path.join(__dirname, 'signs.csv');
const SIGN_ORDER = ['wrist', 'index', 'pinky', 'middle', 'ring', 'thumb'];
const SIGN_NEUTRAL = '0';

function loadSigns() {
  let text;
  try { text = fs.readFileSync(SIGNS_FILE, 'utf8'); }
  catch { throw new HttpError(404, `no sign file at ${SIGNS_FILE}`); }
  const rows = {};
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 43 || !cols[0]) continue;
    const nums = cols.slice(-42).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    rows[cols[0].toLowerCase()] = Object.fromEntries(SIGN_ORDER.map((n, i) => [n, nums.slice(i * 7, i * 7 + 7)]));
  }
  if (!rows[SIGN_NEUTRAL]) throw new HttpError(400, `${SIGNS_FILE} has no "${SIGN_NEUTRAL}" row to calibrate from`);
  const { calib } = computeCalib(rows[SIGN_NEUTRAL], 'xyzw', 'right');
  const signs = {};
  for (const [label, parts] of Object.entries(rows)) {
    signs[label] = {};
    for (const f of PARTS.slice(1)) {
      if (!parts[f] || !calib.q[f]) continue;
      const q = qNormalize(parts[f].slice(3, 7), `${label}/${f}`);
      signs[label][f] = [null, null, null, ...toViewer(calib, f, q).map((n) => +n.toFixed(5))];
    }
  }
  return signs;
}

// ---------- SSE ----------
const snapshot = () => JSON.stringify({ seq: state.seq, mode: state.mode, pose: state.pose, hand: state.calib?.hand ?? null, calibrated: !!state.calib });
function broadcast() {
  const msg = `data: ${snapshot()}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();

// ---------- HTTP ----------
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 1000\ndata: ${snapshot()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/signs' && req.method === 'GET') {
      send(res, 200, { ok: true, signs: loadSigns() }); // re-read every time, so edits to the file show up
      return;
    }

    if (url.pathname === '/calibrate') {
      if (req.method === 'GET') { send(res, 200, { calibrated: !!state.calib, calib: state.calib }); return; }
      if (req.method === 'DELETE') {
        state.calib = null;
        applyPose({}, { reset: true });
        send(res, 200, { ok: true, calibrated: false });
        return;
      }
      if (req.method === 'POST') {
        const { parts, options } = extract(parseBody(await readBody(req)));
        for (const k of ['order', 'hand']) {
          if (options[k] === undefined && url.searchParams.has(k)) options[k] = url.searchParams.get(k);
        }
        send(res, 200, { ok: true, ...calibrate(parts, options) });
        return;
      }
      send(res, 405, { ok: false, error: 'use GET, POST or DELETE' });
      return;
    }

    if (url.pathname === '/pose') {
      if (req.method === 'GET') { send(res, 200, { ...state, calibrated: !!state.calib, viewers: clients.size }); return; }
      if (req.method === 'DELETE') { applyPose({}, { reset: true }); send(res, 200, { ok: true, seq: state.seq }); return; }
      if (req.method === 'POST') {
        const body = parseBody(await readBody(req));
        const { parts, options } = extract(body);
        // Query parameters (?space=world&order=wxyz&mode=root) act as defaults for body options.
        for (const k of ['space', 'order', 'mode', 'reset']) {
          if (options[k] === undefined && url.searchParams.has(k)) options[k] = url.searchParams.get(k);
        }
        const applied = applyPose(parts, options);
        send(res, 200, { ok: true, applied, seq: state.seq, viewers: clients.size });
        return;
      }
      send(res, 405, { ok: false, error: 'use GET, POST or DELETE' });
      return;
    }

    send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    send(res, err.status || 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Hand viewer:   http://localhost:${PORT}/`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`               http://${a.address}:${PORT}/`);
  }
  console.log(`POST poses to: http://localhost:${PORT}/pose`);
});
