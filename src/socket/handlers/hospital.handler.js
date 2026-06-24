// Hospital dashboard socket events: loading the live case feed + bed status,
// and updating bed availability.
import { EVENTS, ROOMS } from '../socket.events.js';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../../middleware/logger.js';

const VALID_BED_TYPES = ['general', 'icu', 'trauma', 'pediatric', 'maternity'];

export default function hospitalHandler(io, socket) {
  // EVENT 1 — dashboard connects: join the hospital room + return initial data.
  socket.on(EVENTS.HOSPITAL.HOSPITAL_JOIN, async (callback) => {
    try {
      socket.join(ROOMS.hospitalRoom(socket.hospitalId));

      // Active cases for this hospital, with patient/driver/medical/AI joined.
      // medical_profiles has no direct FK to emergency_cases, so it is embedded
      // through the patient (users -> medical_profiles).
      const { data: activeCases } = await supabaseAdmin
        .from('emergency_cases')
        .select(
          `*,
           patient:users(full_name, medical_profiles(blood_group, chronic_conditions, allergies)),
           driver:drivers(vehicle_number, current_lat, current_lng, users(full_name)),
           ai_report:ai_reports(urgency_level, emergency_type, consciousness_state, key_observations, first_aid_suggestion)`,
        )
        .eq('hospital_id', socket.hospitalId)
        .in('status', ['driver_assigned', 'en_route', 'arrived'])
        .order('sos_triggered_at', { ascending: false });

      const { data: beds } = await supabaseAdmin
        .from('hospital_beds')
        .select('*')
        .eq('hospital_id', socket.hospitalId);

      logger.info(`Hospital ${socket.hospitalId} dashboard connected`);

      if (typeof callback === 'function') {
        callback({
          success: true,
          activeCases: activeCases || [],
          beds: beds || [],
          hospitalId: socket.hospitalId,
        });
      }
    } catch (err) {
      logger.error(`hospital join error: ${err.message}`);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // EVENT 2 — staff updates bed availability.
  socket.on(EVENTS.HOSPITAL.BED_STATUS_CHANGED, async (data, callback) => {
    try {
      const { bedType, availableCount, reservedCount } = data || {};
      if (!VALID_BED_TYPES.includes(bedType)) {
        if (typeof callback === 'function') callback({ success: false, error: 'Invalid bed type' });
        return;
      }

      const { error } = await supabaseAdmin.from('hospital_beds').upsert(
        {
          hospital_id: socket.hospitalId,
          bed_type: bedType,
          available_count: availableCount,
          reserved_count: reservedCount,
          updated_by: socket.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'hospital_id,bed_type' },
      );
      if (error) throw new Error(error.message);

      io.to(ROOMS.hospitalRoom(socket.hospitalId)).emit(EVENTS.HOSPITAL.BED_STATUS_CHANGED, {
        hospitalId: socket.hospitalId,
        bedType,
        availableCount,
        reservedCount,
        updatedAt: new Date().toISOString(),
      });

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      logger.error(`bed_status_changed error: ${err.message}`);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });
}
