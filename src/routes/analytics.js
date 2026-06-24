import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  getOverview,
  getWeeklyResponseTimes,
  getEmergencyTypes,
  getHourlyHeatmap,
} from '../controllers/analytics.controller.js';

const router = express.Router();

// All analytics routes are hospital-admin only and scoped to req.user.hospital_id.
router.use(authenticate, requireRole('hospital_admin'));

router.get('/overview', getOverview);
router.get('/weekly-response-times', getWeeklyResponseTimes);
router.get('/emergency-types', getEmergencyTypes);
router.get('/hourly-heatmap', getHourlyHeatmap);

export default router;
