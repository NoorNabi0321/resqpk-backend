// Driver socket events: availability toggling and the high-frequency GPS
// location stream that powers patient tracking + ETA.
import { EVENTS, ROOMS } from '../socket.events.js';
import etaService from '../../services/eta.service.js';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../../middleware/logger.js';

// Reject GPS readings outside Pakistan (bad/spoofed data).
const PK_BOUNDS = { minLat: 23.0, maxLat: 37.5, minLng: 60.0, maxLng: 77.5 };

function isValidPkCoord(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= PK_BOUNDS.minLat &&
    lat <= PK_BOUNDS.maxLat &&
    lng >= PK_BOUNDS.minLng &&
    lng <= PK_BOUNDS.maxLng
  );
}

export default function driverHandler(io, socket) {
  const driverId = socket.driverId;

  // EVENT 1 — go online (becomes available for dispatch).
  socket.on(EVENTS.DRIVER.DRIVER_GO_ONLINE, async (data, callback) => {
    try {
      const { lat, lng, heading } = data || {};
      await supabaseAdmin
        .from('drivers')
        .update({
          is_available: true,
          current_lat: lat,
          current_lng: lng,
          heading,
          location_updated_at: new Date().toISOString(),
        })
        .eq('id', driverId);

      logger.info(`Driver ${driverId} went online at ${lat},${lng}`);

      io.emit(EVENTS.DRIVER.DRIVER_STATUS_CHANGED, {
        driverId,
        isAvailable: true,
        lat,
        lng,
      });

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      logger.error(`go_online error: ${err.message}`);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // EVENT 2 — go offline.
  socket.on(EVENTS.DRIVER.DRIVER_GO_OFFLINE, async (data, callback) => {
    try {
      await supabaseAdmin.from('drivers').update({ is_available: false }).eq('id', driverId);
      io.emit(EVENTS.DRIVER.DRIVER_STATUS_CHANGED, { driverId, isAvailable: false });
      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      logger.error(`go_offline error: ${err.message}`);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // EVENT 3 — location update. Called every ~5s while the driver is active.
  // Must never crash the server, so everything is wrapped.
  socket.on(EVENTS.DRIVER.DRIVER_LOCATION_UPDATE, async (data) => {
    try {
      const { lat, lng, heading, speed, caseId } = data || {};
      if (!isValidPkCoord(lat, lng)) {
        logger.warn(`Ignoring invalid driver location: ${lat},${lng}`);
        return;
      }

      await etaService.updateDriverLocationInDB(driverId, lat, lng, heading, speed);

      const payload = {
        driverId,
        lat,
        lng,
        heading,
        speed,
        timestamp: new Date().toISOString(),
      };

      // Anyone watching this driver's room (e.g. a tracking dashboard).
      io.to(ROOMS.driverRoom(driverId)).emit(EVENTS.DRIVER.DRIVER_LOCATION_BROADCAST, payload);

      // During an active case, the patient (case room) also hears it + gets ETA.
      if (caseId) {
        io.to(ROOMS.caseRoom(caseId)).emit(EVENTS.DRIVER.DRIVER_LOCATION_BROADCAST, payload);
        await etaService.calculateAndBroadcastETA(io, driverId, lat, lng, caseId);
      }
    } catch (err) {
      logger.error(`location_update error: ${err.message}`);
    }
  });

  // EVENT 4 — heading-only update (lightweight, for smooth marker rotation).
  socket.on(EVENTS.DRIVER.DRIVER_HEADING_UPDATE, async (data) => {
    try {
      const { heading } = data || {};
      await supabaseAdmin.from('drivers').update({ heading }).eq('id', driverId);
      io.to(ROOMS.driverRoom(driverId)).emit(EVENTS.DRIVER.DRIVER_HEADING_UPDATE, {
        driverId,
        heading,
      });
    } catch (err) {
      logger.error(`heading_update error: ${err.message}`);
    }
  });
}
