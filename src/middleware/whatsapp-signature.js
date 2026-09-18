// Verifies that an inbound webhook really came from Meta.
//
// The webhook URL is public: without this, anyone who discovers it could post a
// fabricated message and trigger a real ambulance dispatch.
//
// Meta signs the raw request body with the app secret and sends the result as
// `X-Hub-Signature-256: sha256=<hex>`. The signature is over the bytes exactly
// as sent, so app.js captures req.rawBody before JSON parsing.
import crypto from 'crypto';

import config from '../config/env.js';
import logger from './logger.js';

export default function whatsappSignature(req, res, next) {
  const { appSecret } = config.whatsapp;

  // Not configured yet — allow through so the webhook can be wired up before
  // the secret is set, but make the gap loud. Set WHATSAPP_APP_SECRET in Render.
  if (!appSecret) {
    logger.warn('WHATSAPP_APP_SECRET not set — inbound webhook is UNVERIFIED');
    return next();
  }

  const header = req.get('X-Hub-Signature-256') || '';
  if (!header.startsWith('sha256=')) {
    logger.warn('WhatsApp webhook rejected: missing signature header');
    return res.sendStatus(401);
  }

  if (!req.rawBody) {
    logger.error('WhatsApp webhook rejected: raw body unavailable');
    return res.sendStatus(401);
  }

  const expected = crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  const received = header.slice('sha256='.length);

  // Constant-time compare; timingSafeEqual throws on length mismatch.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn('WhatsApp webhook rejected: signature mismatch');
    return res.sendStatus(401);
  }

  return next();
}
