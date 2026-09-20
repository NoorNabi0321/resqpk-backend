// Generates the AI Emergency Report as a PDF (pdfkit) and stores it in
// Supabase Storage. Called by the Module 6 AI pipeline after the JSON report
// is saved. The hospital dashboard renders this PDF inline and can download it
// — the receptionist needs a real artifact to print and attach to records.
//
// The layout answers, in order, the questions a receiving doctor asks:
// how bad is it, who is it, what does it look like, what happened, what do I
// need ready, and what do I already know about this patient.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import PDFDocument from 'pdfkit';

import { uploadToSupabaseStorage, createSignedUrl } from '../utils/file.utils.js';
import logger from '../middleware/logger.js';

const URGENCY_COLORS = Object.freeze({
  critical: '#D62828',
  moderate: '#E08A1E',
  low: '#0FA37A',
  unknown: '#78716C',
});

// Same palette as the apps, so a printed report and the dashboard agree.
const TEXT_DARK = '#1C1917';
const TEXT_SOFT = '#57534E';
const TEXT_GRAY = '#78716C';
const RULE = '#E5D9C9';
const TABLE_FILL = '#F7F0E6';
const BRAND_INK = '#C2410C';

const MARGIN = 46;
const HEADER_HEIGHT = 92;

const LOGO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/resqpk-logo.png');
let logoBuffer;
try {
  logoBuffer = fs.readFileSync(LOGO_PATH);
} catch {
  // A missing logo must never stop a report: the header falls back to text.
  logoBuffer = null;
}

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

function listOrDash(value, fallback = 'Not on file') {
  if (Array.isArray(value) && value.length) return value.join(', ');
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

// --- Drawing helpers --------------------------------------------------------

function contentWidth(doc) {
  return doc.page.width - MARGIN * 2;
}

function divider(doc) {
  doc.moveDown(0.5);
  const y = doc.y;
  doc.save().strokeColor(RULE).lineWidth(1).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y)
    .stroke().restore();
  doc.moveDown(0.5);
}

function sectionHeading(doc, label) {
  // Keep a heading with at least a line of its section rather than stranding it
  // at the foot of a page.
  if (doc.y > doc.page.height - 130) doc.addPage();
  const y = doc.y;
  doc.save().rect(MARGIN, y + 1, 3, 12).fill(BRAND_INK).restore();
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(TEXT_SOFT)
    .text(label.toUpperCase(), MARGIN + 10, y, { characterSpacing: 0.6 });
  doc.moveDown(0.45);
  doc.x = MARGIN;
  doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
}

function bulletList(doc, items, emptyText) {
  const list = (Array.isArray(items) ? items : []).filter(
    (i) => i != null && String(i).trim() !== '',
  );
  if (!list.length) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(TEXT_GRAY).text(emptyText, MARGIN, doc.y);
    doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
    return;
  }
  doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
  list.forEach((item) => {
    doc.text(`•  ${toEncodableText(item)}`, MARGIN, doc.y, { width: contentWidth(doc) });
    doc.moveDown(0.15);
  });
}

function paragraph(doc, text, emptyText) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(TEXT_GRAY).text(emptyText, MARGIN, doc.y);
    doc.font('Helvetica').fontSize(11).fillColor(TEXT_DARK);
    return;
  }
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(TEXT_DARK)
    .text(toEncodableText(value), MARGIN, doc.y, { width: contentWidth(doc), align: 'left' });
}

/**
 * The facts table: two label/value pairs per row, ruled and banded.
 *
 * A table rather than prose because this is the part staff read at a glance,
 * often over someone's shoulder, and because it is what gets copied onto the
 * admission form.
 */
