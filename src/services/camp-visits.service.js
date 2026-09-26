// Patients seen at a medical camp.
//
// Every function here takes campId and filters on it. That is not belt and
// braces — it is the only thing standing between one camp and another camp's
// medical records, because the API talks to Postgres through the service role
// and row level security does not apply to it. A query in this file that
// forgets its camp_id is a data breach, so there are no queries in this file
// that can be called without one.
import { supabaseAdmin } from '../config/supabase.js';
import logger from '../middleware/logger.js';

const GENDERS = ['male', 'female', 'other'];

/** Today in Pakistan, which is the day a camp desk means by "today". */
function todayPkt() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function toDto(row) {
  return {
    id: row.id,
    visitedOn: row.visited_on,
    patientName: row.patient_name,
    age: row.age,
    gender: row.gender,
    phone: row.phone,
    servicesGiven: row.services_given || [],
    bloodPressure: row.blood_pressure,
    bloodSugar: row.blood_sugar,
    findings: row.findings,
    needsFollowup: !!row.needs_followup,
    followupNote: row.followup_note,
    createdAt: row.created_at,
  };
}

/** Rejects anything that is not this camp, before a record is written to it. */
async function assertIsCamp(campId) {
  const { data } = await supabaseAdmin
    .from('hospitals')
    .select('id, facility_type, services_offered')
    .eq('id', campId)
    .maybeSingle();
  if (!data) throw new Error('Camp not found');
  if (data.facility_type !== 'medical_camp') {
    throw new Error('This account is not a medical camp');
  }
  return data;
}

function clean(value) {
  const s = value == null ? '' : String(value).trim();
  return s === '' ? null : s;
}

