// Module 6 — GPT-4o structured emergency report generation + image vision.
import OpenAI from 'openai';

import promptBuilder from './prompt.builder.js';
import { buildClarifications } from './clarification.js';
import { normaliseConsciousness, normaliseUrgency } from './normalise.js';
import logger from '../../middleware/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cheaper model in dev, full gpt-4o in production (both overridable via env).
const MODEL =
  process.env.NODE_ENV === 'production'
    ? process.env.OPENAI_MODEL_PRODUCTION || 'gpt-4o'
    : process.env.OPENAI_MODEL || 'gpt-4o-mini';

/// The questions are composed on a smaller model than the record.
///
/// Naming what a description failed to mention is a much easier job than
/// writing a clinical record from it, and it is the one call the person holding
/// the phone is actually waiting on — the record is generated after they have
/// finished answering. Spending gpt-4o's latency here buys very little and
/// costs it at the worst moment. Override with OPENAI_MODEL_QUESTIONS if the
/// questions ever come back weak.
const QUESTION_MODEL = process.env.OPENAI_MODEL_QUESTIONS || 'gpt-4o-mini';

// Describes a single injury/scene image via GPT-4o vision. Never throws — a bad
// image must not sink the whole report.
export async function analyzeImage(imageBuffer, mimeType) {
  try {
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o', // vision requires gpt-4o (mini lacks it)
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptBuilder.buildImageAnalysisPrompt() },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ],
    });
    return response.choices[0]?.message?.content || 'Image analysis unavailable';
  } catch (error) {
    logger.error(`Image analysis error: ${error.message}`);
    return 'Image analysis unavailable';
  }
}

/// Phase one of the blocking sequence: the questions to put to the scene
/// before any record is written.
///
/// Never throws. The questions are an improvement on the record, not a
/// precondition for it — if this call fails, the sequence is simply not offered
/// and the record is generated from the description alone. Holding an emergency
/// up because a question could not be composed would be the worst of both
/// designs.
export async function generateClarificationQuestions(inputs) {
  try {
    const startTime = Date.now();
    const response = await openai.chat.completions.create({
      model: QUESTION_MODEL,
      // Questions only — a fraction of a report.
      max_tokens: 500,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: promptBuilder.SYSTEM_PROMPT },
        { role: 'user', content: promptBuilder.buildClarificationPrompt(inputs) },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    const parsed = JSON.parse(raw);
    const questions = buildClarifications(parsed.clarification_questions);
    logger.info(
      `Composed ${questions.length} clarification question(s) in ${Date.now() - startTime}ms `
        + `on ${QUESTION_MODEL}`,
    );
    return questions;
  } catch (error) {
    logger.error(`Clarification questions unavailable: ${error.message}`);
    return [];
  }
}

// Generates the structured triage report (forced JSON) from all inputs,
// including any answers given to the clarification questions.
export async function generateReport(inputs) {
  const userPrompt = promptBuilder.buildUserPrompt(inputs);

  let response;
  try {
    const startTime = Date.now();
    response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: promptBuilder.SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    response._generationTimeMs = Date.now() - startTime;
  } catch (error) {
    logger.error(`GPT report error (${error.status}): ${error.message}`);
    if (error.status === 429) throw new Error('AI service busy. Please try again.');
    if (error.status === 401) throw new Error('AI configuration error.');
    throw new Error('Report generation failed. Please describe symptoms manually.');
  }

  const rawContent = response.choices[0]?.message?.content;
  let reportData;
  try {
    reportData = JSON.parse(rawContent);
  } catch {
    logger.error(`AI returned non-JSON content: ${rawContent}`);
    throw new Error('AI returned invalid JSON');
  }

  // Ensure the required fields always exist, and that the two the database
  // constrains are values it will actually accept — "high" and "semi
  // conscious" are perfectly reasonable answers that would fail the insert.
  reportData.urgency_level = normaliseUrgency(reportData.urgency_level);
  reportData.emergency_type = reportData.emergency_type || 'unknown';
  reportData.consciousness_state = normaliseConsciousness(reportData.consciousness_state);
  if (!Array.isArray(reportData.key_observations)) reportData.key_observations = [];

  // resources_needed drives the hospital's accept/redirect decision, so it must
  // never be empty — 'Emergency Ward' is the safe universal fallback.
  if (!Array.isArray(reportData.resources_needed) || reportData.resources_needed.length === 0) {
    reportData.resources_needed = ['Emergency Ward'];
  }

  const score = Number(reportData.confidence_score);
  reportData.confidence_score =
    Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;

  return {
    ...reportData,
    generationTimeMs: response._generationTimeMs,
    model: MODEL,
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
    rawGptResponse: response,
  };
}

// Retries generateReport with a 3s backoff before giving up.
export async function generateReportWithRetry(inputs, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await generateReport(inputs);
    } catch (error) {
      lastError = error;
      logger.warn(`Report attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastError;
}

export default {
  analyzeImage,
  generateClarificationQuestions,
  generateReport,
  generateReportWithRetry,
};
