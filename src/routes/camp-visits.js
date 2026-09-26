// A camp's patient register. hospital_admin is the role both hospitals and
// camps sign in with; the controller then refuses anything whose facility is
// not a medical camp, and scopes every query to the camp on the token.
import express from 'express';

import { authenticate, requireRole } from '../middleware/auth.js';
import {
  createVisit,
  listVisits,
  getSummary,
  updateVisit,
  deleteVisit,
  exportCsv,
} from '../controllers/camp-visits.controller.js';

const router = express.Router();

router.use(authenticate, requireRole('hospital_admin'));

router.get('/summary', getSummary);
router.get('/export.csv', exportCsv);
router.get('/', listVisits);
router.post('/', createVisit);
router.put('/:id', updateVisit);
router.delete('/:id', deleteVisit);

export default router;