function drawTable(doc, rows) {
  const width = contentWidth(doc);
  const colWidth = width / 2;
  const labelWidth = 74;
  const padding = 6;
  const rowHeight = 20;

  // Rows marked `span` take the full width. An address or a hospital name does
  // not fit in half a page, and a clipped pickup address is worse than useless
  // to the crew reading it.
  const lines = [];
  let pending = null;
  for (const row of rows) {
    if (row[2]?.span) {
      if (pending) {
        lines.push([pending]);
        pending = null;
      }
      lines.push([row]);
    } else if (pending) {
      lines.push([pending, row]);
      pending = null;
    } else {
      pending = row;
    }
  }
  if (pending) lines.push([pending]);

  lines.forEach((line, index) => {
    if (doc.y + rowHeight > doc.page.height - 70) doc.addPage();
    const y = doc.y;

    if (index % 2 === 0) {
      doc.save().rect(MARGIN, y, width, rowHeight).fill(TABLE_FILL).restore();
    }

    const cellWidth = line.length === 1 && line[0][2]?.span ? width : colWidth;

    line.forEach(([label, value], col) => {
      const x = MARGIN + col * cellWidth;
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(TEXT_GRAY)
        .text(String(label).toUpperCase(), x + padding, y + 6, {
          width: labelWidth,
          lineBreak: false,
        });
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(TEXT_DARK)
        .text(toEncodableText(value ?? '—'), x + padding + labelWidth, y + 5, {
          width: cellWidth - labelWidth - padding * 2,
          height: rowHeight - 8,
          lineBreak: false,
          ellipsis: true,
        });
    });

    doc
      .save()
      .strokeColor(RULE)
      .lineWidth(0.5)
      .moveTo(MARGIN, y + rowHeight)
      .lineTo(MARGIN + width, y + rowHeight)
      .stroke()
      .restore();

    doc.y = y + rowHeight;
  });

  doc.x = MARGIN;
  doc.moveDown(0.6);
}