export async function recordVisit(campId, recordedByUserId, input = {}) {
  await assertIsCamp(campId);

  const patientName = clean(input.patientName);
  if (!patientName) throw new Error('A name is required');

  const age = input.age == null || input.age === '' ? null : Number(input.age);
  if (age != null && (!Number.isFinite(age) || age < 0 || age > 130)) {
    throw new Error('Age must be between 0 and 130');
  }

  const gender = clean(input.gender);
  if (gender && !GENDERS.includes(gender)) throw new Error('Invalid gender');

  const services = Array.isArray(input.servicesGiven)
    ? input.servicesGiven.map(clean).filter(Boolean)
    : [];

  const needsFollowup = input.needsFollowup === true;

  const { data, error } = await supabaseAdmin
    .from('camp_visits')
    .insert({
      camp_id: campId,
      // The desk may be catching up on yesterday's book; default to today.
      visited_on: clean(input.visitedOn) || todayPkt(),
      patient_name: patientName,
      age,
      gender,
      phone: clean(input.phone),
      services_given: services,
      blood_pressure: clean(input.bloodPressure),
      blood_sugar: clean(input.bloodSugar),
      findings: clean(input.findings),
      needs_followup: needsFollowup,
      followup_note: needsFollowup ? clean(input.followupNote) : null,
      recorded_by: recordedByUserId || null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  return toDto(data);
}

export async function updateVisit(campId, visitId, input = {}) {
  const patch = {};
  if ('patientName' in input) {
    const name = clean(input.patientName);
    if (!name) throw new Error('A name is required');
    patch.patient_name = name;
  }
  if ('age' in input) {
    const age = input.age == null || input.age === '' ? null : Number(input.age);
    if (age != null && (!Number.isFinite(age) || age < 0 || age > 130)) {
      throw new Error('Age must be between 0 and 130');
    }
    patch.age = age;
  }
  if ('gender' in input) {
    const gender = clean(input.gender);
    if (gender && !GENDERS.includes(gender)) throw new Error('Invalid gender');
    patch.gender = gender;
  }
  if ('phone' in input) patch.phone = clean(input.phone);
  if ('servicesGiven' in input) {
    patch.services_given = Array.isArray(input.servicesGiven)
      ? input.servicesGiven.map(clean).filter(Boolean)
      : [];
  }
  if ('bloodPressure' in input) patch.blood_pressure = clean(input.bloodPressure);
  if ('bloodSugar' in input) patch.blood_sugar = clean(input.bloodSugar);
  if ('findings' in input) patch.findings = clean(input.findings);
  if ('needsFollowup' in input) patch.needs_followup = input.needsFollowup === true;
  if ('followupNote' in input) patch.followup_note = clean(input.followupNote);
  if ('visitedOn' in input && clean(input.visitedOn)) patch.visited_on = clean(input.visitedOn);

  if (Object.keys(patch).length === 0) throw new Error('Nothing to update');

  // camp_id in the filter, not just the id: without it, any camp could edit
  // any record by guessing a uuid.
  const { data, error } = await supabaseAdmin
    .from('camp_visits')
    .update(patch)
    .eq('id', visitId)
    .eq('camp_id', campId)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Record not found');

  return toDto(data);
}

export async function deleteVisit(campId, visitId) {
  const { data, error } = await supabaseAdmin
    .from('camp_visits')
    .delete()
    .eq('id', visitId)
    .eq('camp_id', campId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Record not found');
  logger.info(`Camp ${campId} deleted visit ${visitId}`);
  return { success: true };
}

/**
 * The register, filtered.
 *
 * @param {object} opts date (YYYY-MM-DD), from/to, search, followupOnly, page
 */
export async function listVisits(campId, opts = {}) {
  const limit = Math.min(Number(opts.limit) || 50, 200);
  const page = Math.max(Number(opts.page) || 0, 0);

  let query = supabaseAdmin
    .from('camp_visits')
    .select('*', { count: 'exact' })
    .eq('camp_id', campId);

  if (opts.date) query = query.eq('visited_on', opts.date);
  if (opts.from) query = query.gte('visited_on', opts.from);
  if (opts.to) query = query.lte('visited_on', opts.to);
  if (opts.followupOnly === true || opts.followupOnly === 'true') {
    query = query.eq('needs_followup', true);
  }
  const search = clean(opts.search);
  if (search) {
    // Name or phone — the two things a desk has when someone comes back.
    query = query.or(`patient_name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(page * limit, page * limit + limit - 1);
  if (error) throw new Error(error.message);

  return {
    visits: (data || []).map(toDto),
    total: count || 0,
    page,
    limit,
  };
}

/**
 * What the camp has done — today, and over its whole run.
 *
 * Counted in the database rather than by pulling every row back, because a
 * busy camp will have thousands and the desk tablet should not be paging
 * through them to show a number.
 */
export async function getSummary(campId) {
  const camp = await assertIsCamp(campId);
  const today = todayPkt();

  const countWhere = async (build) => {
    const { count, error } = await build(
      supabaseAdmin.from('camp_visits').select('id', { count: 'exact', head: true }).eq('camp_id', campId),
    );
    if (error) throw new Error(error.message);
    return count || 0;
  };

  const [todayCount, totalCount, followupCount] = await Promise.all([
    countWhere((q) => q.eq('visited_on', today)),
    countWhere((q) => q),
    countWhere((q) => q.eq('needs_followup', true)),
  ]);

  // Per-service tally for today. Bounded by the day, so this stays small.
  const { data: todayRows, error } = await supabaseAdmin
    .from('camp_visits')
    .select('services_given')
    .eq('camp_id', campId)
    .eq('visited_on', today);
  if (error) throw new Error(error.message);

  const tally = {};
  for (const service of camp.services_offered || []) tally[service] = 0;
  for (const row of todayRows || []) {
    for (const service of row.services_given || []) {
      tally[service] = (tally[service] || 0) + 1;
    }
  }

  return {
    date: today,
    seenToday: todayCount,
    seenTotal: totalCount,
    awaitingFollowup: followupCount,
    servicesToday: Object.entries(tally)
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Every record for this camp, oldest first, for the CSV download. */
export async function exportVisits(campId, opts = {}) {
  let query = supabaseAdmin.from('camp_visits').select('*').eq('camp_id', campId);
  if (opts.from) query = query.gte('visited_on', opts.from);
  if (opts.to) query = query.lte('visited_on', opts.to);

  const { data, error } = await query.order('visited_on', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(toDto);
}

export default {
  recordVisit,
  updateVisit,
  deleteVisit,
  listVisits,
  getSummary,
  exportVisits,
};
