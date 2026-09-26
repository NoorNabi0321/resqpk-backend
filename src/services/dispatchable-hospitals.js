// The one definition of "a hospital an ambulance may be sent to".
//
// It used to be spelled out at four call sites as is_active plus
// has_emergency_ward, and both of the things it was missing mattered:
//
//   facility_type — hospitals and medical camps share this table. Camps are
//   inserted with has_emergency_ward false, so they were excluded by accident
//   rather than on purpose. One camp registered with that flag set and a free
//   eye clinic becomes an ambulance destination.
//
//   is_approved — nothing filtered on it. It did not show while hospitals were
//   only ever created by hand; the moment a hospital can register itself, an
//   unvetted one could be auto-assigned and driven to, which is a way to have
//   a patient delivered to an address of someone else's choosing.
//
// Anything selecting a destination goes through here.
export function dispatchable(query) {
  return query
    .eq('facility_type', 'hospital')
    .eq('is_approved', true)
    .eq('is_active', true)
    .eq('has_emergency_ward', true);
}

/** The same rules, for a row already fetched. Returns null or a reason. */
export function whyNotDispatchable(hospital) {
  if (!hospital) return 'Hospital not found';
  if (hospital.facility_type && hospital.facility_type !== 'hospital') {
    return 'That is a medical camp, not a hospital';
  }
  if (!hospital.is_approved) return 'Hospital is not approved yet';
  if (!hospital.is_active) return 'Hospital not found';
  if (!hospital.has_emergency_ward) return 'Hospital has no emergency ward';
  return null;
}

export default { dispatchable, whyNotDispatchable };
