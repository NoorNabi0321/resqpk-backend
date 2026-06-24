// Driver simulator for end-to-end testing without a second device.
// Logs in as the test driver, goes online near the patient, auto-accepts the
// next dispatch, drives to the patient, then advances arrived → en_route → completed.
//
// Usage (backend running, patient app open on the emulator):
//   node driver-sim.mjs
// Then trigger SOS on the patient app and watch. Ctrl+C to stop.
import { io } from 'socket.io-client';
import axios from 'axios';

const URL = process.env.SERVER_URL || 'http://localhost:3000';
const PHONE = process.env.DRIVER_PHONE || '03781980657';
const PASS = process.env.DRIVER_PASS || 'Driver1234!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await axios.post(`${URL}/api/auth/driver/login`, { phone: PHONE, password: PASS });
const token = login.data.data.token;
const auth = { headers: { Authorization: `Bearer ${token}` } };
console.log('Driver logged in:', login.data.data.driver?.vehicle_number);

const socket = io(URL, { auth: { token }, transports: ['websocket'] });

// Start ~150m from the patient's test location (Hyderabad).
let lat = 25.378;
let lng = 68.3675;
let handling = false;

socket.on('authenticated', () => {
  console.log('Connected. Going online near the patient...');
  socket.emit('driver:go_online', { lat, lng, heading: 0 }, (r) =>
    console.log('go_online:', JSON.stringify(r)),
  );
  console.log('\nReady — trigger SOS on the patient app now.\n');
});

socket.on('emergency:case_created', async (data) => {
  if (handling) return;
  handling = true;
  console.log(`\n🚨 Dispatch request ${data.caseNumber} (${data.distanceText})`);
  await axios.post(`${URL}/api/cases/respond`, { caseId: data.caseId, response: 'accepted' }, auth);
  console.log('✅ Accepted — driving to patient...');

  const caseId = data.caseId;
  const pLat = Number(data.patientLat);
  const pLng = Number(data.patientLng);

  for (let i = 1; i <= 6; i++) {
    lat += (pLat - lat) / (7 - i);
    lng += (pLng - lng) / (7 - i);
    socket.emit('driver:location_update', { lat, lng, heading: 45, speed: 35, caseId });
    console.log(`  -> moving ${i}/6: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    await sleep(3000);
  }

  await axios.put(`${URL}/api/cases/status`, { caseId, status: 'arrived' }, auth);
  console.log('📍 Arrived at patient');
  await sleep(4000);
  await axios.put(`${URL}/api/cases/status`, { caseId, status: 'en_route' }, auth);
  console.log('🚑 En route to hospital');
  await sleep(6000);
  await axios.put(`${URL}/api/cases/status`, { caseId, status: 'completed' }, auth);
  console.log('🏁 Completed');
  handling = false;
});

socket.on('connect_error', (e) => console.log('connect_error:', e.message));
console.log('Driver simulator running. Ctrl+C to stop.');
