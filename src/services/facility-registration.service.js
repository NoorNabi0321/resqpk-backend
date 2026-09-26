// Hospital self-registration.
//
// The mirror of registerCamp, and the reason the approval queue has to exist.
// A camp that slips through unapproved shows a free eye test in the wrong
// place; a hospital that slips through can be sent ambulances, which is a way
// to have a patient driven to an address of someone else's choosing. So this
// lands is_approved false like a camp, and dispatch already refuses anything
// that is not approved and active.
import { supabaseAdmin } from '../config/supabase.js';
import logger from '../middleware/logger.js';
import authService from './auth.service.js';

// Roughly Pakistan. Shared intent with camp.service — a hospital pinned in the
// sea is a typo, not a hospital.
const PK_BOUNDS = { minLat: 23.5, maxLat: 37.1, minLng: 60.8, maxLng: 77.9 };

const HOSPITAL_TYPES = ['public', 'private', 'charity', 'military'];

export async function registerHospital({
  hospitalName,
  hospitalType,
  address,
  city,
  lat,
  lng,
  phone,
  emergencyPhone,
  hasEmergencyWard,
  hasIcu,
  hasTraumaCenter,
  totalBeds,
  specialties,
  adminEmail,
  adminPassword,
  adminFullName,
}) {
  if (!hospitalName || !String(hospitalName).trim()) throw new Error('Hospital name is required');
  if (!address || !String(address).trim()) throw new Error('Address is required');
  if (!adminEmail || !adminPassword || !adminFullName) {
    throw new Error('Admin email, password and full name are required');
  }
  if (hospitalType && !HOSPITAL_TYPES.includes(hospitalType)) {
    throw new Error(`Hospital type must be one of: ${HOSPITAL_TYPES.join(', ')}`);
  }

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new Error('Valid coordinates are required');
  }
  if (
    latNum < PK_BOUNDS.minLat || latNum > PK_BOUNDS.maxLat
    || lngNum < PK_BOUNDS.minLng || lngNum > PK_BOUNDS.maxLng
  ) {
    throw new Error('Coordinates must be within Pakistan');
  }

  const beds = totalBeds == null || totalBeds === '' ? 0 : Number(totalBeds);
  if (!Number.isFinite(beds) || beds < 0) throw new Error('Total beds must be a positive number');

  const { data: hospital, error } = await supabaseAdmin
    .from('hospitals')
    .insert({
      name: String(hospitalName).trim(),
      short_name: String(hospitalName).trim().slice(0, 30),
      facility_type: 'hospital',
      hospital_type: hospitalType || 'private',
      // Not visible, and not dispatchable, until an admin says so.
      is_approved: false,
      is_active: true,
      address: String(address).trim(),
      city: city || 'Hyderabad',
      lat: latNum,
      lng: lngNum,
      phone: phone || null,
      emergency_phone: emergencyPhone || phone || null,
      has_emergency_ward: hasEmergencyWard !== false,
      has_icu: hasIcu === true,
      has_trauma_center: hasTraumaCenter === true,
      total_beds: beds,
      specialties: Array.isArray(specialties) ? specialties.filter(Boolean) : [],
    })
    .select('id, name')
    .single();
  if (error) throw new Error(`Hospital registration failed: ${error.message}`);

  // Same rollback as camps: a facility nobody can sign in to is worse than no
  // facility, because it sits in the approval queue looking real.
  try {
    await authService.createHospitalAdmin({
      full_name: adminFullName,
      email: adminEmail,
      password: adminPassword,
      hospital_id: hospital.id,
      phone: emergencyPhone || phone,
    });
  } catch (err) {
    await supabaseAdmin.from('hospitals').delete().eq('id', hospital.id);
    throw new Error(`Hospital admin account could not be created: ${err.message}`);
  }

  logger.info(`Hospital registered: ${hospital.name} (${hospital.id}) — pending approval`);
  return {
    hospitalId: hospital.id,
    message: 'Hospital registered. Pending ResQPK approval before it can receive emergencies.',
  };
}

export default { registerHospital };
