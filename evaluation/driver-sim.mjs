// Driver simulator — an ambulance on your laptop.
//
// Logs in as a real driver, goes online, accepts the next dispatch offer, drives
// towards the patient, and advances the case through arrival, pickup and
// hospital arrival. Everything a second phone would do.
//
// Usage:
//   node evaluation/driver-sim.mjs                      (production, Hyderabad centre)
//   node evaluation/driver-sim.mjs --local              (localhost:3000)
//   node evaluation/driver-sim.mjs --lat 25.40 --lng 68.37
//   node evaluation/driver-sim.mjs --manual             (do not auto-advance status)
//
// Credentials default to the seeded test driver; override with DRIVER_PHONE and
// DRIVER_PASSWORD. Ctrl+C goes offline cleanly.
import { io } from 'socket.io-client';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const API = flag('local')
  ? 'http://localhost:3000'
  : arg('api', 'https://resqpk-backend.onrender.com');
const PHONE = process.env.DRIVER_PHONE || '03781980657';
const PASSWORD = process.env.DRIVER_PASSWORD || 'Driver1234!';
const AUTO = !flag('manual');

// Hyderabad city centre unless told otherwise.
let lat = Number(arg('lat', 25.396));
let lng = Number(arg('lng', 68.3578));

const log = (msg) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status} on ${path}`);
  return json.data;
}

// --- 1. sign in --------------------------------------------------------------
log(`Connecting to ${API}`);
const auth = await api('/api/auth/driver/login', {
  method: 'POST',
  body: { phone: PHONE, password: PASSWORD },
});
const token = auth.token;
log(`Signed in as ${auth.user?.full_name || PHONE} (${auth.driver?.vehicle_number || 'no vehicle'})`);

// --- 2. connect and go online ------------------------------------------------
const socket = io(API, { auth: { token }, transports: ['websocket', 'polling'] });

socket.on('connect_error', (e) => log(`socket error: ${e.message}`));

await new Promise((resolve, reject) => {
  socket.on('authenticated', resolve);
  socket.on('connect_error', reject);
  setTimeout(() => reject(new Error('socket timed out — is the server awake?')), 30000);
});
log('Socket authenticated');

socket.emitWithAck('driver:go_online', { lat, lng, heading: 0 }).then((res) => {
  log(res?.success ? `Online at ${lat}, ${lng} — waiting for a dispatch offer…` : `go_online failed: ${res?.error}`);
});

// Keep the position fresh, exactly as the app does.
const heartbeat = setInterval(() => {
  socket.emit('driver:location_update', { lat, lng, heading: 0, speed: 0, caseId: activeCase?.caseId });
}, 5000);

// --- 3. accept the next offer ------------------------------------------------
let activeCase = null;
let busy = false;

socket.on('emergency:case_created', async (offer) => {
  if (busy) return log(`Ignoring offer for ${offer.caseNumber}: already on a case`);
  busy = true;
  log(`OFFER  ${offer.caseNumber} — ${offer.patientName}, ${offer.distanceText} away`);

  try {
    await api('/api/cases/respond', {
      method: 'POST',
      token,
      body: { caseId: offer.caseId, response: 'accepted' },
    });
    activeCase = { caseId: offer.caseId, caseNumber: offer.caseNumber };
    log(`ACCEPTED ${offer.caseNumber}`);

    await socket.emitWithAck('driver:join_case', { caseId: offer.caseId });

    // Drive towards the patient so the map actually moves.
    const target = { lat: Number(offer.patientLat), lng: Number(offer.patientLng) };
    if (Number.isFinite(target.lat)) {
      const steps = 10;
      const dLat = (target.lat - lat) / steps;
      const dLng = (target.lng - lng) / steps;
      for (let i = 0; i < steps; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        lat += dLat;
        lng += dLng;
        socket.emit('driver:location_update', { lat, lng, heading: 45, speed: 30, caseId: offer.caseId });
      }
      log('Reached the patient');
    }

    if (!AUTO) return log('Manual mode: advance with the status commands printed below');

    await advance('arrived', 'At the scene');
    await new Promise((r) => setTimeout(r, 8000));
    await advance('en_route', 'Patient loaded, heading to hospital');
    await new Promise((r) => setTimeout(r, 12000));
    await advance('completed', 'Arrived at hospital');

    log('Case finished. Still online for the next one.');
    activeCase = null;
    busy = false;
  } catch (err) {
    log(`Failed on ${offer.caseNumber}: ${err.message}`);
    busy = false;
  }
});

async function advance(status, label) {
  await api('/api/cases/status', { method: 'PUT', token, body: { caseId: activeCase.caseId, status } });
  log(`STATUS ${status} — ${label}`);
}

// Useful when watching a patient screen: these are the events the apps react to.
socket.on('emergency:hospital_changed', (d) => log(`Hospital chosen: ${d.hospitalName}`));
socket.on('case:accepted', (d) => log(`Hospital accepted the patient${d.preparationNote ? `: ${d.preparationNote}` : ''}`));
socket.on('case:redirected', (d) => log(`Hospital redirected the case: ${d.reason || 'no reason given'}`));
socket.on('emergency:case_cancelled', () => {
  log('Patient cancelled the request');
  activeCase = null;
  busy = false;
});

// --- 4. leave cleanly --------------------------------------------------------
async function shutdown() {
  clearInterval(heartbeat);
  try {
    await socket.emitWithAck('driver:go_offline', {});
    log('Went offline');
  } catch {
    /* already gone */
  }
  socket.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!AUTO) {
  log('Manual mode — type: arrived | en_route | completed | quit');
  process.stdin.on('data', async (buf) => {
    const cmd = buf.toString().trim();
    if (cmd === 'quit') return shutdown();
    if (!activeCase) return log('No active case');
    if (['arrived', 'en_route', 'completed'].includes(cmd)) {
      try {
        await advance(cmd, 'manual');
      } catch (err) {
        log(`Could not set ${cmd}: ${err.message}`);
      }
    }
    return null;
  });
}
