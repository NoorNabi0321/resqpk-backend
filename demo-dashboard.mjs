// Live dashboard demo: simulates a dispatched ambulance moving toward Civil
// Hospital so you can watch the hospital dashboard update in real time.
//
// Usage (with the backend running and the dashboard open + logged in):
//   node demo-dashboard.mjs
import axios from 'axios';

const URL = process.env.SERVER_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const login = await axios.post(`${URL}/api/auth/hospital/login`, {
    email: 'admin@civilhospital.resqpk.app',
    password: 'Admin@123',
  });
  const token = login.data.data.token;
  const hospitalId = login.data.data.hospital.id;
  const room = `hospital:${hospitalId}`;
  const headers = { Authorization: `Bearer ${token}` };
  const caseId = 'demo-case-' + Date.now();
  const driverId = 'demo-driver-1';

  const broadcast = (event, data) =>
    axios.post(`${URL}/api/realtime/test-broadcast`, { room, event, data }, { headers });

  console.log('Connected. Broadcasting to', room);
  console.log('Watch your dashboard now...\n');

  await broadcast('hospital:new_case', {
    id: caseId,
    case_number: 'RQ-DEMO-0001',
    patientName: 'Ahmed Raza',
    status: 'driver_assigned',
    urgency_level: 'critical',
    driver_id: driverId,
  });
  console.log('-> A CRITICAL case appeared on the dashboard');
  await sleep(2000);

  const hLat = 25.3792;
  const hLng = 68.3683;
  let lat = 25.355;
  let lng = 68.35;
  for (let i = 1; i <= 8; i++) {
    lat += (hLat - 25.355) / 8;
    lng += (hLng - 68.35) / 8;
    const durationSeconds = Math.max(30, 360 - i * 42);
    const durationText = `${Math.max(1, Math.round(durationSeconds / 60))} min`;
    await broadcast('hospital:ambulance_update', {
      caseId,
      driverId,
      driverLat: lat,
      driverLng: lng,
      durationSeconds,
      durationText,
    });
    console.log(`-> ambulance ${i}/8: ${lat.toFixed(4)}, ${lng.toFixed(4)} | ETA ${durationText}`);
    await sleep(2000);
  }

  console.log('\nDemo complete — the case ETA counted down and coordinates updated live.');
  process.exit(0);
} catch (e) {
  console.log('DEMO FAILED:', e.response?.data?.message || e.code || e.message);
  console.log('Make sure the backend is running (npm run dev) and the dashboard is open.');
  process.exit(1);
}
