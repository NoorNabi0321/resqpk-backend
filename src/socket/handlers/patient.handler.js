// Patient socket events: subscribing to a case's live updates and reporting
// the patient's own position while the driver is en route to pick them up.
import { EVENTS, ROOMS } from '../socket.events.js';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../../middleware/logger.js';

export default function patientHandler(io, socket) {
  // EVENT 1 — join the live room for the patient's own active case.
  socket.on(EVENTS.PATIENT.PATIENT_JOIN_CASE, async (data, callback) => {
    try {
      const caseId = data?.caseId;
      if (!caseId) {
        if (typeof callback === 'function') callback({ success: false, error: 'caseId required' });
        return;
      }

      // Ownership check + details in one query (filtered by patient_id).
      const { data: caseDetails } = await supabaseAdmin
        .from('emergency_cases')
        .select(
          '*, driver:drivers(current_lat, current_lng, heading, vehicle_number, users(full_name))',
        )
        .eq('id', caseId)
        .eq('patient_id', socket.userId)
        .maybeSingle();

      if (!caseDetails) {
        if (typeof callback === 'function') callback({ success: false, error: 'Case not found' });
        return;
      }

      socket.join(ROOMS.caseRoom(caseId));
      socket.activeCaseId = caseId;

      const driver = caseDetails.driver;
      const driverLocation = driver
        ? { lat: driver.current_lat, lng: driver.current_lng, heading: driver.heading }
        : null;

      logger.info(`Patient ${socket.userId} joined case room: ${caseId}`);

      if (typeof callback === 'function') {
        callback({ success: true, case: caseDetails, driverLocation });
      }
    } catch (err) {
      logger.error(`patient join_case error: ${err.message}`);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // EVENT 2 — leave the case room (case completed/cancelled).
  socket.on(EVENTS.PATIENT.PATIENT_LEAVE_CASE, (data) => {
    const caseId = data?.caseId;
    if (caseId) socket.leave(ROOMS.caseRoom(caseId));
    socket.activeCaseId = null;
    logger.info(`Patient ${socket.userId} left case room: ${caseId}`);
  });

  // EVENT 3 — patient's live position (so the driver can find them).
  socket.on(EVENTS.PATIENT.PATIENT_LOCATION_UPDATE, async (data) => {
    try {
      const { lat, lng } = data || {};
      if (lat == null || lng == null) return;

      await supabaseAdmin
        .from('users')
        .update({
          last_known_lat: lat,
          last_known_lng: lng,
          last_location_updated_at: new Date().toISOString(),
        })
        .eq('id', socket.userId);

      if (socket.activeCaseId) {
        io.to(ROOMS.caseRoom(socket.activeCaseId)).emit('patient:position_update', {
          lat,
          lng,
          patientId: socket.userId,
        });
      }
    } catch (err) {
      logger.error(`patient location_update error: ${err.message}`);
    }
  });
}
