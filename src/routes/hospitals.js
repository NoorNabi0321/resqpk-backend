import express from 'express';
import rateLimit from 'express-rate-limit';

import { nearbyHospitals } from '../controllers/case.controller.js';
import { registerHospital } from '../controllers/hospital-registration.controller.js';

const router = express.Router();

// Self-registration creates an auth user, so cap it per IP exactly as camp
// registration is capped.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many hospital registrations. Try again later.' },
});

// Public, and deliberately powerless until approved: a hospital registered
// here is not dispatchable and not listed to patients until an admin says so.
router.post('/register', registerLimiter, registerHospital);

// Emergency-capable hospitals sorted by distance from ?lat=&lng=
//
// Public. Which hospitals have an emergency ward is not private information,
// and the people who need it most have no account: a patient choosing where
// the ambulance takes them now does so without ever signing in. Behind auth,
// this returned 401 and the hospital list came up empty mid-emergency.
router.get('/nearby', nearbyHospitals);

export default router;
