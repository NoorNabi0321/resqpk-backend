import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  driverRespond,
  updateStatus,
  getCaseDetails,
  getCaseRoute,
  changeHospital,
  getShareTracking,
  listCases,
  updateBeds,
} from '../controllers/case.controller.js';

const router = express.Router();

// Public family tracking — defined before /:id so 'track' isn't captured as an id.
router.get('/track/:token', getShareTracking);

// Hospital admin — full case list for the dashboard. Defined before /:id.
router.get('/', authenticate, requireRole('hospital_admin'), listCases);
router.put('/beds', authenticate, requireRole('hospital_admin'), updateBeds);

// Driver only.
router.post('/respond', authenticate, requireRole('driver'), driverRespond);
router.put('/status', authenticate, requireRole('driver'), updateStatus);

// Patient or assigned driver.
router.get('/:id/route', authenticate, getCaseRoute);
router.get('/:id', authenticate, getCaseDetails);

// Patient only — change the destination hospital mid-case.
router.put('/:id/hospital', authenticate, requireRole('patient'), changeHospital);

export default router;
