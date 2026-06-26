import express from 'express';
import config from '../config/env.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  getFirstAidGuides,
  getFirstAidGuideBySlug,
  sendWeeklyNotification,
} from '../controllers/firstaid.controller.js';

const router = express.Router();

// Manual weekly-notification trigger. Open in development; super_admin only in
// production. Declared before /:slug so the path isn't captured as a slug.
const weeklyGuards = config.isDevelopment
  ? [sendWeeklyNotification]
  : [authenticate, requireRole('super_admin'), sendWeeklyNotification];
router.post('/send-weekly-notification', ...weeklyGuards);

// Public — no auth so the app can pre-fetch for offline use.
router.get('/', getFirstAidGuides);
router.get('/:slug', getFirstAidGuideBySlug);

export default router;
