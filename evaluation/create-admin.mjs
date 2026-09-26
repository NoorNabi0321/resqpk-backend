// Creates the first ResQPK super_admin — the account that approves hospitals
// and medical camps.
//
// There is deliberately no self-signup for this role. An approval queue that
// anyone can join the deciding side of is not a queue, so the first one is
// made here, by someone with the service key, and every one after that should
// be made the same way.
//
// The password is yours and is never written down by this script. Set it in
// the environment for one command and it is gone with the shell:
//
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PHONE=03001234567 \
//   ADMIN_PASSWORD='...' node evaluation/create-admin.mjs
//
// Re-running with an email that already exists promotes that account rather
// than failing, so a mistyped role can be corrected without touching SQL.
import 'dotenv/config';
import { supabaseAdmin } from '../src/config/supabase.js';

const email = process.env.ADMIN_EMAIL?.trim();
const password = process.env.ADMIN_PASSWORD;
const fullName = process.env.ADMIN_NAME?.trim();
const phone = process.env.ADMIN_PHONE?.trim();

if (!email || !password || !fullName) {
  console.error('ADMIN_EMAIL, ADMIN_PASSWORD and ADMIN_NAME are all required.');
  console.error(
    "\n  ADMIN_EMAIL=you@example.com ADMIN_NAME='Your Name' ADMIN_PHONE=03001234567 \\\n"
    + "  ADMIN_PASSWORD='...' node evaluation/create-admin.mjs\n",
  );
  process.exit(1);
}
if (password.length < 8) {
  console.error('Choose a password of at least 8 characters.');
  process.exit(1);
}

const { data: existing } = await supabaseAdmin
  .from('users')
  .select('id, role, full_name')
  .eq('email', email)
  .maybeSingle();

if (existing) {
  if (existing.role === 'super_admin') {
    console.log(`${email} is already a super_admin. Nothing to do.`);
    process.exit(0);
  }
  const { error } = await supabaseAdmin
    .from('users')
    .update({ role: 'super_admin' })
    .eq('id', existing.id);
  if (error) {
    console.error(`Could not promote the account: ${error.message}`);
    process.exit(1);
  }
  console.log(`Promoted ${email} from ${existing.role} to super_admin.`);
  console.log('Sign in at the dashboard with the password that account already had.');
  process.exit(0);
}

// New account. Supabase Auth owns the password; we never store or print it.
const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (authError) {
  console.error(`Could not create the login: ${authError.message}`);
  process.exit(1);
}

const { error: rowError } = await supabaseAdmin.from('users').insert({
  auth_id: authUser.user.id,
  full_name: fullName,
  email,
  // users.phone is NOT NULL; a placeholder keeps the row legal for an account
  // that signs in by email and is never called.
  phone: phone || `admin-${Date.now()}`,
  role: 'super_admin',
});
if (rowError) {
  // Do not leave an auth login with no profile behind it.
  await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
  console.error(`Could not create the profile: ${rowError.message}`);
  process.exit(1);
}

console.log(`Created super_admin ${fullName} <${email}>.`);
console.log('Sign in at the dashboard with the password you just set.');
process.exit(0);
