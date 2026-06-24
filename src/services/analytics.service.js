import { supabaseAdmin } from '../config/supabase.js';

// Pakistan is UTC+5 (no DST). Aggregations are bucketed by PKT calendar days.
const PKT_OFFSET_MS = 5 * 3600 * 1000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function pktDayString(d = new Date()) {
  return new Date(d.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

function responseMinutes(row) {
  if (!row.sos_triggered_at || !row.driver_assigned_at) return null;
  const m = (new Date(row.driver_assigned_at) - new Date(row.sos_triggered_at)) / 60000;
  return m >= 0 ? m : null;
}

function avg(nums) {
  if (!nums.length) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

async function getOverview(hospitalId) {
  if (!hospitalId) throw new Error('No hospital associated with this account');
  const start = new Date(`${pktDayString()}T00:00:00+05:00`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const { data, error } = await supabaseAdmin
    .from('emergency_cases')
    .select('status, urgency_level, sos_triggered_at, driver_assigned_at')
    .eq('hospital_id', hospitalId)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());
  if (error) throw new Error(error.message);

  const rows = data || [];
  const countUrg = (u) => rows.filter((r) => r.urgency_level === u).length;
  return {
    totalCasesToday: rows.length,
    activeCases: rows.filter((r) =>
      ['driver_assigned', 'en_route', 'arrived'].includes(r.status),
    ).length,
    avgResponseTimeMinutes: avg(rows.map(responseMinutes).filter((m) => m != null)),
    resolvedCases: rows.filter((r) => r.status === 'completed').length,
    criticalCases: countUrg('critical'),
    moderateCases: countUrg('moderate'),
    lowCases: countUrg('low'),
  };
}

async function getWeeklyResponseTimes(hospitalId) {
  if (!hospitalId) throw new Error('No hospital associated with this account');
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const { data, error } = await supabaseAdmin
    .from('emergency_cases')
    .select('created_at, sos_triggered_at, driver_assigned_at')
    .eq('hospital_id', hospitalId)
    .gte('created_at', start.toISOString())
    .not('driver_assigned_at', 'is', null);
  if (error) throw new Error(error.message);

  const buckets = {}; // dayStr -> minutes[]
  for (const r of data || []) {
    const m = responseMinutes(r);
    if (m == null) continue;
    const dayStr = pktDayString(new Date(r.created_at));
    (buckets[dayStr] ??= []).push(m);
  }

  const out = [];
  for (let i = 6; i >= 0; i--) {
    const dayStr = pktDayString(new Date(now.getTime() - i * 24 * 3600 * 1000));
    const mins = buckets[dayStr] || [];
    out.push({
      day: DAY_NAMES[new Date(`${dayStr}T12:00:00Z`).getUTCDay()],
      date: dayStr,
      avgMinutes: avg(mins),
      cases: mins.length,
    });
  }
  return out;
}

async function getEmergencyTypes(hospitalId) {
  if (!hospitalId) throw new Error('No hospital associated with this account');
  const monthStart = new Date(`${pktDayString().slice(0, 7)}-01T00:00:00+05:00`);

  const { data, error } = await supabaseAdmin
    .from('emergency_cases')
    .select('emergency_type')
    .eq('hospital_id', hospitalId)
    .gte('created_at', monthStart.toISOString());
  if (error) throw new Error(error.message);

  const counts = {};
  for (const r of data || []) {
    const t = r.emergency_type || 'Unknown';
    counts[t] = (counts[t] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

async function getHourlyHeatmap(hospitalId) {
  if (!hospitalId) throw new Error('No hospital associated with this account');
  const monthStart = new Date(`${pktDayString().slice(0, 7)}-01T00:00:00+05:00`);

  const { data, error } = await supabaseAdmin
    .from('emergency_cases')
    .select('created_at')
    .eq('hospital_id', hospitalId)
    .gte('created_at', monthStart.toISOString());
  if (error) throw new Error(error.message);

  const grid = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sunday: 0,
    monday: 0,
    tuesday: 0,
    wednesday: 0,
    thursday: 0,
    friday: 0,
    saturday: 0,
  }));

  for (const r of data || []) {
    // Shift to PKT then read UTC fields to get the local hour/weekday.
    const pkt = new Date(new Date(r.created_at).getTime() + PKT_OFFSET_MS);
    grid[pkt.getUTCHours()][DAY_KEYS[pkt.getUTCDay()]] += 1;
  }
  return grid;
}

export default {
  getOverview,
  getWeeklyResponseTimes,
  getEmergencyTypes,
  getHourlyHeatmap,
};
