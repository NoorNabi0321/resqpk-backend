// WhatsApp Cloud API webhook, mounted at /api/whatsapp in app.js.
// Public by necessity — Meta calls it. The POST is authenticated by signature,
// the GET by the verify token, so neither uses the JWT middleware.
import express from 'express';

import { verifyWebhook, receiveWebhook } from '../controllers/whatsapp.controller.js';
import whatsappSignature from '../middleware/whatsapp-signature.js';

const router = express.Router();

router.get('/webhook', verifyWebhook);
router.post('/webhook', whatsappSignature, receiveWebhook);

export default router;
