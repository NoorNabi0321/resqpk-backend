// Module 6 — OpenAI Whisper voice transcription service.
// Transcribes multilingual emergency voice notes (EN/UR/Sindhi/Roman-Urdu) and
// detects the language for downstream GPT report generation.
import fs from 'fs';
import os from 'os';
import path from 'path';

import OpenAI from 'openai';

import logger from '../../middleware/logger.js';
import { getExtFromMime } from '../../utils/file.utils.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Prior-context prompt: primes Whisper with medical vocabulary + Pakistani names
// so transcription of mixed Urdu/Sindhi/English emergency speech is more accurate.
export function getWhisperPrompt() {
  return (
    'Medical emergency report. Patient description, symptoms, conditions. ' +
    'Medical terms: chest pain, cardiac arrest, unconscious, breathing difficulty, ' +
    'blood pressure, diabetes, hypertension, allergies. ' +
    'Names may be Pakistani: Ahmed, Fatima, Muhammad, Ali, Khan, Bibi, Begum. ' +
    'Mix of Urdu, Sindhi, and English is expected.'
  );
}

// Transcribes an audio buffer via Whisper. language=null → auto-detect.
export async function transcribeAudio(audioBuffer, mimeType, language = null) {
  const tmpPath = path.join(os.tmpdir(), `resqpk-audio-${Date.now()}${getExtFromMime(mimeType)}`);
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    const params = {
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      response_format: 'verbose_json', // includes detected language + duration
      temperature: 0.2,
      prompt: getWhisperPrompt(),
    };
    if (language) params.language = language; // omit when auto-detecting

    const transcription = await openai.audio.transcriptions.create(params);

    return {
      text: transcription.text,
      detectedLanguage: transcription.language,
      duration: transcription.duration,
      segments: transcription.segments,
    };
  } catch (error) {
    logger.error(`Whisper transcription error: ${error?.stack || error?.message || error}`);
    throw new Error(`Transcription failed: ${error.message}`);
  } finally {
    // Always clean up the temp file.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

// Fallback language classifier (GPT-4o-mini) when Whisper's detection is off.
export async function detectLanguageFromText(text) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content:
            'What language is this text written in? ' +
            'Respond with ONLY one of: en, ur, sd, roman_ur\n' +
            `Text: ${(text || '').substring(0, 200)}`,
        },
      ],
    });
    const answer = res.choices[0]?.message?.content?.trim().toLowerCase() || 'en';
    return ['en', 'ur', 'sd', 'roman_ur'].includes(answer) ? answer : 'en';
  } catch (error) {
    logger.error(`Language detection error: ${error.message}`);
    return 'en';
  }
}

// Retries transcribeAudio with a 2s backoff before giving up.
export async function transcribeWithRetry(audioBuffer, mimeType, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await transcribeAudio(audioBuffer, mimeType);
    } catch (error) {
      lastError = error;
      logger.warn(`Transcription attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

export default { transcribeAudio, getWhisperPrompt, detectLanguageFromText, transcribeWithRetry };
