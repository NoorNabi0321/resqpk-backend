// Sets up the three dashboard logins: ResQPK admin, a hospital, and a camp.
//
// Passwords are never stored or printed by this script. You pass them in the
// environment for one command and they go with the shell. Supabase Auth keeps
// them hashed, which is why nothing — this script included — can read back a
// password that was set earlier. If you have lost one, set a new one here.
//
// Run it as many times as you like: an account that already exists has its
// password reset rather than failing.
//
//   ADMIN_EMAIL=you@example.com \
//   ADMIN_PASSWORD='...' \
//   HOSPITAL_PASSWORD='...' \
//   CAMP_PASSWORD='...' \
//   node evaluation/setup-logins.mjs
//
// Optional, to point at different accounts:
//   HOSPITAL_EMAIL=admin@civilhospital.resqpk.app
//   CAMP_EMAIL=eyecamp+...@test.resqpk.app
import 'dotenv/config';
import { supabaseAdmin } from '../src/config/supabase.js';

const adminEmail = process.env.ADMIN_EMAIL?.trim();
const adminPassword = process.env.ADMIN_PASSWORD;
const adminName = process.env.ADMIN_NAME?.trim() || 'ResQPK Admin';
const hospitalPassword = process.env.HOSPITAL_PASSWORD;
const campPassword = process.env.CAMP_PASSWORD;

const results = [];
const fail = (what, why) => results.push({ ok: false, what, why });
const done = (what, detail) => results.push({ ok: true, what, detail });

function tooShort(password) {
  return !password || password.length < 8;
}

/** Point an existing profile row at a working Supabase Auth login. */
async function setPassword(user, password) {
  if (user.auth_id) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.auth_id, { password });
    if (!error) return null;
    // The auth user may have been deleted underneath the profile; fall through
    // and make a new one rather than leaving an account nobody can sign in to.
    if (!/not found/i.test(error.message)) return error.message;
  }

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: user.email,
    password,
    email_confirm: true,
  });
  if (createError) {
    // Already in auth but not linked to this row — link it.
    const { data: list } = await supabaseAdmin.auth.admin.listUsers();
    const match = list?.users?.find((u) => u.email?.toLowerCase() === user.email.toLowerCase());
    if (!match) return createError.message;
    const { error: updateError } = await supabaseAdmin.auth.admin
      .updateUserById(match.id, { password });
    if (updateError) return updateError.message;
    await supabaseAdmin.from('users').update({ auth_id: match.id }).eq('id', user.id);
    return null;
  }

  await supabaseAdmin.from('users').update({ auth_id: created.user.id }).eq('id', user.id);
  return null;
}

// --- 1. ResQPK admin --------------------------------------------------------

if (!adminEmail || tooShort(adminPassword)) {
  fail('ResQPK admin', 'ADMIN_EMAIL and an ADMIN_PASSWORD of 8+ characters are required');
} else {
  const { data: existing } = await supabaseAdmin
    .from('users').select('id, auth_id, email, role').eq('email', adminEmail).maybeSingle();

  if (existing) {
    if (existing.role !== 'super_admin') {
      await supabaseAdmin.from('users').update({ role: 'super_admin' }).eq('id', existing.id);
    }
    const problem = await setPassword(existing, adminPassword);
    if (problem) fail('ResQPK admin', problem);
    else done('ResQPK admin', `${adminEmail} — password set`);
  } else {
    const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser({
      email: adminEmail, password: adminPassword, email_confirm: true,
    });
    if (error) {
      fail('ResQPK admin', error.message);
    } else {
      const { error: rowError } = await supabaseAdmin.from('users').insert({
        auth_id: authUser.user.id,
        full_name: adminName,
        email: adminEmail,
        // users.phone is NOT NULL, UNIQUE and capped at 20 characters. This
        // account signs in by email and is never called, so it gets a unique
        // placeholder — a fixed one collides the moment there is a second
        // admin, or a second attempt after a failed one.
        phone: process.env.ADMIN_PHONE?.trim()
          || `admin-${Math.random().toString(16).slice(2, 10)}`,
        role: 'super_admin',
      });
      if (rowError) {
        await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
        fail('ResQPK admin', rowError.message);
      } else {
        done('ResQPK admin', `${adminEmail} — created`);
      }
    }
  }
}

// --- 2 and 3. A hospital and a camp ----------------------------------------

async function setUpFacility({ label, facilityType, email, password, activate }) {
  if (tooShort(password)) {
    return fail(label, `a ${label} password of 8+ characters is required`);
  }

  let account = null;
  if (email) {
    const { data } = await supabaseAdmin
      .from('users').select('id, auth_id, email').eq('email', email).maybeSingle();
    if (!data) return fail(label, `no account found for ${email}`);
    account = data;
  } else {
    // Whichever facility of this type already has an admin. Newest first, so
    // repeated runs land on the same one.
    const { data: facilities } = await supabaseAdmin
      .from('hospitals')
      .select('id, name, admin_user_id')
      .eq('facility_type', facilityType)
      .not('admin_user_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!facilities?.length) return fail(label, `no ${facilityType} with an admin account`);
    const { data } = await supabaseAdmin
      .from('users').select('id, auth_id, email').eq('id', facilities[0].admin_user_id).maybeSingle();
    if (!data) return fail(label, 'facility has no profile row');
    account = data;
  }

  const problem = await setPassword(account, password);
  if (problem) return fail(label, problem);

  const { data: facility } = await supabaseAdmin
    .from('hospitals')
    .select('id, name, facility_type, is_approved, camp_end_date')
    .eq('admin_user_id', account.id)
    .maybeSingle();
  if (!facility) return fail(label, 'account is not linked to a facility');

  const patch = {};
  if (!facility.is_approved) {
    patch.is_approved = true;
    patch.approved_at = new Date().toISOString();
    patch.rejected_at = null;
    patch.rejection_reason = null;
  }
  // A camp whose dates have passed is invisible to patients and shows nothing
  // useful on its own dashboard, so give it a run that includes today.
  if (activate && facility.facility_type === 'medical_camp') {
    const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 5 * 3600 * 1000 + 30 * 86400 * 1000)
      .toISOString().slice(0, 10);
    if (!facility.camp_end_date || facility.camp_end_date < today) {
      patch.camp_start_date = today;
      patch.camp_end_date = end;
    }
  }
  if (Object.keys(patch).length) {
    await supabaseAdmin.from('hospitals').update(patch).eq('id', facility.id);
  }

  return done(label, `${account.email} — ${facility.name}`);
}

await setUpFacility({
  label: 'Hospital',
  facilityType: 'hospital',
  email: process.env.HOSPITAL_EMAIL?.trim(),
  password: hospitalPassword,
});

await setUpFacility({
  label: 'Medical camp',
  facilityType: 'medical_camp',
  email: process.env.CAMP_EMAIL?.trim(),
  password: campPassword,
  activate: true,
});

// --- Report -----------------------------------------------------------------

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? 'OK  ' : 'SKIP'}  ${r.what.padEnd(14)} ${r.ok ? r.detail : r.why}`);
}
console.log('\nSign in at the dashboard with the passwords you just set.');
console.log('They are not printed here and are not recoverable — set them again if lost.\n');
