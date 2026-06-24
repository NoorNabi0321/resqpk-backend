// Authentication routes, mounted at /api/auth in app.js.
import express from 'express';
import {
  registerPatient,
  registerDriver,
  loginPatient,
  loginDriver,
  loginHospitalAdmin,
  getMyProfile,
  updateMedicalProfile,
  refreshToken,
} from '../controllers/auth.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Public routes (no authentication required).
router.post('/patient/register', registerPatient);
router.post('/driver/register', registerDriver);
router.post('/patient/login', loginPatient);
router.post('/driver/login', loginDriver);
router.post('/hospital/login', loginHospitalAdmin);

// Protected routes (require a valid JWT).
router.get('/me', authenticate, getMyProfile);
router.put('/medical-profile', authenticate, requireRole('patient'), updateMedicalProfile);
router.post('/refresh', authenticate, refreshToken);

export default router;
