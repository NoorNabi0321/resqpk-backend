// A real report fits one page. Nothing ever runs to three.
//
// pdfkit starts a new page by itself the moment text passes the bottom margin
// — silently, and only for the data that happens to be long, which is exactly
// the data nobody tests with. So this renders both ends: reports of the shape
// the app actually produces, which must come out on one page, and a
// deliberately absurd one, which may spill to two and no further.
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
    name: 'absurd: every field long, 12 observations',
    max: 2,
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
    // The shape the app actually produces: a spoken Urdu report with a photo,
    // five observations and a couple of sentences per clinical field. This is
    // the one that has to stay on a single page.
    name: 'realistic: spoken Urdu stroke report',
    max: 1,
    report: {
      urgency_level: 'critical', emergency_type: 'stroke',
      transcribed_text: URDU, input_language: 'ur', consciousness_state: 'conscious',
      key_observations: [
        'Facial droop on one side', 'Slurred or absent speech',
        'Right arm and leg weakness', 'Sudden onset, under one hour',
        'Patient is seated and responsive',
      ],
      possible_conditions: ['Acute ischaemic stroke', 'Transient ischaemic attack'],
      resources_needed: ['Stroke Team', 'CT Scanner', 'Emergency Ward', 'Thrombolysis'],
      hospital_preparation: 'Activate the stroke pathway, keep the patient nil by mouth '
        + 'and prepare for an urgent CT on arrival.',
      first_aid_suggestion: 'Keep the patient sitting up, give nothing to eat or drink, '
        + 'and note the time the symptoms began.',
      medications_mentioned: ['Aspirin 75mg daily'],
    },
    caseData: {
      patient_name: 'Noor Nabi',
      patient_address: 'Shahi Bazar, near Tower Market, Hyderabad, Sindh',
      driver_name: 'Usman Ali', vehicle_number: 'SBC-80656',
      hospital_name: 'Civil Hospital Hyderabad',
    },
    profile: {
      age: 65, gender: 'female', blood_group: 'B+',
      chronic_conditions: ['Hypertension', 'Diabetes type 2'], allergies: ['Penicillin'],
    },
    photo,
  },
  {
    name: 'empty report, no photo, no profile',
    max: 1, report: {}, caseData: {}, profile: null, photo: null,
  },
  {
    name: 'photo only, nothing said',
    max: 1,
    report: { urgency_level: 'moderate', emergency_type: 'fall' },
    caseData: { patient_name: 'Ali' }, profile: null, photo,
  },
  {
    name: 'typed English, long single paragraph',
    max: 1,
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
  const ok = pages >= 1 && pages <= f.max;
  if (!ok) failed += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${pages} of max ${f.max}  `
      + `${String((buf.length / 1024) | 0).padStart(3)}KB  ${f.name}`,
  );
}

console.log(failed ? `\n${failed} fixture(s) over budget.` : '\nEvery fixture within budget.');
process.exit(failed ? 1 : 0);
