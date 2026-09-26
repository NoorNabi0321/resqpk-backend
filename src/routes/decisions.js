import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  sendMessage,
  listMessages,
  getConstants,
} from '../controllers/decision.controller.js';

const router = express.Router();

// Preset text for both frontends — any signed-in role may read it.
router.get('/constants', authenticate, getConstants);

// Accept and redirect used to live here. A ward no longer decides whether to
// take an ambulance that is already on its way; it is told what is coming and
// when, so it can be ready.

// Quick messages flow both ways; the service authorizes the sender per case.
router.post('/message', authenticate, requireRole('hospital_admin', 'driver'), sendMessage);
router.get('/messages/:caseId', authenticate, listMessages);

export default router;
