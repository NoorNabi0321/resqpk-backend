// Seeds everything the Phase 2 test suite needs, with known credentials.
//
//   node evaluation/seed-test-data.js
//
// Safe to re-run: existing rows are reused and passwords are reset to the
// known values, so it always leaves the database in a testable state.
//
// Creates / ensures:
//   - 2 active hospitals with emergency wards (the redirect test needs two)
//   - 1 hospital admin per hospital, each linked via hospitals.admin_user_id
//   - 1 patient with a medical profile
//   - 1 verified, available driver positioned in Hyderabad
//   - the 19 canonical resources for both hospitals
//   - 1 approved, currently-running medical camp
import 'dotenv/config';

import { supabaseAdmin } from '../src/config/supabase.js';
import authService from '../src/services/auth.service.js';

// These defaults match evaluation/test-v2-backend.js so the suite runs with
// no env configuration at all.
const PATIENT = {
  full_name: 'Test Patient',
  phone: process.env.PATIENT_PHONE || '03781980656',
  password: process.env.PATIENT_PASSWORD || 'Test1234!',
};
const DRIVER = {
  full_name: 'Usman Ali',
  phone: process.env.DRIVER_PHONE || '03781980657',
  password: process.env.DRIVER_PASSWORD || 'Driver1234!',
  vehicle_number: 'SBC-80656',
  license_number: 'HYD-TEST-0001',
  organization: 'Edhi Foundation',
};
const HOSPITAL_ADMIN = {
  full_name: 'Civil Hospital Admin',
  email: process.env.HOSPITAL_EMAIL || 'admin@civilhospital.resqpk.app',
  password: process.env.HOSPITAL_PASSWORD || 'Hospital1234!',
  phone: '02299200100',
};
const HOSPITAL_ADMIN_2 = {
  full_name: 'LUH Admin',
  email: process.env.HOSPITAL2_EMAIL || 'admin@luh.resqpk.app',
  password: process.env.HOSPITAL2_PASSWORD || 'Hospital1234!',
  phone: '02299200273',
};

// Real coordinates (OpenStreetMap) — same values as fix-hospital-coordinates.sql.
const HOSPITALS = [
  {
    name: 'Civil Hospital Hyderabad',
    short_name: 'Civil Hospital',
    address: 'Hospital Road, Heerabad, Hyderabad',
    lat: 25.40061,
    lng: 68.36736,
    emergency_phone: '022-9200100',
  },
  {
    name: 'Liaquat University Hospital',
    short_name: 'LUH',
    address: 'LUMHS Campus, N-55, Jamshoro',
    lat: 25.43283,
    lng: 68.27092,
    emergency_phone: '022-9200273',
  },
];

const CANONICAL_RESOURCES = [
  ['equipment', 'ECG Machine', 'ecg', 2],
  ['equipment', 'Ventilator', 'ventilator', 2],
  ['equipment', 'X-Ray', 'xray', 1],
  ['equipment', 'CT Scan', 'ct_scan', 1],
  ['equipment', 'Defibrillator', 'defibrillator', 2],
  ['equipment', 'Dialysis Machine', 'dialysis', 1],
  ['equipment', 'Oxygen Supply', 'oxygen', 10],
  ['equipment', 'Blood Bank', 'blood_bank', 1],
  ['specialist', 'General Physician', 'general_physician', 3],
  ['specialist', 'Surgeon', 'surgeon', 2],
  ['specialist', 'Cardiologist', 'cardiologist', 1],
  ['specialist', 'Neurologist', 'neurologist', 1],
  ['specialist', 'Orthopedic', 'orthopedic', 1],
  ['specialist', 'Gynecologist', 'gynecologist', 1],
  ['specialist', 'Pediatrician', 'pediatrician', 1],
  ['service', 'ICU', 'icu', 1],
  ['service', 'Operation Theater', 'operation_theater', 1],
  ['service', 'Emergency Ward', 'emergency_ward', 1],
  ['service', 'Trauma Center', 'trauma_center', 1],
];

const log = (msg) => console.log(msg);

// Forces a known password on an existing auth user so re-runs are reliable
// even when the account was created earlier with a different one.
async function resetPassword(authId, password) {
  if (!authId) return;
  const { error } = await supabaseAdmin.auth.admin.updateUserById(authId, { password });
  if (error) throw new Error(`Password reset failed: ${error.message}`);
}

