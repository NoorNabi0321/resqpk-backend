// End to end over the two things that did not exist before: the approval
// queue, and a camp's own patient register.
//
// Tokens are minted here rather than signing in, so the run creates no
// accounts and needs no passwords. Everything it writes to the database, it
// deletes on the way out.
//
//   node evaluation/camp-admin-e2e.mjs
import 'dotenv/config';
import jwt from 'jsonwebtoken';

import config from '../src/config/env.js';
import { supabaseAdmin } from '../src/config/supabase.js';

const BASE = process.env.SERVER_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv or html */ }
  return { status: res.status, json, text };
}

// --- fixtures ---------------------------------------------------------------

const stamp = Date.now();
const cleanup = { campIds: [], visitIds: [] };

// A real user row is needed for approved_by and recorded_by (both are FKs).
const { data: anyUser } = await supabaseAdmin
  .from('users').select('id').limit(1).maybeSingle();
if (!anyUser) {
  console.error('No users in the database to attribute actions to.');
  process.exit(1);
}

const adminToken = jwt.sign(
  { id: anyUser.id, role: 'super_admin', email: `e2e-admin-${stamp}@resqpk.test` },
  config.jwtSecret,
  { expiresIn: '1h' },
);

// Two camps of our own so the run never touches real registrations.
const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
const campRow = (suffix) => ({
  name: `E2E Camp ${suffix} ${stamp}`,
  short_name: `E2E ${suffix}`,
  facility_type: 'medical_camp',
  is_approved: false,
  is_active: true,
  has_emergency_ward: false,
  lat: 25.396,
  lng: 68.3578,
  address: 'E2E test address, Hyderabad',
  camp_start_date: today,
  camp_end_date: today,
  services_offered: ['Blood sugar test', 'Blood pressure check'],
  organizer_name: 'E2E Harness',
  description: 'Created by camp-admin-e2e.mjs',
});

const { data: campA, error: e1 } = await supabaseAdmin
  .from('hospitals').insert(campRow('A')).select('id, name').single();
const { data: campB, error: e2 } = await supabaseAdmin
  .from('hospitals').insert(campRow('B')).select('id, name').single();
if (e1 || e2) {
  console.error(`Could not create fixtures: ${(e1 || e2).message}`);
  process.exit(1);
}
cleanup.campIds.push(campA.id, campB.id);

const campAToken = jwt.sign(
  { id: anyUser.id, role: 'hospital_admin', hospital_id: campA.id, email: 'campA@resqpk.test' },
  config.jwtSecret,
  { expiresIn: '1h' },
);
const campBToken = jwt.sign(
  { id: anyUser.id, role: 'hospital_admin', hospital_id: campB.id, email: 'campB@resqpk.test' },
  config.jwtSecret,
  { expiresIn: '1h' },
);

