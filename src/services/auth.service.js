// Authentication business logic. All database access uses supabaseAdmin
// (service role, bypasses RLS). Passwords are managed entirely by Supabase Auth.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { supabaseClient, supabaseAdmin } from '../config/supabase.js';
import config from '../config/env.js';

// --- helpers ---------------------------------------------------------------

function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

// Digits-only phone for placeholder auth emails (e.g. 923001234567@resqpk.app).
function phoneLocalPart(phone) {
  return String(phone).replace(/\D/g, '');
}

// users.phone is UNIQUE NOT NULL, but hospital and camp admins sign in by
// email and may have no personal number. Use the supplied one when it is free,
// otherwise allocate a clearly non-dialable placeholder.
async function allocateAdminPhone(preferred) {
  const isTaken = async (value) => {
    const { data } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('phone', value)
      .maybeSingle();
    return !!data;
  };

  if (preferred && !(await isTaken(preferred))) return preferred;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `admin-${crypto.randomBytes(4).toString('hex')}`; // 14 chars
    // eslint-disable-next-line no-await-in-loop
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error('Could not allocate a unique admin phone');
}

// Creates the Supabase Auth user (skipping email confirmation for the FYP).
async function createAuthUser(email, password) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  return data.user;
}

// Verifies a password via the anon client. We never call .from() on this client,
// so signing in here cannot leak a user session into our service-role queries.
async function verifyPassword(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error || !data?.user) return false;
  return true;
}

// --- registration ----------------------------------------------------------

export async function registerPatient({ full_name, phone, email, password }) {
  const { data: existing } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  if (existing) throw new Error('Phone number already registered');

  const authEmail = email || `${phoneLocalPart(phone)}@resqpk.app`;
  const authUser = await createAuthUser(authEmail, password);

  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ auth_id: authUser.id, full_name, phone, email: email || null, role: 'patient' })
      .select('id, full_name, phone, email, role')
      .single();
    if (userError) throw new Error(userError.message);

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('medical_profiles')
      .insert({ user_id: user.id })
      .select('id')
      .single();
    if (profileError) throw new Error(profileError.message);

    const token = signToken({ id: user.id, auth_id: authUser.id, role: 'patient', phone });
    return { user, token, medical_profile_id: profile.id };
  } catch (err) {
    // Roll back the orphaned auth user so the phone/email can be reused.
    await supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(() => {});
    throw err;
  }
}

export async function registerDriver({
  full_name,
  phone,
  email,
  password,
  vehicle_number,
  license_number,
  organization = 'Private',
}) {
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  if (existingUser) throw new Error('Phone number already registered');

  const { data: existingVehicle } = await supabaseAdmin
    .from('drivers')
    .select('id')
    .eq('vehicle_number', vehicle_number)
    .maybeSingle();
  if (existingVehicle) throw new Error('Vehicle already registered');

  const { data: existingLicense } = await supabaseAdmin
    .from('drivers')
    .select('id')
    .eq('license_number', license_number)
    .maybeSingle();
  if (existingLicense) throw new Error('License number already registered');

  const authEmail = email || `${phoneLocalPart(phone)}@driver.resqpk.app`;
  const authUser = await createAuthUser(authEmail, password);

  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ auth_id: authUser.id, full_name, phone, email: email || null, role: 'driver' })
      .select('id, full_name, phone, email, role')
      .single();
    if (userError) throw new Error(userError.message);

    const { data: driver, error: driverError } = await supabaseAdmin
      .from('drivers')
      .insert({
        user_id: user.id,
        vehicle_number,
        license_number,
        organization,
        is_available: false,
        // Verified on sign-up: dispatch only offers cases to verified drivers,
        // and ResQPK has no admin approval flow, so an unverified driver would
        // look online but never receive a request.
        is_verified: true,
      })
      .select()
      .single();
    if (driverError) throw new Error(driverError.message);

    const token = signToken({
      id: user.id,
      auth_id: authUser.id,
      role: 'driver',
      phone,
      driver_id: driver.id,
    });
    return { user, driver, token };
  } catch (err) {
    await supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(() => {});
    throw err;
  }
}

// --- login -----------------------------------------------------------------

