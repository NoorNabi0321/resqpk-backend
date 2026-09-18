import express from 'express';
import rateLimit from 'express-rate-limit';

import { optionalAuth } from '../middleware/auth.js';
import caseAuth from '../middleware/case-auth.js';
import { triggerSOS, cancelSOS } from '../controllers/sos.controller.js';

const router = express.Router();

// Removing the install barrier removes what quietly deterred prank calls, so
// the trigger is limited per IP. Generous enough that a genuine retry after a
// failure is never blocked.
const sosLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests from this device. Call 1122 directly.' },
});

// No account required. A signed-in patient is recognised; anyone else supplies
// a callback number.
router.post('/trigger', sosLimiter, optionalAuth, triggerSOS);
router.post('/cancel', caseAuth, cancelSOS);

export default router;
