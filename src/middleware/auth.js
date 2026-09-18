// Authentication + authorization middleware.
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import { errorResponse } from '../utils/response.js';

// Valid roles in the ResQPK system.
export const ROLES = ['patient', 'driver', 'hospital_admin', 'super_admin'];

// Verifies the Bearer JWT and attaches the decoded payload to req.user.
// Decoded payload shape: { id, auth_id, role, phone | email, driver_id?, hospital_id? }
export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return errorResponse(res, 'Unauthorized', 401);
  }

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return errorResponse(res, 'Unauthorized', 401);
  }
}

// Attaches req.user when a valid token is present, and continues regardless.
//
// Used by SOS triggering: a signed-in patient gets their medical profile and
// history attached to the case, while someone with no account still gets an
// ambulance. Never ask a person in an emergency to log in first.
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme === 'Bearer' && token) {
    try {
      req.user = jwt.verify(token, config.jwtSecret);
    } catch {
      // An expired or malformed token must not block an emergency.
      req.user = null;
    }
  }
  return next();
}

// Factory: returns middleware that allows only the given roles.
// Usage: router.get('/x', authenticate, requireRole('driver', 'hospital_admin'), handler)
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return errorResponse(res, 'Forbidden', 403);
    }
    return next();
  };
}

export default { authenticate, optionalAuth, requireRole, ROLES };
