import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { triggerSOS, cancelSOS, handleMissedCallWebhook } from '../controllers/sos.controller.js';

const router = express.Router();

// Public — called by the Android missed-call gateway.
router.post('/missed-call-webhook', handleMissedCallWebhook);

// Patient only.
router.post('/trigger', authenticate, requireRole('patient'), triggerSOS);
router.post('/cancel', authenticate, requireRole('patient'), cancelSOS);

export default router;
