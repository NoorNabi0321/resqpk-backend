// Generates the AI Emergency Report as a PDF (pdfkit) and stores it in
// Supabase Storage. Called by the Module 6 AI pipeline after the JSON report
// is saved. The hospital dashboard renders this PDF inline and can download it
// — the receptionist needs a real artifact to print and attach to records.
import PDFDocument from 'pdfkit';

import { uploadToSupabaseStorage, createSignedUrl } from '../utils/file.utils.js';
import logger from '../middleware/logger.js';

const URGENCY_COLORS = Object.freeze({
  critical: '#DC2626',
  moderate: '#D97706',
  low: '#059669',
  unknown: '#6B7280',
});

const TEXT_DARK = '#111827';
const TEXT_GRAY = '#6B7280';
const RULE = '#D6DBE4';
const MARGIN = 50;
const HEADER_HEIGHT = 80;

function urgencyColor(level) {
  return URGENCY_COLORS[String(level || '').toLowerCase()] || URGENCY_COLORS.unknown;
}

function titleCase(value) {
  const s = String(value || '').replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

// PDFKit's built-in fonts are WinAnsi-encoded and cannot represent Urdu/Sindhi
// script or emoji. Strip anything unencodable so a non-Latin transcription can
// never crash report generation — the appendix documents the limitation.
function toEncodableText(value) {
  const s = String(value ?? '').normalize('NFC');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) { out += ch; continue; }  // tab, newline, CR
    if (c < 32 || c === 127) continue;                             // other control chars
    if (c <= 126) { out += ch; continue; }                         // printable ASCII
    if (c >= 160 && c <= 255) { out += ch; continue; }             // Latin-1 supplement
    out += '?';                                                    // unencodable glyph
  }
  return out;
}

function formatDateTime(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return 'Unknown';
  // Pakistan Standard Time (UTC+5, no DST) — the audience is local staff.
  return `${d.toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })} PKT`;
}

function listOrDash(value) {
  if (Array.isArray(value) && value.length) return value.join(', ');
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'Not on file';
}

// --- Drawing helpers --------------------------------------------------------

function contentWidth(doc) {
  return doc.page.width - MARGIN * 2;
}

function divider(doc) {
  doc.moveDown(0.6);
  const y = doc.y;
  doc
    .save()
    .strokeColor(RULE)
    .lineWidth(1)
    .moveTo(MARGIN, y)
    .lineTo(doc.page.width - MARGIN, y)
    .stroke()
    .restore();
  doc.moveDown(0.6);
}

function sectionHeading(doc, label) {
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(TEXT_GRAY)
    .text(label.toUpperCase(), MARGIN, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
}

function labelledLine(doc, label, value) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT_GRAY).text(`${label}  `, {
    continued: true,
  });
  doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK).text(toEncodableText(value));
  doc.moveDown(0.2);
}

function bulletList(doc, items, emptyText) {
  const list = (Array.isArray(items) ? items : []).filter(
    (i) => i != null && String(i).trim() !== '',
  );
  if (!list.length) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(TEXT_GRAY).text(emptyText);
    doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
    return;
  }
  doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
  list.forEach((item) => {
    doc.text(`•  ${toEncodableText(item)}`, { width: contentWidth(doc), align: 'left' });
    doc.moveDown(0.15);
  });
}

function paragraph(doc, text, emptyText) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(TEXT_GRAY).text(emptyText);
    doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
    return;
  }
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(TEXT_DARK)
    .text(toEncodableText(value), { width: contentWidth(doc), align: 'left' });
}

// Coloured band across the top of page 1 with the report identity.
function drawHeaderBand(doc, caseData, color) {
  doc.save().rect(0, 0, doc.page.width, HEADER_HEIGHT).fill(color).restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#FFFFFF')
    .text('ResQPK EMERGENCY REPORT', MARGIN, 24, { width: contentWidth(doc) });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#FFFFFF')
    .text(
      `Case ${toEncodableText(caseData?.case_number || 'Unknown')}   ·   Generated ${formatDateTime()}`,
      MARGIN,
      52,
      { width: contentWidth(doc) },
    );

  doc.fillColor(TEXT_DARK);
  doc.y = HEADER_HEIGHT + 24;
}

// 'URGENCY: CRITICAL' left, emergency type right, on one line.
function drawUrgencyLine(doc, reportData, color) {
  const level = String(reportData?.urgency_level || 'unknown').toUpperCase();
  const type = titleCase(reportData?.emergency_type) || 'Not determined';
  const y = doc.y;

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(color)
    .text(`URGENCY: ${level}`, MARGIN, y, { width: contentWidth(doc) / 2, align: 'left' });

  doc
    .font('Helvetica')
    .fontSize(12)
    .fillColor(TEXT_DARK)
    .text(`Type: ${toEncodableText(type)}`, MARGIN + contentWidth(doc) / 2, y + 3, {
      width: contentWidth(doc) / 2,
      align: 'right',
    });

  doc.y = y + 26;
  doc.x = MARGIN;
}

// Footer on every page. Runs after content via bufferPages so the page count
// is known; margins are neutralised so writing low cannot add a page.
function drawFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(TEXT_GRAY)
      .text(
        `Generated by ResQPK AI  ·  Not a medical diagnosis  ·  Page ${i - range.start + 1} of ${range.count}`,
        MARGIN,
        doc.page.height - 38,
        { width: contentWidth(doc), align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = bottom;
  }
}

// --- Public API -------------------------------------------------------------

