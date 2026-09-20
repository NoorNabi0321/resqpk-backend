import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  registerCamp,
  nearbyCamps,
  campDashboard,
  campDetails,
} from '../controllers/camp.controller.js';

const router = express.Router();

// Public self-registration creates an auth user, so cap it per IP.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many camp registrations. Try again later.' },
});

router.post('/register', registerLimiter, registerCamp);

// Literal paths before /:id so they aren't captured as an id.
//
// Free camps are public health information — the whole point is that anyone
// can find them. They were behind auth, which since the anonymous-patient
// change meant the Camps tab 401'd on a fresh install.
router.get('/nearby', nearbyCamps);
router.get('/dashboard/me', authenticate, requireRole('hospital_admin'), campDashboard);
router.get('/:id', campDetails);

export default router;