export async function loginPatient({ phone, password }) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('phone', phone)
    .eq('role', 'patient')
    .maybeSingle();
  if (!user) throw new Error('Invalid phone or password');

  // The auth user holds the email actually used for sign-in (real or placeholder).
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(
    user.auth_id
  );
  if (authError || !authData?.user?.email) throw new Error('Invalid phone or password');

  const ok = await verifyPassword(authData.user.email, password);
  if (!ok) throw new Error('Invalid phone or password');

  const { data: medical_profile } = await supabaseAdmin
    .from('medical_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  const token = signToken({ id: user.id, auth_id: user.auth_id, role: 'patient', phone });
  return { user, token, medical_profile };
}

export async function loginDriver({ phone, password }) {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('phone', phone)
    .eq('role', 'driver')
    .maybeSingle();
  if (!user) throw new Error('Invalid phone or password');

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(
    user.auth_id
  );
  if (authError || !authData?.user?.email) throw new Error('Invalid phone or password');

  const ok = await verifyPassword(authData.user.email, password);
  if (!ok) throw new Error('Invalid phone or password');

  const { data: driver } = await supabaseAdmin
    .from('drivers')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  const token = signToken({
    id: user.id,
    auth_id: user.auth_id,
    role: 'driver',
    phone,
    driver_id: driver?.id,
  });
  return { user, driver, token };
}

export async function loginHospitalAdmin({ email, password }) {
  const ok = await verifyPassword(email, password);
  if (!ok) throw new Error('Invalid email or password');

  // Hospital admins, camp admins and ResQPK admins all sign in by their
  // (unique) login email at this one door. Which of the three they are decides
  // what the dashboard shows them, and the token carries the role rather than
  // the dashboard deciding for itself.
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('email', email)
    .in('role', ['hospital_admin', 'super_admin'])
    .maybeSingle();
  if (!user) throw new Error('Account not found or not authorized');

  if (user.role === 'super_admin') {
    // No facility of their own; they oversee everyone else's.
    const token = signToken({ id: user.id, auth_id: user.auth_id, role: 'super_admin', email });
    return { user, hospital: null, token };
  }

  const { data: hospital } = await supabaseAdmin
    .from('hospitals')
    .select('*')
    .eq('admin_user_id', user.id)
    .maybeSingle();

  const token = signToken({
    id: user.id,
    auth_id: user.auth_id,
    role: 'hospital_admin',
    email,
    hospital_id: hospital?.id,
  });
  return { user, hospital, token };
}

// --- profile ---------------------------------------------------------------

export async function getMyProfile(userId) {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
  if (error || !user) throw new Error('User not found');

  const profile = { ...user };

  if (user.role === 'patient') {
    const { data: medical_profile } = await supabaseAdmin
      .from('medical_profiles')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    profile.medical_profile = medical_profile || null;
  } else if (user.role === 'driver') {
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    profile.driver = driver || null;
  } else if (user.role === 'hospital_admin') {
    const { data: hospital } = await supabaseAdmin
      .from('hospitals')
      .select('*')
      .eq('admin_user_id', user.id)
      .maybeSingle();
    profile.hospital = hospital || null;
  }

  return profile;
}

export async function saveMedicalProfile(userId, profileData) {
  const { data: existing } = await supabaseAdmin
    .from('medical_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    const { data: updated, error } = await supabaseAdmin
      .from('medical_profiles')
      .update(profileData)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return updated;
  }

  const { data: created, error } = await supabaseAdmin
    .from('medical_profiles')
    .insert({ user_id: userId, ...profileData })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return created;
}

// --- admin (internal, not exposed to the public API) -----------------------

export async function createHospitalAdmin({ full_name, email, password, hospital_id, phone }) {
  const adminPhone = await allocateAdminPhone(phone);
  const authUser = await createAuthUser(email, password);

  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .insert({ auth_id: authUser.id, full_name, email, phone: adminPhone, role: 'hospital_admin' })
      .select('id, full_name, email, phone, role, auth_id')
      .single();
    if (userError) throw new Error(userError.message);

    const { error: hospitalError } = await supabaseAdmin
      .from('hospitals')
      .update({ admin_user_id: user.id })
      .eq('id', hospital_id);
    if (hospitalError) throw new Error(hospitalError.message);

    const token = signToken({
      id: user.id,
      auth_id: authUser.id,
      role: 'hospital_admin',
      email,
      hospital_id,
    });
    return { user, token };
  } catch (err) {
    await supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(() => {});
    throw err;
  }
}

export default {
  registerPatient,
  registerDriver,
  loginPatient,
  loginDriver,
  loginHospitalAdmin,
  getMyProfile,
  saveMedicalProfile,
  createHospitalAdmin,
};
