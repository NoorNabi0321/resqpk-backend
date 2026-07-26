// Offline check for the AI report PDF renderer (Instruction 2.3).
// Builds a PDF buffer with realistic data — including an Urdu transcription —
// and writes it to disk so the layout can be eyeballed. No network needed.
import fs from 'fs';
import path from 'path';

import { buildReportPDFBuffer } from '../src/services/pdf.service.js';

const reportData = {
  urgency_level: 'critical',
  emergency_type: 'cardiac_emergency',
  consciousness_state: 'unconscious',
  key_observations: [
    'Patient collapsed suddenly while walking in the street',
    'Severe chest pain reported immediately before collapse',
    'Breathing is shallow and irregular',
    'Skin pale and clammy to the touch',
  ],
  possible_conditions: ['Acute myocardial infarction', 'Cardiac arrhythmia'],
  first_aid_suggestion:
    'Keep the patient flat on their back. Loosen tight clothing around the neck and chest. Do not give food or water. If breathing stops, begin CPR: 30 chest compressions followed by 2 rescue breaths, repeating until the ambulance arrives.',
  hospital_preparation:
    'Prepare the cardiac resuscitation bay. Alert the cardiology team. Have a defibrillator and ECG ready at the emergency gate.',
  resources_needed: ['ECG', 'Defibrillator', 'Cardiologist', 'ICU', 'Oxygen'],
  medications_mentioned: ['Aspirin', 'Metformin'],
  transcribed_text:
    'مریض اچانک گر گیا ہے اور اسے سینے میں شدید درد ہو رہا ہے۔ وہ ذیابیطس کا مریض ہے۔ Please send an ambulance quickly to Latifabad Unit 7.',
  input_language: 'ur',
};

const caseData = {
  id: 'test-case-uuid-1234',
  case_number: 'RQ-20260725-0007',
  patient_name: 'Ahmed Khan',
  patient_address: 'Latifabad Unit 7, near Sarfaraz Colony, Hyderabad, Sindh',
  sos_triggered_at: new Date().toISOString(),
};

const medicalProfile = {
  blood_group: 'O+',
  gender: 'male',
  age: 45,
  chronic_conditions: ['Diabetes Type 2', 'Hypertension'],
  allergies: ['Penicillin'],
};

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return condition ? 0 : 1;
}

let failures = 0;

// 1. Full report renders.
const buf = await buildReportPDFBuffer(reportData, caseData, medicalProfile);
failures += check('renders a PDF buffer', Buffer.isBuffer(buf) && buf.length > 3000, `${buf.length} bytes`);
failures += check('has PDF magic header', buf.subarray(0, 5).toString() === '%PDF-');

const text = buf.toString('latin1');
failures += check('multi-page (transcription appendix)', (text.match(/\/Type\s*\/Page[^s]/g) || []).length >= 2);

// 2. Minimal/empty data must not throw (unknown urgency, no report fields).
const minimal = await buildReportPDFBuffer({}, { case_number: 'RQ-EMPTY', id: 'x' }, null);
failures += check('handles empty report data', Buffer.isBuffer(minimal) && minimal.length > 1000);

// 3. Non-Latin only, no crash.
const urduOnly = await buildReportPDFBuffer(
  { urgency_level: 'moderate', transcribed_text: 'مریض کو سانس لینے میں دشواری ہے', input_language: 'sd' },
  { case_number: 'RQ-URDU', id: 'y' },
  null,
);
failures += check('handles Urdu/Sindhi-only input', Buffer.isBuffer(urduOnly) && urduOnly.length > 1000);

// 4. Each urgency level picks a colour without error.
for (const level of ['critical', 'moderate', 'low', 'unknown', 'nonsense']) {
  // eslint-disable-next-line no-await-in-loop
  const b = await buildReportPDFBuffer({ urgency_level: level }, { case_number: 'RQ-C', id: 'z' }, null);
  failures += check(`urgency '${level}' renders`, Buffer.isBuffer(b));
}

const outPath = path.join(process.cwd(), 'evaluation', 'sample-report.pdf');
fs.writeFileSync(outPath, buf);
console.log(`\nSample written to ${outPath}`);
console.log(failures === 0 ? '\nAll PDF checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
