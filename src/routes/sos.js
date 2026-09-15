import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { triggerSOS, cancelSOS } from '../controllers/sos.controller.js';

const router = express.Router();

// Patient only.
router.post('/trigger', authenticate, requireRole('patient'), triggerSOS);
router.post('/cancel', authenticate, requireRole('patient'), cancelSOS);

export default router;
