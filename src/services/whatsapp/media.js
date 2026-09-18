// Fetching voice notes and photos out of WhatsApp.
//
// Two hops: the media id resolves to a short-lived lookaside URL, and that URL
// still needs the access token — an unauthenticated GET returns 401, which is
// the usual reason a download "works in the browser" but fails from the server.
import config from '../../config/env.js';
import logger from '../../middleware/logger.js';

// The AI upload path accepts 25 MB; stay below it. A WhatsApp voice note is
// typically well under 1 MB, so anything near this is not a voice note.
const MAX_BYTES = 20 * 1024 * 1024;

/** Returns { buffer, mimeType } or null — never throws into the conversation. */
export async function downloadMedia(mediaId) {
  const { accessToken, apiVersion } = config.whatsapp;
  if (!mediaId || !accessToken) return null;

  try {
    const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meta = await metaRes.json();

    if (!metaRes.ok || !meta?.url) {
      logger.warn(`WhatsApp media lookup failed for ${mediaId}: ${meta?.error?.message || metaRes.status}`);
      return null;
    }

    if (Number(meta.file_size) > MAX_BYTES) {
      logger.warn(`WhatsApp media ${mediaId} too large: ${meta.file_size} bytes`);
      return null;
    }

    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!binRes.ok) {
      logger.warn(`WhatsApp media download failed for ${mediaId}: HTTP ${binRes.status}`);
      return null;
    }

    const buffer = Buffer.from(await binRes.arrayBuffer());
    logger.info(`WhatsApp media ${mediaId} downloaded: ${buffer.length} bytes, ${meta.mime_type}`);
    return { buffer, mimeType: meta.mime_type || 'audio/ogg' };
  } catch (err) {
    logger.error(`WhatsApp media download threw for ${mediaId}: ${err.message}`);
    return null;
  }
}

export default { downloadMedia };