/**
 * Renders the report to a PDF buffer. Pure — no network, no storage — so it
 * can be unit-tested offline and reused if we ever email or print reports.
 * @returns {Promise<Buffer>}
 */
export async function buildReportPDFBuffer(reportData = {}, caseData = {}, medicalProfile = null) {
  const color = urgencyColor(reportData.urgency_level);
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const bufferReady = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // HEADER + URGENCY
  drawHeaderBand(doc, caseData, color);
  drawUrgencyLine(doc, reportData, color);
  divider(doc);

  // PATIENT
  sectionHeading(doc, 'Patient');
  labelledLine(doc, 'Name', caseData.patient_name || 'Unknown');
  const gender = titleCase(medicalProfile?.gender);
  const age = medicalProfile?.age ?? medicalProfile?.date_of_birth ?? null;
  if (gender || age) {
    labelledLine(doc, 'Details', [gender, age ? `Age ${age}` : null].filter(Boolean).join('  ·  '));
  }
  labelledLine(doc, 'Location', caseData.patient_address || 'Address not available');
  labelledLine(doc, 'Blood group', medicalProfile?.blood_group || 'Not on file');
  labelledLine(doc, 'Conditions', listOrDash(medicalProfile?.chronic_conditions));
  labelledLine(doc, 'Allergies', listOrDash(medicalProfile?.allergies));
  labelledLine(doc, 'SOS triggered', formatDateTime(caseData.sos_triggered_at));
  divider(doc);

  // CLINICAL ASSESSMENT
  sectionHeading(doc, 'Clinical Assessment');
  labelledLine(doc, 'Consciousness', titleCase(reportData.consciousness_state) || 'Unknown');
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT_GRAY).text('KEY OBSERVATIONS');
  doc.moveDown(0.25);
  bulletList(doc, reportData.key_observations, 'No observations recorded.');
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT_GRAY).text('POSSIBLE CONDITIONS');
  doc.moveDown(0.25);
  bulletList(doc, reportData.possible_conditions, 'No conditions suggested.');
  doc.moveDown(0.3);
  doc
    .font('Helvetica-Oblique')
    .fontSize(9)
    .fillColor(TEXT_GRAY)
    .text('AI assessment — clinical judgment required');
  divider(doc);

  // RESOURCES — the bridge to the hospital's accept/redirect decision.
  sectionHeading(doc, 'Resources Likely Needed');
  const resources = Array.isArray(reportData.resources_needed) ? reportData.resources_needed : [];
  if (resources.length) {
    doc.font('Helvetica').fontSize(12).fillColor(TEXT_DARK);
    resources.forEach((item) => {
      doc.text(`•  ${toEncodableText(item)}`, { width: contentWidth(doc) });
      doc.moveDown(0.2);
    });
  } else {
    doc
      .font('Helvetica-Oblique')
      .fontSize(10)
      .fillColor(TEXT_GRAY)
      .text('No specific resources identified');
  }
  divider(doc);

  // FIRST AID
  sectionHeading(doc, 'First Aid Given / Suggested');
  paragraph(doc, reportData.first_aid_suggestion, 'No first aid guidance recorded.');
  divider(doc);

  // HOSPITAL PREPARATION
  sectionHeading(doc, 'Hospital Preparation Notes');
  paragraph(doc, reportData.hospital_preparation, 'No preparation notes provided.');

  // MEDICATIONS (only when the AI picked any up)
  const meds = Array.isArray(reportData.medications_mentioned)
    ? reportData.medications_mentioned.filter(Boolean)
    : [];
  if (meds.length) {
    divider(doc);
    sectionHeading(doc, 'Medications Mentioned');
    bulletList(doc, meds, '');
  }

  // APPENDIX — original transcription, on its own page.
  const transcript = typeof reportData.transcribed_text === 'string' ? reportData.transcribed_text.trim() : '';
  if (transcript) {
    doc.addPage();
    const lang = String(reportData.input_language || 'unknown');
    sectionHeading(doc, `Original Input Transcription (${toEncodableText(lang)})`);
    if (lang === 'ur' || lang === 'sd') {
      doc
        .font('Helvetica-Oblique')
        .fontSize(9)
        .fillColor(TEXT_GRAY)
        .text('[Original was in Urdu/Sindhi — see app for native script]');
      doc.moveDown(0.5);
    }
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(TEXT_DARK)
      .text(toEncodableText(transcript), { width: contentWidth(doc), align: 'left' });
  }

  drawFooters(doc);
  doc.end();
  return bufferReady;
}

/**
 * Builds the report PDF and uploads it to Supabase Storage.
 * @returns {Promise<{pdfBuffer: Buffer, storagePath: string, signedUrl: string}>}
 */
export async function generateReportPDF(reportData = {}, caseData = {}, medicalProfile = null) {
  const pdfBuffer = await buildReportPDFBuffer(reportData, caseData, medicalProfile);

  const { path, signedUrl } = await uploadToSupabaseStorage(
    pdfBuffer,
    `report-${caseData.case_number || 'case'}.pdf`,
    'application/pdf',
    `cases/${caseData.id}/reports`,
  );

  logger.info(`Report PDF generated for case ${caseData.case_number} (${pdfBuffer.length} bytes)`);
  return { pdfBuffer, storagePath: path, signedUrl };
}

// Fresh 6-hour signed URL for an already-stored PDF (old case reopened).
export async function getSignedPdfUrl(storagePath) {
  return createSignedUrl(storagePath, 60 * 60 * 6);
}

export default { buildReportPDFBuffer, generateReportPDF, getSignedPdfUrl };
