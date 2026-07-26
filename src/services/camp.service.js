// Medical camps. Camps reuse the hospitals table via
// facility_type = 'medical_camp' and the hospital_admin role for login, so
// they inherit all existing auth with no new role.
//
// Camps are discovery-only for patients: they appear in the app's Nearby Camps
// section when approved AND currently running. Low-urgency redirect routing to
// camps is wired in Phase 6.
import { supabaseAdmin } from '../config/supabase.js';
import mapsService from './maps.service.js';
import authService from './auth.service.js';
import logger from '../middleware/logger.js';

// Rough bounding box for Pakistan — catches swapped lat/lng and bad input.
const PK_BOUNDS = { minLat: 23.5, maxLat: 37.1, minLng: 60.8, maxLng: 77.9 };

function toDateOnly(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function todayDateOnly() {
  // Pakistan is UTC+5 with no DST; camps run on local calendar days.
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysBetween(fromDateOnly, toDateOnlyStr) {
  const ms = new Date(`${toDateOnlyStr}T00:00:00Z`) - new Date(`${fromDateOnly}T00:00:00Z`);
  return Math.round(ms / (24 * 3600 * 1000));
}

function formatDistance(meters) {
  return `${(meters / 1000).toFixed(1)} km`;
}

// Shapes a hospitals row (facility_type = 'medical_camp') for the app.
function toCampDto(row, distanceMeters = null) {
  const today = todayDateOnly();
  return {
    id: row.id,
    name: row.name,
    organizerName: row.organizer_name,
    description: row.description,
    servicesOffered: row.services_offered || [],
    address: row.address,
    lat: Number(row.lat),
    lng: Number(row.lng),
    distanceMeters,
    distanceText: distanceMeters == null ? null : formatDistance(distanceMeters),
    startDate: row.camp_start_date,
    endDate: row.camp_end_date,
    daysRemaining: row.camp_end_date ? Math.max(daysBetween(today, row.camp_end_date), 0) : null,
    contactPhone: row.emergency_phone,
  };
}

// --- 1. Registration (public) ------------------------------------------------

export async function registerCamp({
  campName,
  organizerName,
  description,
  lat,
  lng,
  address,
  servicesOffered,
  startDate,
  endDate,
  contactPhone,
  adminEmail,
  adminPassword,
  adminFullName,
}) {
  if (!campName || !String(campName).trim()) throw new Error('Camp name is required');
  if (!organizerName || !String(organizerName).trim()) throw new Error('Organizer name is required');
  if (!adminEmail || !adminPassword || !adminFullName) {
    throw new Error('Admin email, password and full name are required');
  }
  if (!Array.isArray(servicesOffered) || servicesOffered.length === 0) {
    throw new Error('At least one service must be offered');
  }

  const start = toDateOnly(startDate);
  const end = toDateOnly(endDate);
  if (!start || !end) throw new Error('Valid start and end dates are required');
  if (start > end) throw new Error('Start date must be on or before the end date');
  if (end < todayDateOnly()) throw new Error('End date cannot be in the past');

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new Error('Valid coordinates are required');
  }
  if (
    latNum < PK_BOUNDS.minLat ||
    latNum > PK_BOUNDS.maxLat ||
    lngNum < PK_BOUNDS.minLng ||
    lngNum > PK_BOUNDS.maxLng
  ) {
    throw new Error('Coordinates must be within Pakistan');
  }

  const { data: camp, error } = await supabaseAdmin
    .from('hospitals')
    .insert({
      name: campName,
      short_name: String(campName).slice(0, 30),
      facility_type: 'medical_camp',
      is_approved: false, // awaits manual approval before patients see it
      is_active: true,
      has_emergency_ward: false,
      lat: latNum,
      lng: lngNum,
      address,
      camp_start_date: start,
      camp_end_date: end,
      services_offered: servicesOffered,
      organizer_name: organizerName,
      description,
      emergency_phone: contactPhone,
    })
    .select('id, name')
    .single();
  if (error) throw new Error(`Camp registration failed: ${error.message}`);

  // Create the camp admin login. If this fails the camp row would be orphaned
  // with no way to sign in, so roll it back.
  try {
    await authService.createHospitalAdmin({
      full_name: adminFullName,
      email: adminEmail,
      password: adminPassword,
      hospital_id: camp.id,
      phone: contactPhone,
    });
  } catch (err) {
    await supabaseAdmin.from('hospitals').delete().eq('id', camp.id);
    throw new Error(`Camp admin account could not be created: ${err.message}`);
  }

  logger.info(`Medical camp registered: ${camp.name} (${camp.id}) — pending approval`);
  return {
    campId: camp.id,
    message: 'Camp registered. Pending admin approval before appearing to patients.',
  };
}

// --- 2. Nearby camps (patient app) -------------------------------------------

export async function getNearbyCamps(lat, lng, radiusKm = 25) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new Error('lat and lng are required');
  }

  const today = todayDateOnly();
  const { data, error } = await supabaseAdmin
    .from('hospitals')
    .select('*')
    .eq('facility_type', 'medical_camp')
    .eq('is_approved', true)
    .eq('is_active', true)
    .lte('camp_start_date', today)
    .gte('camp_end_date', today);
  if (error) throw new Error(error.message);

  const radiusMeters = Number(radiusKm) * 1000;
  return (data || [])
    .filter((row) => row.lat != null && row.lng != null)
    .map((row) => {
      const distanceMeters = Math.round(
        mapsService.haversineDistance(latNum, lngNum, Number(row.lat), Number(row.lng)),
      );
      return { row, distanceMeters };
    })
    .filter(({ distanceMeters }) => distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .map(({ row, distanceMeters }) => toCampDto(row, distanceMeters));
}

// --- 3. Single camp (public detail) ------------------------------------------

export async function getCampDetails(campId) {
  const { data, error } = await supabaseAdmin
    .from('hospitals')
    .select('*')
    .eq('id', campId)
    .eq('facility_type', 'medical_camp')
    .eq('is_approved', true)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Camp not found');
  return toCampDto(data);
}

// --- 4. Camp's own dashboard -------------------------------------------------

export async function getCampDashboardData(campId) {
  const { data, error } = await supabaseAdmin
    .from('hospitals')
    .select('*')
    .eq('id', campId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Camp not found');
  if (data.facility_type !== 'medical_camp') throw new Error('This account is not a medical camp');

  const today = todayDateOnly();
  const withinDates =
    !!data.camp_start_date &&
    !!data.camp_end_date &&
    data.camp_start_date <= today &&
    data.camp_end_date >= today;

  return {
    camp: toCampDto(data),
    isApproved: !!data.is_approved,
    daysRemaining: data.camp_end_date ? Math.max(daysBetween(today, data.camp_end_date), 0) : null,
    visibleToPatients: !!data.is_approved && !!data.is_active && withinDates,
  };
}

export default { registerCamp, getNearbyCamps, getCampDetails, getCampDashboardData };
