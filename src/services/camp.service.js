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

/**
 * A camp correcting its own details.
 *
 * Dates run out, a service gets added, the tent moves to the other end of the
 * ground. Until now none of that could be fixed without an administrator
 * editing the database, so a camp whose dates had passed simply vanished from
 * the app with nothing it could do about it.
 *
 * What a camp may not change about itself: whether it is approved, whether it
 * is a camp at all, and whose account owns it.
 */
export async function updateCampProfile(campId, input = {}) {
  const { data: existing } = await supabaseAdmin
    .from('hospitals')
    .select('id, facility_type')
    .eq('id', campId)
    .maybeSingle();
  if (!existing) throw new Error('Camp not found');
  if (existing.facility_type !== 'medical_camp') {
    throw new Error('This account is not a medical camp');
  }

  const patch = {};
  const text = (v) => (v == null ? null : String(v).trim() || null);

  if ('campName' in input) {
    const name = text(input.campName);
    if (!name) throw new Error('Camp name is required');
    patch.name = name;
    patch.short_name = name.slice(0, 30);
  }
  if ('organizerName' in input) {
    const organizer = text(input.organizerName);
    if (!organizer) throw new Error('Organizer name is required');
    patch.organizer_name = organizer;
  }
  if ('description' in input) patch.description = text(input.description);
  if ('address' in input) patch.address = text(input.address);
  if ('contactPhone' in input) patch.emergency_phone = text(input.contactPhone);

  if ('servicesOffered' in input) {
    const services = Array.isArray(input.servicesOffered)
      ? input.servicesOffered.map(text).filter(Boolean)
      : [];
    if (services.length === 0) throw new Error('At least one service must be offered');
    patch.services_offered = services;
  }

  if ('startDate' in input || 'endDate' in input) {
    const start = toDateOnly(input.startDate);
    const end = toDateOnly(input.endDate);
    if (!start || !end) throw new Error('Valid start and end dates are required');
    if (start > end) throw new Error('Start date must be on or before the end date');
    patch.camp_start_date = start;
    patch.camp_end_date = end;
  }

  if ('lat' in input || 'lng' in input) {
    const latNum = Number(input.lat);
    const lngNum = Number(input.lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      throw new Error('Valid coordinates are required');
    }
    if (
      latNum < PK_BOUNDS.minLat || latNum > PK_BOUNDS.maxLat
      || lngNum < PK_BOUNDS.minLng || lngNum > PK_BOUNDS.maxLng
    ) {
      throw new Error('Coordinates must be within Pakistan');
    }
    patch.lat = latNum;
    patch.lng = lngNum;
  }

  if ('isActive' in input) patch.is_active = input.isActive === true;

  if (Object.keys(patch).length === 0) throw new Error('Nothing to update');

  const { error } = await supabaseAdmin.from('hospitals').update(patch).eq('id', campId);
  if (error) throw new Error(error.message);

  logger.info(`Camp ${campId} updated its own profile`);
  return getCampDashboardData(campId);
}

export default {
  registerCamp,
  getNearbyCamps,
  getCampDetails,
  getCampDashboardData,
  updateCampProfile,
};
