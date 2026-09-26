// The report must be one page. Always.
//
// It is printed and clipped to a chart; a second page is a page left on the
// printer. The layout has no addPage in it, but pdfkit will start a new one by
// itself the moment text runs past the bottom margin — silently, and only for
// the data that happens to be long. So this renders the extremes and counts.
//
// Run: node evaluation/pdf-one-page.mjs
// Needs pymupdf for the page count: pip install pymupdf
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { buildReportPDFBuffer } from '../src/services/pdf.service.js';

const LONG = 'A'.repeat(600);
const URDU = 'میری والدہ 65 سال کی ہے۔ اچانک ان کے چہرے کا ایک طرف تیڑا ہو گیا ہے اور '
  + 'وہ ٹھیک سے بول نہیں پا رہی۔ ان کا دایا ہاتھ اور ٹانگ بھی کمزور ہو گئے ہیں۔ '
  + 'جلدی ایمبولینس پھیجیں۔ ان کو ہائی بلڈ پریشر بھی ہے اور وہ روزانہ دوائی لیتی ہیں۔';

const photo = fs.readFileSync(new URL('../src/assets/resqpk-logo.png', import.meta.url));

const FIXTURES = [
  {
    name: 'everything at once, Urdu',
    report: {
      urgency_level: 'critical', emergency_type: 'stroke',
      transcribed_text: URDU, input_language: 'ur', consciousness_state: 'conscious',
      key_observations: Array.from({ length: 12 }, (_, i) => `Observation number ${i + 1} with a reasonably long description`),
      possible_conditions: Array.from({ length: 9 }, (_, i) => `Possible condition ${i + 1}`),
      resources_needed: ['Stroke Team', 'CT Scanner', 'Emergency Ward', 'Thrombolysis', 'ICU Bed', 'Blood Bank', 'Ventilator'],
      hospital_preparation: LONG, first_aid_suggestion: LONG,
      medications_mentioned: ['Aspirin 75mg daily', 'Metformin 500mg', 'Amlodipine 5mg'],
    },
    caseData: {
      patient_name: 'A Patient With A Very Long Name Indeed',
      patient_address: LONG, driver_name: 'Usman Ali', vehicle_number: 'SBC-80656',
      hospital_name: LONG,
    },
    profile: { age: 65, gender: 'female', blood_group: 'B+', chronic_conditions: [LONG], allergies: [LONG] },
    photo,
  },
  {
    name: 'empty report, no photo, no profile',
    report: {}, caseData: {}, profile: null, photo: null,
  },
  {
    name: 'photo only, nothing said',
    report: { urgency_level: 'moderate', emergency_type: 'fall' },
    caseData: { patient_name: 'Ali' }, profile: null, photo,
  },
  {
    name: 'typed English, long single paragraph',
    report: {
      urgency_level: 'low', emergency_type: 'burn',
      input_text: LONG, consciousness_state: 'conscious',
      key_observations: ['Redness on forearm'], resources_needed: ['Burns Unit'],
    },
    caseData: { patient_name: 'Sara' }, profile: { age: 30, gender: 'female' }, photo,
  },
];

function pageCount(buffer) {
  const file = path.join(os.tmpdir(), `resqpk-onepage-${Date.now()}.pdf`);
  fs.writeFileSync(file, buffer);
  try {
    // `pymupdf`, not `fitz`: the old alias prints a deprecation banner on
    // stdout, which lands in front of the number and parses as NaN.
    const out = execFileSync('python', [
      '-c',
      'import sys,pymupdf;print(pymupdf.open(sys.argv[1]).page_count)',
      file,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const last = out.trim().split(/\r?\n/).pop();
    return Number(last);
  } finally {
    fs.unlinkSync(file);
  }
}

let failed = 0;
for (const f of FIXTURES) {
  const buf = await buildReportPDFBuffer(f.report, f.caseData, f.profile, f.photo);
  const pages = pageCount(buf);
  const ok = pages === 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(pages).padStart(2)} page(s)  ${(buf.length / 1024 | 0)}KB  ${f.name}`);
}

console.log(failed ? `\n${failed} fixture(s) spilled onto a second page.` : '\nAll fixtures fit one page.');
process.exit(failed ? 1 : 0);
