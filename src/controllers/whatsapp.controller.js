// WhatsApp Cloud API webhook — the second SOS ingress channel.
//
// Stage 1: verify the callback, acknowledge deliveries, and echo inbound
// messages so the pipe can be proven end to end. The conversation state machine
// and the dispatch adapter land next (§6 of ResQPK_System_Replan.md).
import config from '../config/env.js';
import whatsapp from '../services/whatsapp/whatsapp.client.js';
import logger from '../middleware/logger.js';

// Meta retries a webhook it considers failed, and retries carry the same
// message id. Without this, one "SOS" could dispatch several ambulances.
// In-memory is enough at this stage; it moves to wa_sessions with the state
// machine, which must survive a Render restart.
const MAX_SEEN = 500;
const seenMessageIds = new Map();

function alreadyHandled(messageId) {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.set(messageId, Date.now());
  if (seenMessageIds.size > MAX_SEEN) {
    // Drop the oldest quarter rather than clearing everything.
    const oldest = [...seenMessageIds.entries()]
      .sort((x, y) => x[1] - y[1])
      .slice(0, Math.floor(MAX_SEEN / 4));
    oldest.forEach(([id]) => seenMessageIds.delete(id));
  }
  return false;
}

// GET /api/whatsapp/webhook — Meta's subscription handshake.
// Echo hub.challenge verbatim, as plain text, or the callback URL is refused.
export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === config.whatsapp.verifyToken) {
    logger.info('WhatsApp webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  logger.warn('WhatsApp webhook verification failed — check WHATSAPP_VERIFY_TOKEN');
  return res.sendStatus(403);
}

// Describes an inbound message for the log without dumping message contents.
function describe(message) {
  switch (message.type) {
    case 'text':
      return `text "${(message.text?.body || '').slice(0, 60)}"`;
    case 'location':
      return `location ${message.location?.latitude},${message.location?.longitude}`;
    case 'audio':
      return `voice note (${message.audio?.id})`;
    case 'interactive':
      return `button ${message.interactive?.button_reply?.id || message.interactive?.list_reply?.id}`;
    default:
      return message.type;
  }
}

async function handleMessage(message, contact) {
  const from = message.from;
  const name = contact?.profile?.name || 'unknown';
  logger.info(`WhatsApp inbound from ${from} (${name}): ${describe(message)}`);

  await whatsapp.markAsRead(message.id);

  // Stage 1 echo. Replaced by the state machine in the next step.
  if (message.type === 'text') {
    const body = (message.text?.body || '').trim();
    await whatsapp.sendText(
      from,
      `ResQPK received: "${body}"\n\nThe emergency flow is not connected yet — this is a channel test.`,
    );
  } else if (message.type === 'location') {
    const { latitude, longitude } = message.location || {};
    await whatsapp.sendText(from, `Location received: ${latitude}, ${longitude}`);
  }
}

// POST /api/whatsapp/webhook — inbound messages and delivery statuses.
export function receiveWebhook(req, res) {
  // Acknowledge first. Meta retries anything slow, and the work below can take
  // seconds once dispatch is wired in.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];

        for (const message of value.messages || []) {
          if (alreadyHandled(message.id)) {
            logger.info(`WhatsApp duplicate ignored: ${message.id}`);
            continue;
          }
          const contact = contacts.find((c) => c.wa_id === message.from) || contacts[0];
          handleMessage(message, contact).catch((err) =>
            logger.error(`WhatsApp message handling failed: ${err.message}`),
          );
        }

        // Delivery receipts for messages we sent. Useful for debugging only.
        for (const status of value.statuses || []) {
          if (status.status === 'failed') {
            logger.warn(
              `WhatsApp delivery failed to ${status.recipient_id}: ` +
                `${status.errors?.[0]?.title || 'unknown'}`,
            );
          }
        }
      }
    }
  } catch (err) {
    logger.error(`WhatsApp webhook parsing failed: ${err.message}`);
  }
}

export default { verifyWebhook, receiveWebhook };
