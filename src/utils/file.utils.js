// Module 6 — file handling helpers for the AI pipeline.
// Uploads audio/image buffers to the private Supabase Storage 'emergency-media'
// bucket and returns a short-lived signed URL for downstream use (Whisper/GPT).
import path from 'path';
import crypto from 'crypto';

import { supabaseAdmin } from '../config/supabase.js';

const BUCKET = 'emergency-media';

// Maps a MIME type to a file extension (fallback when the original name has none).
export function getExtFromMime(mimeType) {
  const map = {
    'audio/m4a': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  return map[mimeType] || '.bin';
}

// Uploads a buffer to Supabase Storage and returns its path + a 6-hour signed URL.
export async function uploadToSupabaseStorage(fileBuffer, originalFilename, mimeType, folder) {
  const ext = path.extname(originalFilename || '') || getExtFromMime(mimeType);
  const uniqueName = `${folder}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(uniqueName, fileBuffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: urlData, error: urlError } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(uniqueName, 60 * 60 * 6); // 6 hours
  if (urlError) throw new Error(`Signed URL failed: ${urlError.message}`);

  return { path: uniqueName, signedUrl: urlData.signedUrl };
}

// Removes a file from storage (best-effort cleanup).
export async function deleteFromStorage(filePath) {
  if (!filePath) return;
  await supabaseAdmin.storage.from(BUCKET).remove([filePath]);
}
