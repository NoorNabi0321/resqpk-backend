// Closes cases that were assigned to a driver and then never finished.
//
// A case sits in driver_assigned/en_route/arrived until someone completes or
// cancels it. Nothing does that if the driver closes the app mid-job, the
// emulator is killed, or a test run is simply abandoned — and the row stays
// open forever.
//
// That is not a tidiness problem. go_online refuses to mark a driver available
// while they hold an open case, so one abandoned case takes that driver out of
// every dispatch ring permanently. The app still says "On duty". The patient
// gets "no driver found" with zero offers, in about a second, with a free
// ambulance two kilometres away. RQ-20260924-0001 did exactly this for 25
// hours.
import { supabaseAdmin } from '../config/supabase.js';
import logger from '../middleware/logger.js';
import { EVENTS, ROOMS } from '../socket/socket.events.js';

// Statuses where a driver is committed to a case.
const HELD_STATUSES = ['driver_assigned', 'en_route', 'arrived'];

// How long a case may go without any update before we call it abandoned.
//
// Generous on purpose: a real job — dispatch, drive, load, hospital — updates
// the row constantly and finishes well inside this. Anything silent for two
// hours is not an ambulance still running.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Close abandoned cases and put their drivers back into dispatch.
 *
 * @param {import('socket.io').Server} [io] when given, drivers still holding a
 *   live socket are made available again immediately and told so, rather than
 *   having to toggle off and on to discover they were freed.
 * @returns {Promise<{closed: number, freed: number}>}
 */
export async function reapStaleCases(io) {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();

  const { data: stale, error } = await supabaseAdmin
    .from('emergency_cases')
    .select('id, case_number, driver_id, status, updated_at')
    .in('status', HELD_STATUSES)
    .lt('updated_at', cutoff);

  if (error) {
    logger.error(`Stale case sweep failed: ${error.message}`);
    return { closed: 0, freed: 0 };
  }
  if (!stale || stale.length === 0) return { closed: 0, freed: 0 };

  const ids = stale.map((c) => c.id);
  const { error: closeError } = await supabaseAdmin
    .from('emergency_cases')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .in('id', ids);

  if (closeError) {
    logger.error(`Could not close stale cases: ${closeError.message}`);
    return { closed: 0, freed: 0 };
  }

  for (const c of stale) {
    logger.warn(
      `Closed abandoned case ${c.case_number} (${c.status}, last touched ${c.updated_at})`,
    );
    // Whoever is watching the case — a patient who left the app open, the
    // hospital dashboard — should not keep waiting on an ambulance that is
    // not coming.
    io?.to(ROOMS.caseRoom(c.id)).emit(EVENTS.EMERGENCY.CASE_CANCELLED, {
      caseId: c.id,
      caseNumber: c.case_number,
      reason: 'abandoned',
    });
  }

  const freed = await freeDrivers(io, stale.map((c) => c.driver_id).filter(Boolean));
  return { closed: stale.length, freed };
}

// Put drivers who are still connected back on duty.
//
// A driver whose socket is gone is left alone: their next go_online will set
// availability correctly, and marking an absent driver available would
// recreate the phantom-driver problem dispatch already guards against.
async function freeDrivers(io, driverIds) {
  if (!io || driverIds.length === 0) return 0;

  const live = driverIds.filter(
    (id) => (io.sockets.adapter.rooms.get(ROOMS.driverRoom(id))?.size ?? 0) > 0,
  );
  if (live.length === 0) return 0;

  const { error } = await supabaseAdmin
    .from('drivers')
    .update({ is_available: true })
    .in('id', live);

  if (error) {
    logger.error(`Could not free drivers after sweep: ${error.message}`);
    return 0;
  }

  for (const id of live) {
    logger.info(`Driver ${id} freed by stale case sweep and back on duty`);
    io.emit(EVENTS.DRIVER.DRIVER_STATUS_CHANGED, {
      driverId: id,
      isAvailable: true,
      reason: 'stale_case_closed',
    });
  }
  return live.length;
}

export const staleCaseInternals = { HELD_STATUSES, STALE_AFTER_MS };
