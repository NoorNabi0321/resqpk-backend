// Thin wrapper over the WhatsApp Cloud API (Graph API).
//
// Outbound only. Inbound arrives at the webhook in whatsapp.controller.js.
// Every call is best-effort: WhatsApp being down must never break dispatch, so
// failures are logged and returned, never thrown.
import config from '../../config/env.js';
import logger from '../../middleware/logger.js';

const { phoneNumberId, accessToken, apiVersion } = config.whatsapp;

const isConfigured = () => Boolean(phoneNumberId && accessToken);

async function callGraph(payload) {
  if (!isConfigured()) {
    logger.warn('WhatsApp not configured — set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN');
    return { success: false, reason: 'not_configured' };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      },
    );

    const body = await res.json();
    if (!res.ok) {
      // 131047 = outside the 24-hour window; 190 = token expired or revoked.
      logger.error(
        `WhatsApp send failed (${res.status}): ${body?.error?.message || 'unknown'} ` +
          `[code ${body?.error?.code ?? '-'}]`,
      );
      return { success: false, error: body?.error?.message, code: body?.error?.code };
    }
    return { success: true, messageId: body?.messages?.[0]?.id };
  } catch (err) {
    logger.error(`WhatsApp send threw: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/** Plain text. Only allowed inside the 24-hour window the user opened. */
export async function sendText(to, body) {
  return callGraph({ to, type: 'text', text: { preview_url: false, body } });
}

/**
 * The one-tap location prompt: body text plus a "Send location" button.
 * This is the Cloud API feature the whole intake flow depends on — Twilio has
 * no equivalent (see §6.8 of ResQPK_System_Replan.md).
 */
export async function requestLocation(to, body) {
  return callGraph({
    to,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: body },
      action: { name: 'send_location' },
    },
  });
}

/** Reply buttons — max 3, ids come back on the inbound webhook. */
export async function sendButtons(to, body, buttons) {
  return callGraph({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

/**
 * Send a file by URL — used for the AI patient report PDF. The link must be
 * publicly fetchable by Meta; Supabase signed URLs qualify.
 */
export async function sendDocument(to, link, filename, caption) {
  return callGraph({
    to,
    type: 'document',
    document: { link, filename, caption },
  });
}

/** Blue ticks. Cosmetic, but it tells the sender the system is alive. */
export async function markAsRead(messageId) {
  return callGraph({ status: 'read', message_id: messageId });
}

export default { sendText, requestLocation, sendButtons, sendDocument, markAsRead, isConfigured };
