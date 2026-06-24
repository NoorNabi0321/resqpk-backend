// Maps service backed by OpenRouteService (ORS). Provides driving ETA/distance
// and route geometry, with a Haversine fallback when ORS is unavailable.
// NOTE: ORS uses [longitude, latitude] coordinate order.
import axios from 'axios';
import config from '../config/env.js';
import logger from '../middleware/logger.js';

const ORS_BASE = 'https://api.openrouteservice.org';
const FALLBACK_SPEED_MPS = 30000 / 3600; // assume 30 km/h average city speed

function fmtDistance(meters) {
  return `${(meters / 1000).toFixed(1)} km`;
}

function fmtDuration(seconds) {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

// Pure function: straight-line distance between two coordinates, in meters.
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function haversineFallback(originLat, originLng, destLat, destLng) {
  const distanceMeters = Math.round(haversineDistance(originLat, originLng, destLat, destLng));
  const durationSeconds = Math.round(distanceMeters / FALLBACK_SPEED_MPS);
  return {
    distanceMeters,
    distanceText: fmtDistance(distanceMeters),
    durationSeconds,
    durationText: fmtDuration(durationSeconds),
    isFallback: true,
  };
}

// 1. Driving distance + ETA via the ORS Matrix API (falls back to Haversine).
export async function getDistanceAndETA(originLat, originLng, destLat, destLng) {
  try {
    const res = await axios.post(
      `${ORS_BASE}/v2/matrix/driving-car`,
      {
        locations: [
          [originLng, originLat],
          [destLng, destLat],
        ],
        metrics: ['distance', 'duration'],
        units: 'm',
      },
      {
        headers: {
          Authorization: config.orsApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 8000,
      },
    );

    const durationSeconds = Math.round(res.data?.durations?.[0]?.[1]);
    const distanceMeters = Math.round(res.data?.distances?.[0]?.[1]);
    if (!Number.isFinite(durationSeconds) || !Number.isFinite(distanceMeters)) {
      throw new Error('ORS matrix returned no route');
    }

    return {
      distanceMeters,
      distanceText: fmtDistance(distanceMeters),
      durationSeconds,
      durationText: fmtDuration(durationSeconds),
    };
  } catch (err) {
    logger.warn(`ORS matrix failed, using Haversine fallback: ${err.message}`);
    return haversineFallback(originLat, originLng, destLat, destLng);
  }
}

// 2. Driving route geometry via the ORS Directions API (GeoJSON).
export async function getDirectionsRoute(originLat, originLng, destLat, destLng) {
  try {
    const res = await axios.post(
      `${ORS_BASE}/v2/directions/driving-car/geojson`,
      {
        coordinates: [
          [originLng, originLat],
          [destLng, destLat],
        ],
      },
      {
        headers: {
          Authorization: config.orsApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/geo+json, application/json',
        },
        timeout: 8000,
      },
    );

    const feature = res.data?.features?.[0];
    if (!feature) return { routes: [] };

    const coordinates = (feature.geometry?.coordinates || []).map(([lng, lat]) => ({ lat, lng }));
    const summary = feature.properties?.summary || {};

    return {
      routes: [
        {
          durationSeconds: Math.round(summary.duration ?? 0),
          distanceMeters: Math.round(summary.distance ?? 0),
          coordinates, // [{ lat, lng }, ...] for drawing the polyline
        },
      ],
    };
  } catch (err) {
    logger.warn(`ORS directions failed: ${err.message}`);
    return { routes: [] };
  }
}

// 3. Nearest available drivers to a patient (straight-line, fast, no API call).
export function findNearestDrivers(patientLat, patientLng, availableDrivers, maxCount = 3) {
  return (availableDrivers || [])
    .filter((d) => d.current_lat != null && d.current_lng != null)
    .map((d) => {
      const distanceMeters = Math.round(
        haversineDistance(patientLat, patientLng, Number(d.current_lat), Number(d.current_lng)),
      );
      return { ...d, distanceMeters, distanceText: fmtDistance(distanceMeters) };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, maxCount);
}

// 4. Nearest emergency-capable, active hospital to a patient.
export function findNearestHospital(patientLat, patientLng, hospitals) {
  const candidates = (hospitals || [])
    .filter((h) => h.has_emergency_ward && h.is_active && h.lat != null && h.lng != null)
    .map((h) => {
      const distanceMeters = Math.round(
        haversineDistance(patientLat, patientLng, Number(h.lat), Number(h.lng)),
      );
      return { ...h, distanceMeters, distanceText: fmtDistance(distanceMeters) };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return candidates[0] || null;
}

export default {
  getDistanceAndETA,
  getDirectionsRoute,
  haversineDistance,
  findNearestDrivers,
  findNearestHospital,
};
