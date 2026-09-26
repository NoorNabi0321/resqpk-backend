// ResQPK administration: who is allowed to appear in the app.
//
// Hospitals and medical camps both register themselves and both land
// unapproved. Until this existed, is_approved could only be flipped by editing
// the database, which is why four camps sat pending since July. A hospital in
// particular must not be approvable by whoever filled in the form: an
// unapproved hospital that could receive dispatches would be a way to have
// ambulances sent to an address of your choosing.
import { supabaseAdmin } from '../config/supabase.js';
import logger from '../middleware/logger.js';

const FACILITY_FIELDS = `
  id, name, short_name, address, city, lat, lng, phone, emergency_phone,
  facility_type, hospital_type, has_emergency_ward, has_icu, has_trauma_center,
  specialties, total_beds, is_active, is_approved,
  camp_start_date, camp_end_date, services_offered, organizer_name, description,
  submitted_at, approved_at, approved_by, rejected_at, rejection_reason,
  created_at, admin_user_id
`;

/** pending | approved | rejected, from the three columns that encode it. */
function statusOf(row) {
  if (row.is_approved) return 'approved';
  if (row.rejected_at) return 'rejected';
  return 'pending';
}

function toDto(row, admin) {
  return {
    id: row.id,
    name: row.name,
    facilityType: row.facility_type,
    status: statusOf(row),
    organizerName: row.organizer_name,
    description: row.description,
    address: row.address,
    city: row.city,
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    phone: row.phone,
    emergencyPhone: row.emergency_phone,
    servicesOffered: row.services_offered || [],
    startDate: row.camp_start_date,
    endDate: row.camp_end_date,
    hasEmergencyWard: !!row.has_emergency_ward,
    hasIcu: !!row.has_icu,
    hasTraumaCenter: !!row.has_trauma_center,
    totalBeds: row.total_beds,
    specialties: row.specialties || [],
    isActive: !!row.is_active,
    submittedAt: row.submitted_at || row.created_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    admin: admin
      ? { id: admin.id, fullName: admin.full_name, email: admin.email, phone: admin.phone }
      : null,
  };
}

/**
 * Facilities awaiting a decision, or already decided.
 *
 * @param {'pending'|'approved'|'rejected'|'all'} status
 * @param {'hospital'|'medical_camp'|'all'} facilityType
 */
export async function listFacilities({ status = 'pending', facilityType = 'all' } = {}) {
  let query = supabaseAdmin.from('hospitals').select(FACILITY_FIELDS);

  if (facilityType !== 'all') query = query.eq('facility_type', facilityType);
  if (status === 'pending') query = query.eq('is_approved', false).is('rejected_at', null);
  else if (status === 'approved') query = query.eq('is_approved', true);
  else if (status === 'rejected') query = query.not('rejected_at', 'is', null);

  // Oldest first for pending — whoever has been waiting longest goes first.
  const { data, error } = await query.order('submitted_at', {
    ascending: status === 'pending',
    nullsFirst: false,
  });
  if (error) throw new Error(error.message);

  const rows = data || [];
  const adminIds = rows.map((r) => r.admin_user_id).filter(Boolean);
  let admins = [];
  if (adminIds.length) {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, phone')
      .in('id', adminIds);
    admins = users || [];
  }

  return rows.map((row) => toDto(row, admins.find((u) => u.id === row.admin_user_id)));
}

/** How many are waiting, for the badge on the admin tab. */
export async function countPending() {
  const { count, error } = await supabaseAdmin
    .from('hospitals')
    .select('id', { count: 'exact', head: true })
    .eq('is_approved', false)
    .is('rejected_at', null);
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function getFacility(facilityId) {
  const { data, error } = await supabaseAdmin
    .from('hospitals')
    .select(FACILITY_FIELDS)
    .eq('id', facilityId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Facility not found');

  let admin = null;
  if (data.admin_user_id) {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, phone')
      .eq('id', data.admin_user_id)
      .maybeSingle();
    admin = user;
  }
  return toDto(data, admin);
}

export async function approveFacility(facilityId, adminUserId) {
  const { data: facility } = await supabaseAdmin
    .from('hospitals')
    .select('id, name, facility_type, is_approved')
    .eq('id', facilityId)
    .maybeSingle();
  if (!facility) throw new Error('Facility not found');
  if (facility.is_approved) throw new Error('Already approved');

  const { error } = await supabaseAdmin
    .from('hospitals')
    .update({
      is_approved: true,
      approved_at: new Date().toISOString(),
      approved_by: adminUserId,
      // A previously refused facility that is now approved should not still
      // read as refused.
      rejected_at: null,
      rejection_reason: null,
    })
    .eq('id', facilityId);
  if (error) throw new Error(error.message);

  logger.info(`Approved ${facility.facility_type} "${facility.name}" (${facilityId})`);
  return getFacility(facilityId);
}

export async function rejectFacility(facilityId, adminUserId, reason) {
  if (!reason || !String(reason).trim()) {
    // A refusal with no reason cannot be answered or appealed, and whoever
    // reads the queue next has no idea why it was turned down.
    throw new Error('A reason is required to reject a facility');
  }

  const { data: facility } = await supabaseAdmin
    .from('hospitals')
    .select('id, name, facility_type')
    .eq('id', facilityId)
    .maybeSingle();
  if (!facility) throw new Error('Facility not found');

  const { error } = await supabaseAdmin
    .from('hospitals')
    .update({
      is_approved: false,
      rejected_at: new Date().toISOString(),
      rejection_reason: String(reason).trim(),
      approved_at: null,
      approved_by: adminUserId,
    })
    .eq('id', facilityId);
  if (error) throw new Error(error.message);

  logger.info(`Rejected ${facility.facility_type} "${facility.name}": ${reason}`);
  return getFacility(facilityId);
}

export default {
  listFacilities,
  countPending,
  getFacility,
  approveFacility,
  rejectFacility,
};
