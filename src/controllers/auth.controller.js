// HTTP controllers for authentication. Each handler validates input, calls the
// service, and returns a consistent response envelope.
import jwt from 'jsonwebtoken';
import authService from '../services/auth.service.js';
import config from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import {
  patientRegisterSchema,
  driverRegisterSchema,
  loginSchema,
  hospitalLoginSchema,
  medicalProfileSchema,
  validate,
} from '../validators/auth.validator.js';
import { successResponse, errorResponse } from '../utils/response.js';

export async function registerPatient(req, res) {
  const { error, value } = validate(patientRegisterSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await authService.registerPatient(value);
    return successResponse(res, data, 'Patient registered successfully', 201);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export async function registerDriver(req, res) {
  const { error, value } = validate(driverRegisterSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await authService.registerDriver(value);
    return successResponse(res, data, 'Driver registered successfully. Pending admin verification.', 201);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export async function loginPatient(req, res) {
  const { error, value } = validate(loginSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await authService.loginPatient(value);
    return successResponse(res, data, 'Login successful', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export async function loginDriver(req, res) {
  const { error, value } = validate(loginSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await authService.loginDriver(value);
    return successResponse(res, data, 'Login successful', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export async function loginHospitalAdmin(req, res) {
  const { error, value } = validate(hospitalLoginSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await authService.loginHospitalAdmin(value);
    return successResponse(res, data, 'Login successful', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export async function getMyProfile(req, res) {
  try {
    const data = await authService.getMyProfile(req.user.id);
    return successResponse(res, data, 'Profile fetched', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export async function updateMedicalProfile(req, res) {
  const { error, value } = validate(medicalProfileSchema, req.body);
  if (error) return errorResponse(res, 'Validation failed', 400, error);
  try {
    const data = await authService.saveMedicalProfile(req.user.id, value);
    return successResponse(res, data, 'Medical profile updated', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// PUT /api/auth/location — keeps the caller's last-known GPS fresh so offline
// SOS (SMS trigger) can dispatch from it. Called by the app every few minutes.
export async function updateLocation(req, res) {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return errorResponse(res, 'lat must be a number between -90 and 90', 400);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return errorResponse(res, 'lng must be a number between -180 and 180', 400);
  }

  try {
    const updatedAt = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        last_known_lat: lat,
        last_known_lng: lng,
        last_location_updated_at: updatedAt,
      })
      .eq('id', req.user.id);
    if (error) throw new Error(error.message);

    return successResponse(res, { location: { lat, lng, updatedAt } }, 'Location updated', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// PUT /api/auth/fcm-token — stores the device's FCM token for push delivery.
// Called on app start and whenever Firebase rotates the token.
export async function updateFCMToken(req, res) {
  const { fcmToken } = req.body || {};
  if (!fcmToken || typeof fcmToken !== 'string') {
    return errorResponse(res, 'fcmToken is required', 400);
  }
  try {
    const { error } = await supabaseAdmin
      .from('users')
      .update({ fcm_token: fcmToken })
      .eq('id', req.user.id);
    if (error) throw new Error(error.message);
    return successResponse(res, { success: true }, 'FCM token updated', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// Issues a fresh token with the same payload (the current token was already
// verified by the authenticate middleware, so req.user is trusted here).
export async function refreshToken(req, res) {
  try {
    const payload = { ...req.user };
    delete payload.iat;
    delete payload.exp;
    const token = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    return successResponse(res, { token }, 'Token refreshed', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export default {
  registerPatient,
  registerDriver,
  loginPatient,
  loginDriver,
  loginHospitalAdmin,
  getMyProfile,
  updateMedicalProfile,
  updateLocation,
  updateFCMToken,
  refreshToken,
};
