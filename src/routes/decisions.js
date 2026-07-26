import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  acceptCase,
  redirectCase,
  sendMessage,
  listMessages,
  getConstants,
} from '../controllers/decision.controller.js';

const router = express.Router();

// Preset text for both frontends — any signed-in role may read it.
router.get('/constants', authenticate, getConstants);

// Hospital-only decisions.
router.post('/accept', authenticate, requireRole('hospital_admin'), acceptCase);
router.post('/redirect', authenticate, requireRole('hospital_admin'), redirectCase);

// Quick messages flow both ways; the service authorizes the sender per case.
router.post('/message', authenticate, requireRole('hospital_admin', 'driver'), sendMessage);
router.get('/messages/:caseId', authenticate, listMessages);

export default router;
