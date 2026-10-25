// The facts the report PDF header needs that do not live on ai_reports: who
// the patient is, which ambulance is carrying them, which ward is expecting
// them, and how long until they walk through the door.
//
// Gathered here because the PDF is now built twice — once when the report is
// generated, and again when the clarification answers finish refining it — and
// a ward comparing the two should not find the second one missing the driver.
import { supabaseAdmin } from '../../config/supabase.js';
import mapsService from '../maps.service.js';

export const CASE_COLUMNS = `id, case_number, access_code, patient_address, patient_lat, patient_lng,
   sos_triggered_at, hospital_id, driver_id, reporter_name, reporter_phone,
   reported_for, channel`;

// Minutes from where the ambulance is to where it is going. Null unless both
// ends are known.
//
// Estimated rather than asked of the routing API: this runs in the middle of
// report generation, which is already slow, and a minute either way does not
// change what the ward does.
const ROAD_FACTOR = 1.3; // streets are not straight lines
const CITY_SPEED_KMH = 30; // an ambulance through Hyderabad traffic

export function estimateEtaMinutes(driverRow, hospitalRow) {
  const dLat = Number(driverRow?.current_lat);
  const dLng = Number(driverRow?.current_lng);
  const hLat = Number(hospitalRow?.lat);
  const hLng = Number(hospitalRow?.lng);
  if (![dLat, dLng, hLat, hLng].every(Number.isFinite)) return null;

  const metres = mapsService.haversineDistance(dLat, dLng, hLat, hLng) * ROAD_FACTOR;
  const minutes = Math.round((metres / 1000 / CITY_SPEED_KMH) * 60);
  return Math.max(minutes, 1);
}

/// Builds the `caseData` argument the PDF builder takes.
///
/// `caseRow` is passed in when the caller already has it — the pipeline reads
/// it back from its own update — and fetched otherwise. Returns null only when
/// the case itself cannot be found.
export async function loadReportPdfContext(caseId, patientId, caseRow = null) {
  let row = caseRow;
  if (!row) {
    const { data } = await supabaseAdmin
      .from('emergency_cases')
      .select(CASE_COLUMNS)
      .eq('id', caseId)
      .maybeSingle();
    row = data;
  }
  if (!row) return null;

  const [{ data: patientUser }, { data: hospitalRow }, { data: driverRow }] = await Promise.all([
    patientId
      ? supabaseAdmin.from('users').select('full_name, phone').eq('id', patientId).maybeSingle()
      : Promise.resolve({ data: null }),
    row.hospital_id
      ? supabaseAdmin
          .from('hospitals')
          .select('name, lat, lng')
          .eq('id', row.hospital_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    row.driver_id
      ? supabaseAdmin
          .from('drivers')
          .select('vehicle_number, current_lat, current_lng, users(full_name)')
          .eq('id', row.driver_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    hospitalId: row.hospital_id || null,
    caseData: {
      id: caseId,
      case_number: row.case_number,
      access_code: row.access_code,
      patient_name: patientUser?.full_name || row.reporter_name,
      patient_phone: patientUser?.phone,
      reporter_name: row.reporter_name,
      reporter_phone: row.reporter_phone,
      reported_for: row.reported_for,
      channel: row.channel,
      patient_address: row.patient_address,
      patient_lat: row.patient_lat,
      patient_lng: row.patient_lng,
      sos_triggered_at: row.sos_triggered_at,
      hospital_name: hospitalRow?.name,
      driver_name: driverRow?.users?.full_name,
      vehicle_number: driverRow?.vehicle_number,
      eta_minutes: estimateEtaMinutes(driverRow, hospitalRow),
    },
  };
}

export default { loadReportPdfContext, estimateEtaMinutes, CASE_COLUMNS };
