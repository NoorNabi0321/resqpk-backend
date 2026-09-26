// Module 6 — OpenAI voice transcription.
//
// Transcribes multilingual emergency voice notes (English / Urdu / Sindhi /
// code-switched) and settles the language for downstream GPT report
// generation.
//
// Model: gpt-4o-transcribe, not whisper-1. Measured on the four clips in
// test-audio/, against the same audio and the same prompt:
//
//   Urdu    whisper-1 wrote "تیڑا" and "دایا"; gpt-4o wrote "ٹیڑھا" and
//           "دایاں", which are the correct spellings, and "ہیں" for the
//           honorific rather than "ہے".
//   Mixed   whisper-1 transliterated English words into Urdu script —
//           "ڈیفکلٹی", "انہیلر", "لپس بلو". gpt-4o kept "difficulty",
//           "inhaler", "lips blue" in Latin, which is what was said.
//   Sindhi  whisper-1 returned "ڈیڈیڈیڈی…" — the same repetition loop that
//           corrupted a live case — while gpt-4o transcribed it correctly.
//   Speed   roughly 2x faster across all four.
import fs from 'fs';
import os from 'os';
import path from 'path';

import OpenAI from 'openai';

import logger from '../../middleware/logger.js';
import { getExtFromMime } from '../../utils/file.utils.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PRIMARY_MODEL = process.env.STT_MODEL || 'gpt-4o-transcribe';
const FALLBACK_MODEL = 'whisper-1';

// Language codes the transcription API accepts.
//
// Sindhi is deliberately absent: both models reject "sd" outright — "Language
// code 'sd' is not recognized". They can still transcribe Sindhi, and
// gpt-4o-transcribe does it well, but only when left to detect it. Sending the
// code fails the request; sending 'ur' instead is worse, because the model
// then forces Sindhi speech into Urdu words. So Sindhi gets no code and a
// prompt that names it.
const SPOKEN_LANGUAGES = Object.freeze({
  en: 'en',
  ur: 'ur',
  // Roman Urdu is a way of writing Urdu, not a way of speaking it. Someone who
  // picked it is going to speak Urdu.
  roman_ur: 'ur',
});

const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  ur: 'Urdu',
  sd: 'Sindhi (سنڌي), the language of Sindh, Pakistan',
  roman_ur: 'Urdu',
});

/**
 * How much of the text is one short motif repeated.
 *
 * Whisper-family models loop when they are given silence, noise, or a language
 * they cannot handle: one live case came back as "ڈیوڈیوڈیوڈیو…" for 166
 * characters. That is not a transcription and must not reach a hospital as if
 * it were, so it is measured and rejected rather than saved.
 */
export function repetitionRatio(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (s.length < 24) return 0;
  let worst = 0;
  for (let n = 2; n <= 8; n += 1) {
    const motif = s.slice(0, n);
    const hits = s.split(motif).length - 1;
    worst = Math.max(worst, (hits * n) / s.length);
  }
  return worst;
}

// Well clear of normal speech, which measures 4–6% on these clips, and well
// under a true loop, which measures 100%.
const REPETITION_LIMIT = 0.5;

// Prior-context prompt: primes the model with medical vocabulary and Pakistani
// names so mixed Urdu/Sindhi/English emergency speech transcribes better.
export function getWhisperPrompt(language = null) {
  const named = LANGUAGE_NAMES[language];
  return (
    'Medical emergency report. Patient description, symptoms, conditions. '
    + 'Medical terms: chest pain, cardiac arrest, unconscious, breathing difficulty, '
    + 'blood pressure, diabetes, hypertension, allergies. '
    + 'Names may be Pakistani: Ahmed, Fatima, Muhammad, Ali, Khan, Bibi, Begum. '
    + (named
      ? `The speaker is using ${named}. Transcribe in its own script, and keep `
        + 'English words in Latin script where they are spoken in English. '
      : 'Mix of Urdu, Sindhi, and English is expected. ')
  );
}

/**
 * Transcribes an audio buffer.
 *
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {string|null} language one of en/ur/sd/roman_ur, or null to detect.
 */
export async function transcribeAudio(audioBuffer, mimeType, language = null) {
  const tmpPath = path.join(os.tmpdir(), `resqpk-audio-${Date.now()}${getExtFromMime(mimeType)}`);
  fs.writeFileSync(tmpPath, audioBuffer);

  const attempt = async (model) => {
    const params = {
      file: fs.createReadStream(tmpPath),
      model,
      // verbose_json — and therefore duration and segments — is whisper-1 only.
      response_format: model === FALLBACK_MODEL ? 'verbose_json' : 'json',
      // Zero, not 0.2: any sampling temperature makes a looping model loop
      // more confidently.
      temperature: 0,
      prompt: getWhisperPrompt(language),
    };
    const code = SPOKEN_LANGUAGES[language];
    if (code) params.language = code;
    return openai.audio.transcriptions.create(params);
  };

  try {
    let transcription;
    try {
      transcription = await attempt(PRIMARY_MODEL);
    } catch (err) {
      // An account without access to the newer model, or a model renamed out
      // from under us, should degrade rather than fail the whole report.
      if (PRIMARY_MODEL === FALLBACK_MODEL) throw err;
      logger.warn(`STT model ${PRIMARY_MODEL} unavailable (${err.message}); using ${FALLBACK_MODEL}`);
      transcription = await attempt(FALLBACK_MODEL);
    }

    const text = transcription.text || '';
    const ratio = repetitionRatio(text);
    if (ratio >= REPETITION_LIMIT) {
      throw new Error(
        `Transcription looped (${Math.round(ratio * 100)}% one repeated motif) — `
        + 'the audio was probably silent or unintelligible',
      );
    }

    return {
      text,
      // gpt-4o-transcribe does not report the language, so the caller's choice
      // stands, and the pipeline falls back to classifying the text.
      detectedLanguage: transcription.language || null,
      duration: transcription.duration ?? null,
      segments: transcription.segments ?? null,
    };
  } catch (error) {
    logger.error(`Transcription error: ${error?.stack || error?.message || error}`);
    throw new Error(`Transcription failed: ${error.message}`);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

// Fallback language classifier (GPT-4o-mini) when the model does not say.
export async function detectLanguageFromText(text) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content:
            'What language is this text written in? '
            + 'Respond with ONLY one of: en, ur, sd, roman_ur\n'
            + `Text: ${(text || '').substring(0, 200)}`,
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

// Retries with a 2s backoff. A looping transcription counts as a failure worth
// retrying: the model may settle on a second pass over the same audio.
export async function transcribeWithRetry(audioBuffer, mimeType, language = null, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await transcribeAudio(audioBuffer, mimeType, language);
    } catch (error) {
      lastError = error;
      logger.warn(`Transcription attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

export default {
  transcribeAudio,
  getWhisperPrompt,
  detectLanguageFromText,
  transcribeWithRetry,
  repetitionRatio,
};