// Brand band across the top of page 1, coloured by urgency.
function drawHeaderBand(doc, caseData, reportData, color) {
  doc.save().rect(0, 0, doc.page.width, HEADER_HEIGHT).fill(color).restore();

  let textX = MARGIN;
  if (logoBuffer) {
    // White plate behind the mark so the logo reads on any urgency colour.
    doc.save().roundedRect(MARGIN, 22, 48, 48, 10).fill('#FFFFFF').restore();
    try {
      doc.image(logoBuffer, MARGIN + 6, 28, { fit: [36, 36] });
    } catch {
      /* unreadable logo — the band still works without it */
    }
    textX = MARGIN + 62;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(19)
    .fillColor('#FFFFFF')
    .text('ResQPK Emergency Report', textX, 26, { width: doc.page.width - textX - MARGIN });

  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor('#FFFFFF')
    .text(
      `Case ${toEncodableText(caseData?.case_number || 'Unknown')}`
        + `${caseData?.access_code ? `   ·   Code ${toEncodableText(caseData.access_code)}` : ''}`
        + `   ·   Generated ${formatDateTime()}`,
      textX,
      50,
      { width: doc.page.width - textX - MARGIN },
    );

  const level = String(reportData?.urgency_level || 'unknown').toUpperCase();
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#FFFFFF')
    .text(
      `${level} · ${toEncodableText(titleCase(reportData?.emergency_type) || 'Type not determined')}`,
      textX,
      67,
      { width: doc.page.width - textX - MARGIN },
    );

  doc.fillColor(TEXT_DARK);
  doc.x = MARGIN;
  doc.y = HEADER_HEIGHT + 18;
}

/**
 * The photo the reporter sent.
 *
 * Worth the space: a picture of the wound settles questions that three
 * paragraphs of description leave open, and it is the one part of this report
 * no model wrote.
 */
function drawPhoto(doc, photoBuffer) {
  if (!photoBuffer) return;
  try {
    const boxWidth = contentWidth(doc);
    const boxHeight = 200;
    if (doc.y + boxHeight > doc.page.height - 90) doc.addPage();

    const y = doc.y;
    doc.save().rect(MARGIN, y, boxWidth, boxHeight).fill('#111827').restore();
    doc.image(photoBuffer, MARGIN, y, {
      fit: [boxWidth, boxHeight],
      align: 'center',
      valign: 'center',
    });
    doc.y = y + boxHeight + 4;
    doc
      .font('Helvetica-Oblique')
      .fontSize(8.5)
      .fillColor(TEXT_GRAY)
      .text('Photo taken at the scene by the person who called for help', MARGIN, doc.y, {
        width: boxWidth,
        align: 'center',
      });
    doc.moveDown(0.4);
    doc.x = MARGIN;
  } catch (err) {
    // An unsupported format (HEIC, WebP) must not cost us the whole report.
    logger.warn?.(`Report photo could not be embedded: ${err.message}`);
  }
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
        'Generated by ResQPK AI from what the caller said and sent  ·  Supports clinical '
          + `judgment, does not replace it  ·  Page ${i - range.start + 1} of ${range.count}`,
        MARGIN,
        doc.page.height - 34,
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
export async function buildReportPDFBuffer(
  reportData = {},
  caseData = {},
  medicalProfile = null,
  photoBuffer = null,
) {
  const color = urgencyColor(reportData.urgency_level);
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const bufferReady = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  drawHeaderBand(doc, caseData, reportData, color);

  // 1. THE FACTS — who, where, when, and who is bringing them.
  sectionHeading(doc, 'Case details');
  const reachOn = caseData.reporter_phone || caseData.patient_phone;
  drawTable(doc, [
    ['Patient', caseData.patient_name || caseData.reporter_name || 'Not given'],
    ['Age / sex', [
      medicalProfile?.age ? `${medicalProfile.age} yrs` : null,
      titleCase(medicalProfile?.gender) || null,
    ].filter(Boolean).join('  ·  ') || 'Not on file'],
    ['Blood group', medicalProfile?.blood_group || 'Not on file'],
    ['Reached on', reachOn || 'No number on file'],
    ['Reported by', caseData.reported_for === 'other' ? 'A bystander' : 'The patient'],
    ['Channel', titleCase(caseData.channel) || 'App'],
    ['SOS at', formatDateTime(caseData.sos_triggered_at)],
    ['Report at', formatDateTime()],
    ['Pickup', caseData.patient_address || 'Address not available', { span: true }],
    ['Coordinates', caseData.patient_lat && caseData.patient_lng
      ? `${Number(caseData.patient_lat).toFixed(5)}, ${Number(caseData.patient_lng).toFixed(5)}`
      : 'Not recorded'],
    ['Ambulance', caseData.driver_name
      ? `${caseData.driver_name}${caseData.vehicle_number ? ` (${caseData.vehicle_number})` : ''}`
      : 'Not yet assigned'],
    ['Destination', caseData.hospital_name || 'Not yet chosen', { span: true }],
  ]);

  // 2. THE PHOTO — the only part of this report no model wrote.
  if (photoBuffer) {
    sectionHeading(doc, 'Photo from the scene');
    drawPhoto(doc, photoBuffer);
  }

  // 3. WHAT HAPPENED — in the caller's own words, then the assessment.
  sectionHeading(doc, 'What the caller described');
  paragraph(
    doc,
    reportData.transcribed_text || reportData.input_text,
    'Nothing was said or typed — this report is based on the photo alone.',
  );
  divider(doc);

  sectionHeading(doc, 'Symptoms and observations');
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT_SOFT)
    .text(`Consciousness: ${titleCase(reportData.consciousness_state) || 'Unknown'}`, MARGIN, doc.y);
  doc.moveDown(0.35);
  bulletList(doc, reportData.key_observations, 'No specific observations recorded.');
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEXT_GRAY)
    .text('POSSIBLE CONDITIONS', MARGIN, doc.y);
  doc.moveDown(0.25);
  bulletList(doc, reportData.possible_conditions, 'No conditions suggested.');
  doc.moveDown(0.25);
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(TEXT_GRAY)
    .text('AI assessment from the caller\'s description — clinical judgment required.', MARGIN, doc.y);
  divider(doc);

  // 4. THE ASK — what this hospital should have waiting. The whole point of
  //    sending the report ahead of the ambulance.
  const resources = Array.isArray(reportData.resources_needed)
    ? reportData.resources_needed.filter(Boolean)
    : [];
  // Keep the list whole. Split across a page break, the ward sees "trauma bay"
  // and has to turn over to find the blood.
  if (doc.y + 34 + resources.length * 24 > doc.page.height - 90) doc.addPage();
  sectionHeading(doc, 'Have ready on arrival');
  if (resources.length) {
    const width = contentWidth(doc);
    resources.forEach((item) => {
      if (doc.y + 22 > doc.page.height - 80) doc.addPage();
      const y = doc.y;
      doc.save().roundedRect(MARGIN, y, width, 20, 5).fill('#FDECEC').restore();
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#D62828')
        .text(toEncodableText(item), MARGIN + 8, y + 5.5, { width: width - 16, lineBreak: false });
      doc.y = y + 24;
    });
    doc.x = MARGIN;
  } else {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(TEXT_GRAY)
      .text('No specific resources identified.', MARGIN, doc.y);
  }
  doc.moveDown(0.4);
  paragraph(doc, reportData.hospital_preparation, 'No further preparation notes.');
  divider(doc);

  // 5. FIRST AID — what was done, or should be, before arrival.
  sectionHeading(doc, 'First aid given or advised');
  paragraph(doc, reportData.first_aid_suggestion, 'No first aid guidance recorded.');
  divider(doc);

  // 6. HISTORY — what we already knew about this patient.
  sectionHeading(doc, 'Known medical history');
  const meds = Array.isArray(reportData.medications_mentioned)
    ? reportData.medications_mentioned.filter(Boolean)
    : [];
  drawTable(doc, [
    ['Conditions', listOrDash(medicalProfile?.chronic_conditions)],
    ['Allergies', listOrDash(medicalProfile?.allergies)],
    ['Medicines', listOrDash(meds, 'None mentioned')],
    ['Profile', medicalProfile ? 'From the patient\'s account' : 'No account — nothing on file'],
  ]);

  // APPENDIX — original transcription, on its own page.
  const transcript = typeof reportData.transcribed_text === 'string'
    ? reportData.transcribed_text.trim()
    : '';
  if (transcript) {
    doc.addPage();
    const lang = String(reportData.input_language || 'unknown');
    sectionHeading(doc, `Original input (${toEncodableText(lang)})`);
    if (lang === 'ur' || lang === 'sd') {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(TEXT_GRAY)
        .text('[Spoken in Urdu/Sindhi — the app shows the original script]', MARGIN, doc.y);
      doc.moveDown(0.5);
    }
    doc.font('Helvetica').fontSize(10).fillColor(TEXT_DARK)
      .text(toEncodableText(transcript), MARGIN, doc.y, { width: contentWidth(doc) });
  }

  drawFooters(doc);
  doc.end();
  return bufferReady;
}

/**
 * Builds the report PDF and uploads it to Supabase Storage.
 * @returns {Promise<{pdfBuffer: Buffer, storagePath: string, signedUrl: string}>}
 */
export async function generateReportPDF(
  reportData = {},
  caseData = {},
  medicalProfile = null,
  photoBuffer = null,
) {
  const pdfBuffer = await buildReportPDFBuffer(reportData, caseData, medicalProfile, photoBuffer);

  const { path: storagePath, signedUrl } = await uploadToSupabaseStorage(
    pdfBuffer,
    `report-${caseData.case_number || 'case'}.pdf`,
    'application/pdf',
    `cases/${caseData.id}/reports`,
  );

  logger.info(`Report PDF generated for case ${caseData.case_number} (${pdfBuffer.length} bytes)`);
  return { pdfBuffer, storagePath, signedUrl };
}

// Fresh 6-hour signed URL for an already-stored PDF (old case reopened).
export async function getSignedPdfUrl(storagePath) {
  return createSignedUrl(storagePath, 60 * 60 * 6);
}

export default { buildReportPDFBuffer, generateReportPDF, getSignedPdfUrl };
