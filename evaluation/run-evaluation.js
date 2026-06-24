// Module 6 E1 — AI evaluation runner (FYP academic deliverable).
// Calls the GPT report service directly (no server/token/case needed) so the
// score isolates AI quality. Run: node evaluation/run-evaluation.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import gptService from '../src/services/ai/gpt.service.js';
import { TEST_CASES } from './test-cases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Weighted accuracy scoring for a single test case.
function scoreResult(testCase, actualOutput) {
  let score = 0;
  let maxScore = 0;
  const details = [];
  const exp = testCase.expectedOutput;

  // Urgency level — 40%.
  maxScore += 40;
  if (actualOutput.urgency_level === exp.urgency_level) {
    score += 40;
    details.push({ field: 'urgency_level', correct: true });
  } else {
    details.push({
      field: 'urgency_level',
      correct: false,
      expected: exp.urgency_level,
      actual: actualOutput.urgency_level,
    });
  }

  // Consciousness — 20%.
  if (exp.consciousness_state) {
    maxScore += 20;
    if (actualOutput.consciousness_state === exp.consciousness_state) {
      score += 20;
      details.push({ field: 'consciousness_state', correct: true });
    } else {
      details.push({
        field: 'consciousness_state',
        correct: false,
        expected: exp.consciousness_state,
        actual: actualOutput.consciousness_state,
      });
    }
  }

  // Emergency type contains — 20%.
  if (exp.emergency_type_should_contain) {
    maxScore += 20;
    const match = actualOutput.emergency_type
      ?.toLowerCase()
      .includes(exp.emergency_type_should_contain.toLowerCase());
    if (match) {
      score += 20;
      details.push({ field: 'emergency_type', correct: true });
    } else {
      details.push({
        field: 'emergency_type',
        correct: false,
        expected: `contains "${exp.emergency_type_should_contain}"`,
        actual: actualOutput.emergency_type,
      });
    }
  }

  // Key observations keyword coverage — 20%.
  if (exp.key_observations_should_contain) {
    maxScore += 20;
    const allObs = (actualOutput.key_observations || []).join(' ').toLowerCase();
    const matched = exp.key_observations_should_contain.filter((kw) =>
      allObs.includes(kw.toLowerCase()),
    );
    const obsScore = Math.round(
      (matched.length / exp.key_observations_should_contain.length) * 20,
    );
    score += obsScore;
    details.push({
      field: 'key_observations',
      correct: obsScore === 20,
      matchedKeywords: matched,
      totalExpected: exp.key_observations_should_contain.length,
    });
  }

  return {
    testId: testCase.id,
    language: testCase.language,
    percentageScore: Math.round((score / maxScore) * 100),
    passed: score >= maxScore * 0.7, // 70% threshold
    details,
  };
}

async function runAllEvaluations() {
  console.log('=== ResQPK AI Evaluation Suite ===');
  console.log(`Running ${TEST_CASES.length} test cases...\n`);

  const results = [];
  let totalScore = 0;

  for (const testCase of TEST_CASES) {
    try {
      const startTime = Date.now();
      const actualOutput = await gptService.generateReport({
        transcribedText: null,
        userText: testCase.input.text,
        imageDescriptions: [],
        medicalProfile: null,
        detectedLanguage: testCase.language === 'auto' ? 'en' : testCase.language,
      });
      const elapsed = Date.now() - startTime;

      const result = scoreResult(testCase, actualOutput);
      result.generationTimeMs = elapsed;
      results.push(result);
      totalScore += result.percentageScore;

      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`  ${status} ${testCase.id} (${testCase.language}): ${result.percentageScore}% (${elapsed}ms)`);

      await new Promise((r) => setTimeout(r, 1000)); // gentle pacing
    } catch (error) {
      console.log(`  ❌ ERROR ${testCase.id}: ${error.message}`);
      results.push({
        testId: testCase.id,
        language: testCase.language,
        percentageScore: 0,
        passed: false,
        error: error.message,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const avgScore = Math.round(totalScore / TEST_CASES.length);
  const timed = results.filter((r) => r.generationTimeMs);
  const avgTime = timed.length
    ? Math.round(timed.reduce((s, r) => s + r.generationTimeMs, 0) / timed.length)
    : 0;

  const langBreakdown = {};
  results.forEach((r) => {
    langBreakdown[r.language] ??= { total: 0, score: 0 };
    langBreakdown[r.language].total += 1;
    langBreakdown[r.language].score += r.percentageScore;
  });

  console.log('\n=== EVALUATION RESULTS ===');
  console.log(`Overall Accuracy: ${avgScore}%`);
  console.log(`Pass Rate: ${passed}/${TEST_CASES.length} (${Math.round((passed / TEST_CASES.length) * 100)}%)`);
  console.log(`Average Generation Time: ${avgTime}ms\n`);
  console.log('By Language:');
  Object.entries(langBreakdown).forEach(([lang, data]) => {
    console.log(`  ${lang.toUpperCase()}: ${Math.round(data.score / data.total)}% (${data.total} tests)`);
  });

  const failures = results.filter((r) => !r.passed);
  if (failures.length) {
    console.log('\nFailed tests:');
    failures.forEach((r) => {
      console.log(`  ❌ ${r.testId}: ${r.percentageScore}%`);
      r.details?.filter((d) => !d.correct).forEach((d) => {
        console.log(`     ${d.field}: expected "${d.expected}", got "${d.actual}"`);
      });
    });
  }

  const outPath = path.join(__dirname, 'results.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { timestamp: new Date().toISOString(), avgScore, passed, total: TEST_CASES.length, avgTimeMs: avgTime, langBreakdown, results },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to evaluation/results.json`);
  console.log('Include these in your FYP report Section 4 (Evaluation).');
}

runAllEvaluations();
