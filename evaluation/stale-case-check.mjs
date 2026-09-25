// Dry run of the stale-case sweep: reports what it would close, and why.
//
// Run with --apply to actually close them.
import 'dotenv/config';
import { supabaseAdmin } from '../src/config/supabase.js';
import { reapStaleCases, staleCaseInternals } from '../src/services/stale-case.service.js';

const { HELD_STATUSES, STALE_AFTER_MS } = staleCaseInternals;
const apply = process.argv.includes('--apply');

const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
const { data: held } = await supabaseAdmin
  .from('emergency_cases')
  .select('case_number, status, updated_at, driver_id')
  .in('status', HELD_STATUSES);

console.log(`Cases holding a driver: ${held?.length ?? 0}`);
for (const c of held || []) {
  const ageH = ((Date.now() - Date.parse(c.updated_at)) / 3600000).toFixed(1);
  const stale = c.updated_at < cutoff;
  console.log(`  ${c.case_number}  ${c.status.padEnd(16)} ${ageH}h old  ${stale ? 'STALE' : 'active'}`);
}

const { data: blocked } = await supabaseAdmin
  .from('drivers')
  .select('id, is_available, location_updated_at, users(full_name)')
  .eq('is_verified', true)
  .not('current_lat', 'is', null);

const fresh = (blocked || []).filter(
  (d) => d.location_updated_at && Date.now() - Date.parse(d.location_updated_at) < 5 * 60 * 1000,
);
console.log(`\nDrivers with a fresh position: ${fresh.length}`);
for (const d of fresh) {
  console.log(`  ${d.users.full_name}: is_available=${d.is_available}`);
}

if (apply) {
  const result = await reapStaleCases(null);
  console.log(`\nSwept: closed ${result.closed}, freed ${result.freed}`);
} else {
  console.log('\n(dry run — pass --apply to close them)');
}
process.exit(0);