try {
  // --- approval queue -------------------------------------------------------
  console.log('\nApproval queue');

  let r = await api('/api/admin/facilities?status=pending', { token: adminToken });
  const pendingIds = (r.json?.data?.facilities || []).map((f) => f.id);
  check('pending list includes a new registration', pendingIds.includes(campA.id),
    `${pendingIds.length} pending`);

  r = await api('/api/admin/facilities/pending-count', { token: adminToken });
  check('pending count is a number', typeof r.json?.data?.pending === 'number',
    `${r.json?.data?.pending}`);

  r = await api('/api/admin/facilities', { token: campAToken });
  check('a camp admin cannot read the queue', r.status === 403, `HTTP ${r.status}`);

  r = await api(`/api/admin/facilities/${campA.id}/approve`, {
    token: adminToken, method: 'POST',
  });
  check('approve', r.json?.data?.status === 'approved', r.json?.data?.status);

  r = await api(`/api/admin/facilities/${campA.id}/approve`, {
    token: adminToken, method: 'POST',
  });
  check('approving twice is refused', r.status === 400, r.json?.message);

  r = await api(`/api/admin/facilities/${campB.id}/reject`, {
    token: adminToken, method: 'POST', body: {},
  });
  check('reject without a reason is refused', r.status === 400, r.json?.message);

  r = await api(`/api/admin/facilities/${campB.id}/reject`, {
    token: adminToken, method: 'POST', body: { reason: 'Duplicate registration' },
  });
  check('reject with a reason', r.json?.data?.status === 'rejected', r.json?.data?.rejectionReason);

  // The gate that matters: an approved camp is visible to patients, a rejected
  // one is not.
  r = await api(`/api/camps/nearby?lat=25.396&lng=68.3578&radius=25000`);
  const visible = (r.json?.data?.camps || r.json?.data || []).map((c) => c.id);
  check('approved camp is visible to patients', visible.includes(campA.id));
  check('rejected camp is not', !visible.includes(campB.id));

  // --- patient register -----------------------------------------------------
  console.log('\nCamp patient records');

  r = await api('/api/camp-visits', {
    token: campAToken, method: 'POST',
    body: {
      patientName: 'Fatima Bibi', age: 54, gender: 'female', phone: '03001234567',
      servicesGiven: ['Blood sugar test', 'Blood pressure check'],
      bloodPressure: '160/95', bloodSugar: '11.4',
      findings: 'Raised BP, advised review', needsFollowup: true,
      followupNote: 'Refer to Civil Hospital',
    },
  });
  const visitId = r.json?.data?.id;
  if (visitId) cleanup.visitIds.push(visitId);
  check('record a visit', r.status === 201 && !!visitId, r.json?.data?.patientName);

  r = await api('/api/camp-visits', {
    token: campAToken, method: 'POST', body: { patientName: '' },
  });
  check('a nameless record is refused', r.status === 400, r.json?.message);

  r = await api('/api/camp-visits', {
    token: campAToken, method: 'POST', body: { patientName: 'Too Old', age: 900 },
  });
  check('an impossible age is refused', r.status === 400, r.json?.message);

  r = await api('/api/camp-visits/summary', { token: campAToken });
  check('summary counts today', r.json?.data?.seenToday === 1, `seenToday=${r.json?.data?.seenToday}`);
  check('summary tallies services',
    (r.json?.data?.servicesToday || []).some((s) => s.service === 'Blood sugar test' && s.count === 1));
  check('summary counts follow-ups', r.json?.data?.awaitingFollowup === 1);

  r = await api('/api/camp-visits?search=Fatima', { token: campAToken });
  check('search by name', (r.json?.data?.visits || []).length === 1);

  r = await api('/api/camp-visits?search=03001234567', { token: campAToken });
  check('search by phone', (r.json?.data?.visits || []).length === 1);

  // The whole point of the scoping.
  r = await api('/api/camp-visits', { token: campBToken });
  check('another camp sees none of it', (r.json?.data?.visits || []).length === 0,
    `${r.json?.data?.total} rows`);

  r = await api(`/api/camp-visits/${visitId}`, {
    token: campBToken, method: 'PUT', body: { patientName: 'Hijacked' },
  });
  check('another camp cannot edit it', r.status === 400, r.json?.message);

  r = await api(`/api/camp-visits/${visitId}`, {
    token: campBToken, method: 'DELETE',
  });
  check('another camp cannot delete it', r.status === 400, r.json?.message);

  r = await api(`/api/camp-visits/${visitId}`, {
    token: campAToken, method: 'PUT', body: { needsFollowup: false },
  });
  check('the owning camp can edit it', r.json?.data?.needsFollowup === false);

  // --- camp editing its own profile ----------------------------------------
  console.log('\nCamp profile');

  r = await api('/api/camps/dashboard/me', {
    token: campAToken, method: 'PUT',
    body: { campName: `E2E Camp A renamed ${stamp}`, servicesOffered: ['Eye checkup', 'Free glasses'] },
  });
  check('a camp can rename itself and change its services',
    r.json?.data?.camp?.servicesOffered?.length === 2, r.json?.data?.camp?.name);

  r = await api('/api/camps/dashboard/me', {
    token: campAToken, method: 'PUT', body: { servicesOffered: [] },
  });
  check('a camp cannot remove every service', r.status === 400, r.json?.message);

  r = await api('/api/camps/dashboard/me', {
    token: campAToken, method: 'PUT', body: { startDate: '2026-10-10', endDate: '2026-10-01' },
  });
  check('end before start is refused', r.status === 400, r.json?.message);

  r = await api('/api/camps/dashboard/me', {
    token: campAToken, method: 'PUT', body: { lat: 51.5, lng: -0.12 },
  });
  check('a pin outside Pakistan is refused', r.status === 400, r.json?.message);

  r = await api('/api/camps/dashboard/me', {
    token: campAToken, method: 'PUT', body: { isApproved: true, facility_type: 'hospital' },
  });
  check('a camp cannot approve itself or become a hospital',
    r.status === 400 || r.json?.data?.camp !== undefined, r.json?.message || 'ignored');

  // The route is hospital_admin only, so an administrator is turned away by
  // the role guard before the controller ever looks for a camp.
  r = await api('/api/camps/dashboard/me', { token: adminToken });
  check('an admin cannot open a camp dashboard', r.status === 403, `HTTP ${r.status}`);

  r = await api('/api/camp-visits/export.csv', { token: campAToken });
  check('CSV export', r.status === 200 && r.text.includes('Fatima Bibi'),
    `${r.text.split('\r\n').length - 1} rows`);
  check('CSV is formula-safe', !/,=/.test(r.text) || r.text.includes("'="));
} finally {
  console.log('\nCleanup');
  for (const id of cleanup.visitIds) {
    await supabaseAdmin.from('camp_visits').delete().eq('id', id);
  }
  // Cascades any remaining visits with it.
  for (const id of cleanup.campIds) {
    await supabaseAdmin.from('hospitals').delete().eq('id', id);
  }
  const { count } = await supabaseAdmin
    .from('hospitals').select('id', { count: 'exact', head: true })
    .like('name', `%${stamp}%`);
  check('fixtures removed', (count || 0) === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
