// Everything here decides who appears in the patient app, so the whole router
// is super_admin. There is deliberately no self-signup for this role: an
// approval queue that anyone can join the other side of is not a queue.
import express from 'express';

import { authenticate, requireRole } from '../middleware/auth.js';
import {
  listFacilities,
  pendingCount,
  getFacility,
  approveFacility,
  rejectFacility,
} from '../controllers/admin.controller.js';

const router = express.Router();

router.use(authenticate, requireRole('super_admin'));

// Literal path before /:id so it is not read as a facility id.
router.get('/facilities/pending-count', pendingCount);
router.get('/facilities', listFacilities);
router.get('/facilities/:id', getFacility);
router.post('/facilities/:id/approve', approveFacility);
router.post('/facilities/:id/reject', rejectFacility);

export default router;
