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
router.get('/nearby', authenticate, nearbyCamps);
router.get('/dashboard/me', authenticate, requireRole('hospital_admin'), campDashboard);
router.get('/:id', authenticate, campDetails);

export default router;
