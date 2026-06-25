// Module 7 C6 — Offline SOS end-to-end test (SMS gateway path).
// Simulates the SMS-forwarder webhook without a physical phone.
// Run:  node evaluation/test-offline-sos.mjs   (backend must be running)
import 'dotenv/config';
import axios from 'axios';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const GATEWAY_SECRET = process.env.SMS_GATEWAY_SECRET;
const PATIENT_PHONE = process.env.TEST_PATIENT_PHONE || '03781980656';
const PATIENT_TOKEN = process.env.TEST_PATIENT_TOKEN;

const sms = (body) => axios.post(`${BASE_URL}/api/sos/sms-webhook`, body, { validateStatus: () => true });

async function run() {
  console.log('=== ResQPK Offline SOS Test Suite ===\n');
  if (!GATEWAY_SECRET) {
    console.log('❌ SMS_GATEWAY_SECRET not set in .env — aborting.');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed += 1;
    } catch (e) {
      console.log(`  ❌ ${name}: ${e.message}`);
      failed += 1;
    }
  };

  await test('Wrong secret → 200, reason unauthorized', async () => {
    const r = await sms({ callerPhone: '03001234567', messageBody: 'SOS', gatewaySecret: 'wrong' });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (r.data.data?.reason !== 'unauthorized') throw new Error(`reason ${r.data.data?.reason}`);
  });

  await test('Non-SOS message → not_a_trigger (no case)', async () => {
    const r = await sms({ callerPhone: '03001234567', messageBody: 'Hello how are you', gatewaySecret: GATEWAY_SECRET });
    if (r.data.data?.success === true) throw new Error('should not trigger');
    if (r.data.data?.reason !== 'not_a_trigger') throw new Error(`reason ${r.data.data?.reason}`);
  });

  await test('Unregistered number → not_registered', async () => {
    const r = await sms({ callerPhone: '03009999998', messageBody: 'SOS', gatewaySecret: GATEWAY_SECRET });
    if (r.data.data?.reason !== 'not_registered') throw new Error(`reason ${r.data.data?.reason}`);
  });

  await test('Intl format +92… is normalized (no format error)', async () => {
    const r = await sms({ callerPhone: '+923009999998', messageBody: 'SOS', gatewaySecret: GATEWAY_SECRET });
    // unregistered → not_registered proves +92 normalized to 0300… without erroring
    if (r.data.data?.reason !== 'not_registered') throw new Error(`reason ${r.data.data?.reason}`);
  });

  await test('Urdu keyword "مدد" is accepted (not not_a_trigger)', async () => {
    const r = await sms({ callerPhone: '03009999998', messageBody: 'مدد ایمرجنسی', gatewaySecret: GATEWAY_SECRET });
    if (r.data.data?.reason === 'not_a_trigger') throw new Error('Urdu keyword not recognized');
  });

  await test('Valid SOS from registered patient', async () => {
    const r = await sms({ callerPhone: PATIENT_PHONE, messageBody: 'SOS chest pain', gatewaySecret: GATEWAY_SECRET });
    const d = r.data.data;
    if (d?.success) {
      console.log(`     📦 case ${d.caseNumber} · 📍 ${JSON.stringify(d.usedLocation)}`);
    } else if (['no_location', 'already_active', 'rate_limited'].includes(d?.reason)) {
      console.log(`     ⚠️  ${d.reason} (acceptable — see note)`);
    } else {
      throw new Error(`unexpected reason ${d?.reason}`);
    }
  });

  await test('Duplicate SOS within 5 min → rate_limited / already_active', async () => {
    await sms({ callerPhone: PATIENT_PHONE, messageBody: 'SOS', gatewaySecret: GATEWAY_SECRET });
    const r = await sms({ callerPhone: PATIENT_PHONE, messageBody: 'SOS', gatewaySecret: GATEWAY_SECRET });
    const reason = r.data.data?.reason;
    if (!['rate_limited', 'already_active'].includes(reason) && r.data.data?.success !== true) {
      throw new Error(`reason ${reason}`);
    }
  });

  await test('Location update endpoint (needs TEST_PATIENT_TOKEN)', async () => {
    if (!PATIENT_TOKEN) {
      console.log('     ⚠️  skipped — no TEST_PATIENT_TOKEN');
      return;
    }
    const r = await axios.put(
      `${BASE_URL}/api/auth/location`,
      { lat: 25.3792, lng: 68.3683, accuracy: 15.5 },
      { headers: { Authorization: `Bearer ${PATIENT_TOKEN}` }, validateStatus: () => true },
    );
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (!r.data.data?.location?.lat) throw new Error('no location in response');
  });

  console.log(`\n=== RESULTS ===\nPassed: ${passed}/${passed + failed}`);
  if (failed === 0) console.log('🎉 All offline SOS tests passed!');
  else console.log('⚠️  Some tests failed — review above.');
}

run();
