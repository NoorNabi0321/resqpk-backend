// Phase 2 end-to-end verification (Instruction 2.9).
//
// Exercises the full v2 backend against a RUNNING server and a live Supabase:
// AI report -> PDF -> resource match -> accept -> redirect -> messages -> camps.
//
// Usage:
//   node evaluation/test-v2-backend.js
//   BASE_URL=http://localhost:3001 node evaluation/test-v2-backend.js
//
// Credentials come from env with the seeded defaults as fallback:
//   PATIENT_PHONE / PATIENT_PASSWORD
//   DRIVER_PHONE  / DRIVER_PASSWORD
//   HOSPITAL_EMAIL / HOSPITAL_PASSWORD
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CREDS = {
  patient: {
    phone: process.env.PATIENT_PHONE || '03781980656',
    password: process.env.PATIENT_PASSWORD || 'Test1234!',
  },
  driver: {
    phone: process.env.DRIVER_PHONE || '03781980657',
    password: process.env.DRIVER_PASSWORD || 'Driver1234!',
  },
  hospital: {
    email: process.env.HOSPITAL_EMAIL || 'admin@civilhospital.resqpk.app',
    password: process.env.HOSPITAL_PASSWORD || 'Hospital1234!',
  },
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// --- tiny test harness -------------------------------------------------------
const results = [];
function record(step, ok, detail = '') {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}
function fail(step, err) {
  record(step, false, err?.message || String(err));
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Creates a case that is assigned to a driver, which is the state the
// decision endpoints require.
async function createAssignedCase(patientToken, hospitalId, driverId) {
  const trigger = await api('/api/sos/trigger', {
    method: 'POST',
    token: patientToken,
    body: { lat: 25.3992, lng: 68.3683, accuracy: 12 },
  });
  const caseId = trigger.body?.data?.caseId || trigger.body?.data?.id;
  if (!caseId) throw new Error(`SOS trigger failed: ${JSON.stringify(trigger.body)}`);

  // Put the case straight into the post-dispatch state the hospital sees.
  await supabase
    .from('emergency_cases')
    .update({
      status: 'driver_assigned',
      driver_id: driverId,
      hospital_id: hospitalId,
      hospital_decision: 'awaiting_review',
      driver_assigned_at: new Date().toISOString(),
    })
    .eq('id', caseId);

  return caseId;
}

async function main() {
  console.log(`ResQPK v2 backend tests → ${BASE_URL}\n`);

  // --- logins ---------------------------------------------------------------
  let patientToken;
  let driverToken;
  let hospitalToken;
  let hospitalId;
  let driverId;
  try {
    const p = await api('/api/auth/patient/login', { method: 'POST', body: CREDS.patient });
    patientToken = p.body?.data?.token;
    const d = await api('/api/auth/driver/login', { method: 'POST', body: CREDS.driver });
    driverToken = d.body?.data?.token;
    const h = await api('/api/auth/hospital/login', { method: 'POST', body: CREDS.hospital });
    hospitalToken = h.body?.data?.token;
    hospitalId = h.body?.data?.hospital?.id || h.body?.data?.user?.hospital_id;

    if (!patientToken || !driverToken || !hospitalToken) {
      throw new Error('one or more logins failed — check credentials in env');
    }
    if (!hospitalId) {
      const { data } = await supabase.from('hospitals').select('id').eq('facility_type', 'hospital').limit(1).single();
      hospitalId = data?.id;
    }
    // Must be the driver we log in as — quick messages authorize the sender
    // against the case's driver_id, so any other driver would 403.
    const { data: driverUser } = await supabase
      .from('users')
      .select('id')
      .eq('phone', CREDS.driver.phone)
      .maybeSingle();
    const { data: drv } = await supabase
      .from('drivers')
      .select('id')
      .eq('user_id', driverUser?.id)
      .maybeSingle();
    driverId = drv?.id;
    if (!driverId) throw new Error(`no driver row for ${CREDS.driver.phone} — run seed-test-data.js`);
    record('logins (patient, driver, hospital)', true, `hospital ${hospitalId?.slice(0, 8)}`);
  } catch (err) {
    fail('logins (patient, driver, hospital)', err);
    console.log('\nCannot continue without tokens.');
    process.exit(1);
  }

  let caseId;
  let secondCaseId;

  // --- 1. SOS + AI report ---------------------------------------------------
  try {
    caseId = await createAssignedCase(patientToken, hospitalId, driverId);
    // The endpoint takes multipart fields case_id / text (not camelCase).
    const form = new FormData();
    form.append('case_id', caseId);
    form.append('text', 'Severe chest pain, patient unconscious, has diabetes');
    const res = await fetch(`${BASE_URL}/api/ai/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${patientToken}` },
      body: form,
    });
    const json = await res.json();
    record('1. AI report generated from text', res.status === 200, json?.message || `HTTP ${res.status}`);
  } catch (err) {
    fail('1. AI report generated from text', err);
  }

  // --- 2. resources_needed + pdf_url persisted ------------------------------
  let pdfPath = null;
  try {
    await sleep(1500); // PDF upload happens right after the report is saved
    const { data: report } = await supabase
      .from('ai_reports')
      .select('resources_needed, pdf_url, pdf_storage_path, urgency_level')
      .eq('case_id', caseId)
      .maybeSingle();
    pdfPath = report?.pdf_storage_path;
    const hasResources = Array.isArray(report?.resources_needed) && report.resources_needed.length > 0;
    record('2a. resources_needed is non-empty', hasResources, (report?.resources_needed || []).join(', '));
    record('2b. pdf_url is set', !!report?.pdf_url, report?.pdf_storage_path || 'missing');
  } catch (err) {
    fail('2. report columns persisted', err);
  }

  // --- 3. PDF is fetchable and is a PDF -------------------------------------
  try {
    const fresh = await api(`/api/ai/report/${caseId}/pdf`, { token: hospitalToken });
    const url = fresh.body?.data?.pdfUrl;
    if (!url) throw new Error(`no pdfUrl returned (HTTP ${fresh.status})`);
    const pdfRes = await fetch(url);
    const type = pdfRes.headers.get('content-type') || '';
    record('3. PDF downloads with application/pdf', pdfRes.status === 200 && type.includes('pdf'),
      `HTTP ${pdfRes.status}, ${type}`);
  } catch (err) {
    fail('3. PDF downloads with application/pdf', err);
  }

  // --- 4. resource match ----------------------------------------------------
  try {
    const match = await api(`/api/resources/match/${caseId}`, { token: hospitalToken });
    const checks = match.body?.data?.checks;
    record('4. resource match returns checks', Array.isArray(checks) && checks.length > 0,
      `${checks?.length || 0} checks, overallOk=${match.body?.data?.overallOk}`);
  } catch (err) {
    fail('4. resource match returns checks', err);
  }

  // --- 5. take down a resource this case NEEDS → it shows as missing --------
  // Targets a resource from the AI's actual resources_needed rather than a
  // hardcoded one, since the list varies with what the model returns.
  try {
    const before = await api(`/api/resources/match/${caseId}`, { token: hospitalToken });
    const target = (before.body?.data?.checks || []).find(
      (c) => c.status === 'ok' && c.canonicalKey,
    );
    if (!target) throw new Error('no available resource in this case to take down');

    await api(`/api/resources/${target.canonicalKey}`, {
      method: 'PUT',
      token: hospitalToken,
      body: { status: 'unavailable', quantity: 0 },
    });

    const after = await api(`/api/resources/match/${caseId}`, { token: hospitalToken });
    const data = after.body?.data || {};
    const nowMissing = (data.checks || []).find(
      (c) => c.canonicalKey === target.canonicalKey && c.status === 'missing',
    );
    record('5. unavailable resource shows as missing',
      !!nowMissing && data.overallOk === false,
      `${target.resource} → ${nowMissing?.status || 'not flagged'}; summary: ${data.summary}`);

    // Restore so re-runs start clean.
    await api(`/api/resources/${target.canonicalKey}`, {
      method: 'PUT',
      token: hospitalToken,
      body: { status: 'available', quantity: 1 },
    });
  } catch (err) {
    fail('5. unavailable resource shows as missing', err);
  }

  // --- 6. accept ------------------------------------------------------------
  try {
    const accept = await api('/api/decisions/accept', {
      method: 'POST',
      token: hospitalToken,
      body: { caseId, preparationNote: 'ICU prepared' },
    });
    const { data: row } = await supabase
      .from('emergency_cases')
      .select('hospital_decision, preparation_note')
      .eq('id', caseId)
      .maybeSingle();
    record('6. accept sets hospital_decision=accepted',
      accept.status === 200 && row?.hospital_decision === 'accepted',
      `decision=${row?.hospital_decision}, note=${row?.preparation_note}`);
  } catch (err) {
    fail('6. accept sets hospital_decision=accepted', err);
  }

  // --- 7. redirect a fresh case --------------------------------------------
  try {
    const { data: other } = await supabase
      .from('hospitals')
      .select('id, name')
      .eq('facility_type', 'hospital')
      .neq('id', hospitalId)
      .limit(1)
      .single();
    if (!other) throw new Error('need a second hospital to redirect to');

    secondCaseId = await createAssignedCase(patientToken, hospitalId, driverId);
    const redirect = await api('/api/decisions/redirect', {
      method: 'POST',
      token: hospitalToken,
      body: { caseId: secondCaseId, newHospitalId: other.id, reason: 'No ICU bed available' },
    });
    const { data: row } = await supabase
      .from('emergency_cases')
      .select('hospital_id, redirected_from_hospital_id, redirect_reason, hospital_decision')
      .eq('id', secondCaseId)
      .maybeSingle();

    const ok =
      redirect.status === 200 &&
      row?.hospital_id === other.id &&
      row?.redirected_from_hospital_id === hospitalId &&
      row?.hospital_decision === 'awaiting_review';
    record('7. redirect reassigns hospital + records origin', ok,
      `now at ${other.name}, from=${row?.redirected_from_hospital_id?.slice(0, 8)}, reason=${row?.redirect_reason}`);
  } catch (err) {
    fail('7. redirect reassigns hospital + records origin', err);
  }

  // --- 8. quick messages both directions ------------------------------------
  try {
    const fromHospital = await api('/api/decisions/message', {
      method: 'POST',
      token: hospitalToken,
      body: { caseId, messageKey: 'gate_2' },
    });
    const fromDriver = await api('/api/decisions/message', {
      method: 'POST',
      token: driverToken,
      body: { caseId, messageKey: 'five_min_away' },
    });
    const list = await api(`/api/decisions/messages/${caseId}`, { token: hospitalToken });
    const rows = list.body?.data || [];
    const hasBoth =
      rows.some((r) => r.message_key === 'gate_2' && r.sender_role === 'hospital') &&
      rows.some((r) => r.message_key === 'five_min_away' && r.sender_role === 'driver');
    record('8. quick messages logged both directions', hasBoth,
      `${rows.length} rows (hospital ${fromHospital.status}, driver ${fromDriver.status})`);

    // Role enforcement: a hospital must not be able to send a driver message.
    const wrongRole = await api('/api/decisions/message', {
      method: 'POST',
      token: hospitalToken,
      body: { caseId, messageKey: 'five_min_away' },
    });
    record('8b. role mismatch rejected', wrongRole.status === 400, `HTTP ${wrongRole.status}`);
  } catch (err) {
    fail('8. quick messages logged both directions', err);
  }

  // --- 9. camp registration is unapproved by default ------------------------
  const campName = `Test Eye Camp ${Date.now()}`;
  const campEmail = `eyecamp+${Date.now()}@test.resqpk.app`;
  try {
    const today = new Date();
    const end = new Date(today.getTime() + 11 * 24 * 3600 * 1000);
    const reg = await api('/api/camps/register', {
      method: 'POST',
      body: {
        campName,
        organizerName: 'Test NGO',
        description: 'Free eye checkup',
        lat: 25.4, lng: 68.37,
        address: 'Latifabad, Hyderabad',
        servicesOffered: ['Eye checkup', 'Free glasses'],
        startDate: today.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        contactPhone: '03219999999',
        adminEmail: campEmail,
        adminPassword: 'Camp1234!',
        adminFullName: 'Camp Admin',
      },
    });
    const { data: camp } = await supabase
      .from('hospitals')
      .select('id, is_approved, facility_type')
      .eq('name', campName)
      .maybeSingle();
    record('9. camp registers as unapproved',
      reg.status === 201 && camp?.is_approved === false && camp?.facility_type === 'medical_camp',
      `HTTP ${reg.status}, approved=${camp?.is_approved}`);
  } catch (err) {
    fail('9. camp registers as unapproved', err);
  }

  // --- 10. nearby camps shows approved only ---------------------------------
  try {
    const nearby = await api('/api/camps/nearby?lat=25.3792&lng=68.3683', { token: patientToken });
    const camps = nearby.body?.data || [];
    const names = camps.map((c) => c.name);
    const seededVisible = camps.length > 0;
    const unapprovedHidden = !names.includes(campName);
    record('10a. seeded approved camp is visible', seededVisible, names.join(' | ') || 'none returned');
    record('10b. unapproved camp is hidden', unapprovedHidden,
      unapprovedHidden ? 'correctly excluded' : 'LEAKED to patients');
  } catch (err) {
    fail('10. nearby camps filtering', err);
  }

  // --- summary --------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (passed < results.length) {
    console.log('\nFailed:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.step}: ${r.detail}`));
  }
  console.log(`\nCleanup note: test camp "${campName}" and its admin (${campEmail}) remain in the DB.`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
