// Offline checks for Instruction 2.4 — resources_needed in the prompt and the
// gpt.service fallback. No OpenAI calls: we only inspect prompt text and run
// the post-parse validation logic.
import promptBuilder from '../src/services/ai/prompt.builder.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// --- prompt.builder ---------------------------------------------------------
const prompt = promptBuilder.buildUserPrompt({
  userText: 'Severe chest pain, patient unconscious, has diabetes',
  medicalProfile: { blood_group: 'O+', chronic_conditions: ['Diabetes'] },
});

check('output format declares resources_needed', prompt.includes('"resources_needed": ["string", ...]'));
check('standard list is included', prompt.includes('ECG, Ventilator, X-Ray, CT Scan, Defibrillator'));
check('list continues to General Physician', prompt.includes('Emergency Ward, Trauma Center, General Physician'));
check('caps the list at 6 items', prompt.includes('Maximum 6 items'));
check('states the unclear-case fallback', prompt.includes("include 'Emergency Ward' only"));
check('resources_needed precedes medications_mentioned',
  prompt.indexOf('resources_needed') < prompt.indexOf('medications_mentioned'));

check('SYSTEM_PROMPT has rule 8', promptBuilder.SYSTEM_PROMPT.includes('8. resources_needed must use ONLY terms'));
check('rule 8 forbids invented names', promptBuilder.SYSTEM_PROMPT.includes('never invent equipment names'));
check('existing rules intact', promptBuilder.SYSTEM_PROMPT.includes('7. Respect patient privacy'));

// --- gpt.service fallback ---------------------------------------------------
// Mirrors the normalisation block in generateReport (kept in sync by test 12).
function applyFallback(reportData) {
  if (!Array.isArray(reportData.resources_needed) || reportData.resources_needed.length === 0) {
    reportData.resources_needed = ['Emergency Ward'];
  }
  return reportData;
}
check('missing field defaults', applyFallback({}).resources_needed[0] === 'Emergency Ward');
check('empty array defaults', applyFallback({ resources_needed: [] }).resources_needed[0] === 'Emergency Ward');
check('non-array defaults', applyFallback({ resources_needed: 'ICU' }).resources_needed[0] === 'Emergency Ward');
check('valid list preserved',
  applyFallback({ resources_needed: ['ECG', 'ICU'] }).resources_needed.join() === 'ECG,ICU');

// Guard: the real service must still contain this fallback.
const gptSrc = await (await import('node:fs/promises')).readFile(
  new URL('../src/services/ai/gpt.service.js', import.meta.url), 'utf8');
check('gpt.service contains the fallback', gptSrc.includes("reportData.resources_needed = ['Emergency Ward']"));

// Guard: pipeline persists resources_needed and generates the PDF.
const pipeSrc = await (await import('node:fs/promises')).readFile(
  new URL('../src/services/ai/ai.pipeline.js', import.meta.url), 'utf8');
check('pipeline persists resources_needed', pipeSrc.includes('resources_needed: reportData.resources_needed'));
check('pipeline calls generateReportPDF', pipeSrc.includes('pdfService.generateReportPDF'));
check('pipeline saves pdf columns', pipeSrc.includes('pdf_storage_path: pdfResult.storagePath'));
check('PDF failure is caught', pipeSrc.includes('PDF generation failed for case'));
check('broadcast carries pdfUrl', pipeSrc.includes('pdfUrl: pdfResult?.signedUrl || null'));
check('broadcast carries resourcesNeeded', pipeSrc.includes('resourcesNeeded: reportData.resources_needed'));

console.log(failures === 0 ? '\nAll Instruction 2.4 checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
