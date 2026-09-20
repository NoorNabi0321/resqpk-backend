import express from 'express';
import rateLimit from 'express-rate-limit';

import { authenticate, requireRole } from '../middleware/auth.js';
import caseAuth from '../middleware/case-auth.js';
import {
  driverRespond,
  updateStatus,
  handoffCase,
  getCaseDetails,
  getMyActiveCase,
  getDriverHistory,
  getCaseRoute,
  changeHospital,
  getShareTracking,
  lookupByAccessCode,
  claimCase,
  listCases,
  updateBeds,
} from '../controllers/case.controller.js';

const router = express.Router();

// An access code is short enough to guess at scale, so the lookup is the one
// endpoint that must be tightly limited. Enumeration is the realistic attack.
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Wait a minute and try again.' },
});

// Public tracking — defined before /:id so 'track' isn't captured as an id.
router.get('/track/:token', getShareTracking);
router.post('/lookup', lookupLimiter, lookupByAccessCode);
router.post('/claim', authenticate, requireRole('patient'), claimCase);

// Hospital admin — full case list for the dashboard. Defined before /:id.
router.get('/', authenticate, requireRole('hospital_admin'), listCases);
router.put('/beds', authenticate, requireRole('hospital_admin'), updateBeds);

// Driver only.
router.post('/respond', authenticate, requireRole('driver'), driverRespond);
router.put('/status', authenticate, requireRole('driver'), updateStatus);
router.post('/handoff', authenticate, requireRole('driver'), handoffCase);
// Declared before /:id so 'driver' is not read as a case id.
router.get('/driver/history', authenticate, requireRole('driver'), getDriverHistory);

// Session restore — declared before /:id so 'active' isn't read as an id.
router.get('/active/me', authenticate, getMyActiveCase);

// The patient (with or without an account), the assigned driver, or the
// hospital the case is routed to. caseAuth accepts a case token or a user JWT.
router.get('/:id/route', caseAuth, getCaseRoute);
router.get('/:id', caseAuth, getCaseDetails);

// Patient only — change the destination hospital mid-case.
// The reporter picks the destination — with an account or, far more often,
// with the case token their phone is holding. requireRole('patient') here was
// a 401 in the middle of an emergency for everyone without an account, which
// left the case with no hospital and so on no hospital's dashboard.
router.put('/:id/hospital', caseAuth, changeHospital);

export default router;
