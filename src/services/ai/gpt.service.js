// Module 6 — GPT-4o structured emergency report generation + image vision.
import OpenAI from 'openai';

import promptBuilder from './prompt.builder.js';
import logger from '../../middleware/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cheaper model in dev, full gpt-4o in production (both overridable via env).
const MODEL =
  process.env.NODE_ENV === 'production'
    ? process.env.OPENAI_MODEL_PRODUCTION || 'gpt-4o'
    : process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

// Generates the structured triage report (forced JSON) from all inputs.
export async function generateReport(inputs) {
  const userPrompt = promptBuilder.buildUserPrompt(inputs);

  let response;
  try {
    const startTime = Date.now();
    response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 800,
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

  // Ensure the required fields always exist, even if the model omitted them.
  reportData.urgency_level = reportData.urgency_level || 'unknown';
  reportData.emergency_type = reportData.emergency_type || 'unknown';
  reportData.consciousness_state = reportData.consciousness_state || 'unknown';
  if (!Array.isArray(reportData.key_observations)) reportData.key_observations = [];

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

export default { analyzeImage, generateReport, generateReportWithRetry };
