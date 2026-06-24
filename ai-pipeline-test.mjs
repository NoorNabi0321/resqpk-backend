// Module 6 B8 — AI pipeline test (Whisper + GPT) without DB or a running server.
// Run:  node ai-pipeline-test.mjs
// Needs OPENAI_API_KEY in .env. Tests text-only report, then every clip in test-audio/.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import gptService from './src/services/ai/gpt.service.js';
import whisperService from './src/services/ai/whisper.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
};

function printReport(r) {
  console.log(`   urgency:        ${r.urgency_level}`);
  console.log(`   type:           ${r.emergency_type}`);
  console.log(`   consciousness:  ${r.consciousness_state}`);
  console.log(`   observations:   ${(r.key_observations || []).join(' | ')}`);
  console.log(`   first aid:      ${r.first_aid_suggestion}`);
  console.log(
    `   gen ${r.generationTimeMs}ms · model ${r.model} · tokens ${r.promptTokens}+${r.completionTokens}`,
  );
}

async function main() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith('placeholder')) {
    console.error('❌ OPENAI_API_KEY is not set in .env');
    process.exit(1);
  }

  // 1) Text-only report (cheapest sanity check) ----------------------------
  console.log('\n=== TEST 1: text-only report ===');
  try {
    const report = await gptService.generateReport({
      transcribedText: null,
      userText:
        'Patient is a 50 year old male with severe chest pain and difficulty breathing. He is diabetic and takes insulin. No known drug allergies.',
      imageDescriptions: [],
      medicalProfile: null,
      detectedLanguage: 'en',
    });
    console.log('✅ text report OK');
    printReport(report);
  } catch (e) {
    console.error(`❌ text report failed: ${e.message}`);
  }

  // 2) Each audio clip: transcribe + report --------------------------------
  const dir = path.join(__dirname, 'test-audio');
  const clips = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => MIME[path.extname(f).toLowerCase()])
    : [];

  if (clips.length === 0) {
    console.log('\n(no audio clips in test-audio/ — add .mp3/.m4a/.wav files to test transcription)');
    return;
  }

  for (const clip of clips) {
    console.log(`\n=== TEST: ${clip} ===`);
    try {
      const buffer = fs.readFileSync(path.join(dir, clip));
      const mime = MIME[path.extname(clip).toLowerCase()];
      const t0 = Date.now();
      const tr = await whisperService.transcribeWithRetry(buffer, mime);
      console.log(`✅ transcribed in ${Date.now() - t0}ms · language: ${tr.detectedLanguage}`);
      console.log(`   text: "${tr.text}"`);

      const report = await gptService.generateReport({
        transcribedText: tr.text,
        userText: null,
        imageDescriptions: [],
        medicalProfile: null,
        detectedLanguage: tr.detectedLanguage || 'en',
      });
      printReport(report);
    } catch (e) {
      console.error(`❌ ${clip} failed: ${e.message}`);
    }
  }

  console.log('\nDone.');
}

main();
