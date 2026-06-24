// Socket.io event names and room naming. Centralizing these as constants
// prevents typo bugs where the client and server disagree on an event name.

export const EVENTS = Object.freeze({
  CONNECTION: Object.freeze({
    CONNECT: 'connect',
    DISCONNECT: 'disconnect',
    AUTH_ERROR: 'auth_error',
    AUTHENTICATED: 'authenticated',
  }),
  DRIVER: Object.freeze({
    DRIVER_GO_ONLINE: 'driver:go_online',
    DRIVER_GO_OFFLINE: 'driver:go_offline',
    DRIVER_LOCATION_UPDATE: 'driver:location_update',
    DRIVER_LOCATION_BROADCAST: 'driver:location_broadcast',
    DRIVER_STATUS_CHANGED: 'driver:status_changed',
    DRIVER_HEADING_UPDATE: 'driver:heading_update',
  }),
  PATIENT: Object.freeze({
    PATIENT_JOIN_CASE: 'patient:join_case',
    PATIENT_LEAVE_CASE: 'patient:leave_case',
    PATIENT_LOCATION_UPDATE: 'patient:location_update',
  }),
  EMERGENCY: Object.freeze({
    CASE_CREATED: 'emergency:case_created',
    DRIVER_ASSIGNED: 'emergency:driver_assigned',
    DRIVER_EN_ROUTE: 'emergency:driver_en_route',
    DRIVER_ARRIVED: 'emergency:driver_arrived',
    CASE_COMPLETED: 'emergency:case_completed',
    CASE_CANCELLED: 'emergency:case_cancelled',
    NO_DRIVER_FOUND: 'emergency:no_driver_found',
  }),
  ETA: Object.freeze({
    ETA_UPDATE: 'eta:update',
    ETA_REQUEST: 'eta:request',
  }),
  HOSPITAL: Object.freeze({
    HOSPITAL_JOIN: 'hospital:join',
    HOSPITAL_NEW_CASE: 'hospital:new_case',
    HOSPITAL_CASE_UPDATE: 'hospital:case_update',
    HOSPITAL_AMBULANCE_UPDATE: 'hospital:ambulance_update',
    BED_STATUS_CHANGED: 'hospital:bed_status_changed',
  }),
  TRACKING: Object.freeze({
    SHARE_LOCATION_REQUEST: 'tracking:share_location_request',
    LOCATION_SHARED: 'tracking:location_shared',
  }),
});

// Room naming helpers. e.g. ROOMS.caseRoom('abc-123') -> 'case:abc-123'
export const ROOMS = Object.freeze({
  caseRoom: (caseId) => `case:${caseId}`,
  driverRoom: (driverId) => `driver:${driverId}`,
  hospitalRoom: (hospitalId) => `hospital:${hospitalId}`,
  patientRoom: (patientId) => `patient:${patientId}`,
});

export default { EVENTS, ROOMS };
