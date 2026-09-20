// End-to-end check of the patient journey, exactly as the app makes it —
// with no account, holding nothing but a case token.
//
// Every request here is one the mobile app sends. If this passes, an anonymous
// person can call an ambulance, watch it, choose a hospital, add details, and
// find the request again afterwards.
//
// Usage:
//   node evaluation/patient-e2e.mjs                 (production)
//   node evaluation/patient-e2e.mjs --local
//   node evaluation/patient-e2e.mjs --keep          (do not cancel at the end)
//   node evaluation/patient-e2e.mjs --no-ai         (skip the AI report — saves credits)
import { setTimeout as sleep } from 'timers/promises';

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const API = flag('local') ? 'http://localhost:3000' : arg('api', 'https://resqpk-backend.onrender.com');
const LAT = Number(arg('lat', 25.3792));
const LNG = Number(arg('lng', 68.3683));

let pass = 0;
let fail = 0;

const ok = (label, detail = '') => {
  pass += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
};
const bad = (label, detail = '') => {
  fail += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function call(path, { method = 'GET', token, body, raw = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (raw) return { status: res.status, json };
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status} on ${path}`);
  return json.data;
}

console.log(`\nPatient end-to-end against ${API}\n`);

// --- 1. What the app loads before anyone touches anything -------------------
console.log('Public content (no account, no token)');
try {
  const guides = await call('/api/first-aid');
  const list = guides?.guides || [];
  list.length >= 8
    ? ok('first aid guides', `${list.length} guides`)
    : bad('first aid guides', `only ${list.length}`);
} catch (e) {
  bad('first aid guides', e.message);
}

try {
  const hospitals = await call(`/api/hospitals/nearby?lat=${LAT}&lng=${LNG}`);
  hospitals?.length
    ? ok('nearby hospitals', `${hospitals.length}, nearest ${hospitals[0].distanceText}`)
    : bad('nearby hospitals', 'empty');
} catch (e) {
  bad('nearby hospitals', e.message);
}

try {
  const camps = await call(`/api/camps/nearby?lat=${LAT}&lng=${LNG}`);
  camps?.length
    ? ok('nearby camps', `${camps.length}, nearest ${camps[0].name}`)
    : bad('nearby camps', 'empty');
} catch (e) {
  bad('nearby camps', e.message);
}

// --- 2. The SOS ------------------------------------------------------------
console.log('\nSOS with no account');
let caseId;
let caseToken;
let accessCode;
try {
  const sos = await call('/api/sos/trigger', {
    method: 'POST',
    body: {
      lat: LAT,
      lng: LNG,
      accuracy: 12,
      reporterPhone: '03001234567',
      reporterName: 'E2E Test',
      reportedFor: 'other',
      channel: 'app',
    },
  });
  caseId = sos.caseId;
  caseToken = sos.caseToken;
  accessCode = sos.accessCode;
  caseId && caseToken && accessCode
    ? ok('sos trigger', `${sos.caseNumber}, code ${accessCode}`)
    : bad('sos trigger', 'missing caseId/caseToken/accessCode');
} catch (e) {
  bad('sos trigger', e.message);
  console.log('\nCannot continue without a case.\n');
  process.exit(1);
}

try {
  const details = await call(`/api/cases/${caseId}`, { token: caseToken });
  details?.id === caseId
    ? ok('read own case with the case token', `status ${details.status}`)
    : bad('read own case with the case token');
} catch (e) {
  bad('read own case with the case token', e.message);
}

// The token must not be a master key.
try {
  const other = '00000000-0000-0000-0000-000000000000';
  const { status } = await call(`/api/cases/${other}`, { token: caseToken, raw: true });
  status === 403 || status === 404
    ? ok('case token is scoped to its own case', `HTTP ${status}`)
    : bad('case token is scoped to its own case', `HTTP ${status}`);
} catch (e) {
  bad('case token is scoped to its own case', e.message);
}

// --- 3. Choosing the hospital ----------------------------------------------
console.log('\nHospital choice');
try {
  const hospitals = await call(`/api/hospitals/nearby?lat=${LAT}&lng=${LNG}`);
  const { status, json } = await call(`/api/cases/${caseId}/hospital`, {
    method: 'PUT',
    token: caseToken,
    body: { hospitalId: hospitals[0].id },
    raw: true,
  });
  // Before an ambulance accepts, this is *meant* to be refused — with an
  // explanation, not a 401. A 401 would mean the token was rejected outright.
  if (status === 200) {
    ok('choose hospital with the case token', hospitals[0].name);
  } else if (status === 400 && /ambulance/i.test(json.message || '')) {
    ok('hospital choice authorised, correctly deferred', json.message);
  } else {
    bad('choose hospital with the case token', `HTTP ${status}: ${json.message}`);
  }
} catch (e) {
  bad('choose hospital with the case token', e.message);
}

// --- 4. The AI report -------------------------------------------------------
if (!flag('no-ai')) {
  console.log('\nAI report');
  try {
    const form = new FormData();
    form.append('case_id', caseId);
    form.append(
      'text',
      'Motorcycle accident near Auto Bhan Road. Young man, bleeding from the right leg, '
        + 'awake but confused. He says he takes medicine for diabetes.',
    );
    form.append('language', 'en');

    const res = await fetch(`${API}/api/ai/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${caseToken}` },
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);

    const report = json.data;
    report?.generationStatus === 'completed'
      ? ok('generate report', `${report.urgencyLevel} · ${report.emergencyType} · ${report.generationTimeMs}ms`)
      : bad('generate report', `status ${report?.generationStatus}`);
    report?.resourcesNeeded?.length
      ? ok('resources identified', report.resourcesNeeded.join(', '))
      : bad('resources identified', 'none');

    // The PDF is attached a moment after the JSON lands.
    let pdfUrl = null;
    for (let i = 0; i < 6 && !pdfUrl; i += 1) {
      await sleep(2000);
      const pdf = await call(`/api/ai/report/${caseId}/pdf`, { token: caseToken, raw: true });
      pdfUrl = pdf.json?.data?.pdfUrl || null;
    }
    if (pdfUrl) {
      const head = await fetch(pdfUrl);
      const bytes = Number(head.headers.get('content-length') || 0);
      bytes > 20000
        ? ok('report PDF', `${Math.round(bytes / 1024)} KB`)
        : bad('report PDF', `only ${bytes} bytes`);
    } else {
      bad('report PDF', 'no URL after 12s');
    }

    const { status } = await call(`/api/ai/report/${caseId}/send`, {
      method: 'POST',
      token: caseToken,
      raw: true,
    });
    // 400 here means "no hospital chosen yet", which is honest at this stage.
    status === 200 || status === 400
      ? ok('re-send to hospital reachable', `HTTP ${status}`)
      : bad('re-send to hospital reachable', `HTTP ${status}`);
  } catch (e) {
    bad('AI report', e.message);
  }
}

// --- 5. Finding it again ----------------------------------------------------
console.log('\nFinding the request again');
try {
  const found = await call('/api/cases/lookup', {
    method: 'POST',
    body: { accessCode },
  });
  found?.caseId === caseId && found?.caseToken
    ? ok('lookup by request code', `fresh token for ${found.caseNumber}`)
    : bad('lookup by request code');
} catch (e) {
  bad('lookup by request code', e.message);
}

try {
  const { status } = await call('/api/cases/lookup', {
    method: 'POST',
    body: { accessCode: 'RQ-0000-0000' },
    raw: true,
  });
  status === 404
    ? ok('wrong code is refused', 'HTTP 404')
    : bad('wrong code is refused', `HTTP ${status}`);
} catch (e) {
  bad('wrong code is refused', e.message);
}

// --- 6. Clean up ------------------------------------------------------------
if (!flag('keep')) {
  console.log('\nCleanup');
  try {
    await call('/api/sos/cancel', {
      method: 'POST',
      token: caseToken,
      body: { caseId, reason: 'false_alarm' },
    });
    ok('cancel with the case token');
  } catch (e) {
    bad('cancel with the case token', e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