async function ensureHospital(spec) {
  const { data: existing } = await supabaseAdmin
    .from('hospitals')
    .select('id, name')
    .eq('name', spec.name)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('hospitals')
      .update({
        facility_type: 'hospital',
        is_active: true,
        is_approved: true,
        has_emergency_ward: true,
        lat: spec.lat,
        lng: spec.lng,
      })
      .eq('id', existing.id);
    log(`  hospital ok      ${spec.name}`);
    return existing.id;
  }

  const { data, error } = await supabaseAdmin
    .from('hospitals')
    .insert({
      name: spec.name,
      short_name: spec.short_name,
      address: spec.address,
      lat: spec.lat,
      lng: spec.lng,
      emergency_phone: spec.emergency_phone,
      facility_type: 'hospital',
      has_emergency_ward: true,
      is_active: true,
      is_approved: true,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Creating ${spec.name} failed: ${error.message}`);
  log(`  hospital created ${spec.name}`);
  return data.id;
}

async function ensureResources(hospitalId, hospitalName) {
  const { data: existing } = await supabaseAdmin
    .from('hospital_resources')
    .select('canonical_key')
    .eq('hospital_id', hospitalId);
  const have = new Set((existing || []).map((r) => r.canonical_key));

  const missing = CANONICAL_RESOURCES.filter(([, , key]) => !have.has(key)).map(
    ([resource_type, resource_name, canonical_key, quantity]) => ({
      hospital_id: hospitalId,
      resource_type,
      resource_name,
      canonical_key,
      status: 'available',
      quantity,
    }),
  );

  if (missing.length > 0) {
    const { error } = await supabaseAdmin.from('hospital_resources').insert(missing);
    if (error) throw new Error(`Seeding resources failed: ${error.message}`);
  }

  // Re-runs may follow a test that left cardiologist 'unavailable'.
  await supabaseAdmin
    .from('hospital_resources')
    .update({ status: 'available' })
    .eq('hospital_id', hospitalId)
    .neq('status', 'available');

  log(`  resources ok     ${hospitalName} (+${missing.length} added, all set available)`);
}

async function ensurePatient() {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, auth_id')
    .eq('phone', PATIENT.phone)
    .maybeSingle();

  let userId;
  if (user) {
    await resetPassword(user.auth_id, PATIENT.password);
    userId = user.id;
    log(`  patient ok       ${PATIENT.phone} (password reset)`);
  } else {
    const created = await authService.registerPatient(PATIENT);
    userId = created.user.id;
    log(`  patient created  ${PATIENT.phone}`);
  }

  // A populated profile makes the PDF and resource match realistic.
  const { data: profile } = await supabaseAdmin
    .from('medical_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  const profileData = {
    blood_group: 'O+',
    gender: 'male',
    date_of_birth: '1981-04-12',
    chronic_conditions: ['Diabetes Type 2', 'Hypertension'],
    allergies: ['Penicillin'],
  };
  if (profile) {
    await supabaseAdmin.from('medical_profiles').update(profileData).eq('user_id', userId);
  } else {
    await supabaseAdmin.from('medical_profiles').insert({ user_id: userId, ...profileData });
  }
  return userId;
}

async function ensureDriver() {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, auth_id')
    .eq('phone', DRIVER.phone)
    .maybeSingle();

  let userId;
  if (user) {
    await resetPassword(user.auth_id, DRIVER.password);
    userId = user.id;
    log(`  driver ok        ${DRIVER.phone} (password reset)`);
  } else {
    const created = await authService.registerDriver(DRIVER);
    userId = created.user.id;
    log(`  driver created   ${DRIVER.phone}`);
  }

  // Verified, available and positioned — dispatch ignores drivers otherwise.
  const { data: driver } = await supabaseAdmin
    .from('drivers')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!driver) throw new Error('Driver row missing for seeded driver user');

  await supabaseAdmin
    .from('drivers')
    .update({
      is_verified: true,
      is_available: true,
      current_lat: 25.3985,
      current_lng: 68.3702,
      heading: 90,
    })
    .eq('id', driver.id);

  return { userId, driverId: driver.id };
}

async function ensureHospitalAdmin(spec, hospitalId) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, auth_id')
    .eq('email', spec.email)
    .eq('role', 'hospital_admin')
    .maybeSingle();

  let userId;
  if (user) {
    await resetPassword(user.auth_id, spec.password);
    userId = user.id;
    log(`  admin ok         ${spec.email} (password reset)`);
  } else {
    const created = await authService.createHospitalAdmin({
      full_name: spec.full_name,
      email: spec.email,
      password: spec.password,
      hospital_id: hospitalId,
      phone: spec.phone,
    });
    userId = created.user.id;
    log(`  admin created    ${spec.email}`);
  }

  // loginHospitalAdmin resolves the hospital with .maybeSingle() on
  // admin_user_id, so this admin must own exactly ONE hospital row.
  await supabaseAdmin
    .from('hospitals')
    .update({ admin_user_id: null })
    .eq('admin_user_id', userId)
    .neq('id', hospitalId);
  await supabaseAdmin.from('hospitals').update({ admin_user_id: userId }).eq('id', hospitalId);

  return userId;
}

async function ensureCamp() {
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const name = 'Free Diabetes & BP Screening Camp';

  const { data: existing } = await supabaseAdmin
    .from('hospitals')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  const fields = {
    facility_type: 'medical_camp',
    is_approved: true,
    is_active: true,
    has_emergency_ward: false,
    lat: 25.396,
    lng: 68.3578,
    address: 'Qasimabad Main Road, Hyderabad',
    camp_start_date: today,
    camp_end_date: end,
    services_offered: ['Diabetes screening', 'Blood pressure check', 'Basic medicines'],
    organizer_name: 'Alkhidmat Foundation',
    description: 'Free health screening camp for the local community.',
    emergency_phone: '03211234567',
  };

  if (existing) {
    await supabaseAdmin.from('hospitals').update(fields).eq('id', existing.id);
    log(`  camp ok          ${name} (approved, running to ${end})`);
    return existing.id;
  }

  const { data, error } = await supabaseAdmin
    .from('hospitals')
    .insert({ name, short_name: 'Alkhidmat Camp', ...fields })
    .select('id')
    .single();
  if (error) throw new Error(`Creating camp failed: ${error.message}`);
  log(`  camp created     ${name}`);
  return data.id;
}

async function checkKeywords() {
  const { count, error } = await supabaseAdmin
    .from('resource_keywords')
    .select('*', { count: 'exact', head: true });
  if (error) {
    log(`  WARNING: resource_keywords unreadable (${error.message}) — run Phase 1 Step 1.3`);
    return;
  }
  if (!count) {
    log('  WARNING: resource_keywords is EMPTY — the matcher will report everything as');
    log('           "unknown". Run the Phase 1 Step 1.3 keyword seed SQL.');
  } else {
    log(`  keywords ok      ${count} rows`);
  }
}

async function main() {
  log('Seeding ResQPK v2 test data\n');

  log('Hospitals');
  const hospitalIds = [];
  for (const spec of HOSPITALS) {
    // Sequential on purpose: clearer output and avoids racing on name lookups.
    // eslint-disable-next-line no-await-in-loop
    const id = await ensureHospital(spec);
    hospitalIds.push(id);
    // eslint-disable-next-line no-await-in-loop
    await ensureResources(id, spec.short_name);
  }
  await checkKeywords();

  log('\nAccounts');
  await ensurePatient();
  const { driverId } = await ensureDriver();
  await ensureHospitalAdmin(HOSPITAL_ADMIN, hospitalIds[0]);
  await ensureHospitalAdmin(HOSPITAL_ADMIN_2, hospitalIds[1]);

  log('\nCamps');
  await ensureCamp();

  log('\n─────────────────────────────────────────────────────────');
  log('TEST CREDENTIALS');
  log('─────────────────────────────────────────────────────────');
  log(`Patient         ${PATIENT.phone}  /  ${PATIENT.password}`);
  log(`Driver          ${DRIVER.phone}  /  ${DRIVER.password}`);
  log(`Hospital admin  ${HOSPITAL_ADMIN.email}  /  ${HOSPITAL_ADMIN.password}`);
  log(`Hospital 2      ${HOSPITAL_ADMIN_2.email}  /  ${HOSPITAL_ADMIN_2.password}`);
  log('─────────────────────────────────────────────────────────');
  log(`Hospital 1 id   ${hospitalIds[0]}`);
  log(`Hospital 2 id   ${hospitalIds[1]}`);
  log(`Driver id       ${driverId}`);
  log('─────────────────────────────────────────────────────────');
  log('\nNext:  node evaluation/test-v2-backend.js');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  console.error('If this mentions a missing column, Phase 1 SQL has not been fully applied.');
  process.exit(1);
});
