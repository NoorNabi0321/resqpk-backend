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
import { createRequire } from 'module';
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

// --- The one-page budget ----------------------------------------------------
//
// This report is printed and clipped to a chart, and a receiving ward reads
// the sheet in front of it. A second page is a page that gets left on the
// printer. So the layout has no addPage anywhere, and every section that grows
// with the data is capped: lists are truncated, paragraphs are clamped with
// ellipsis, and the resource line shrinks its own type to fit.
//
// These numbers are what fits an A4 page with the photo. one-page.test.mjs
// renders the extremes — a report with everything, long text in every field —
// and fails if the result is more than one page.
const PHOTO_HEIGHT = 96;
const MAX_OBSERVATIONS = 5;
const MAX_CONDITIONS = 5;

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

// --- Urdu and Sindhi --------------------------------------------------------
//
// PDFKit's built-in fonts are WinAnsi-encoded and have no Arabic glyphs, so
// every Urdu character used to come out as "?". A whole spoken report read
// "??????????????" and the appendix apologised for it.
//
// Noto Naskh Arabic is embedded instead. fontkit — which pdfkit already uses —
// applies the Arabic shaper, so letters take their initial/medial/final forms
// and the run is reordered right-to-left, while Latin words and digits inside
// it keep their own direction. Verified by rendering: "میری والدہ 65 سال" comes
// out shaped, in the right order, with 65 still reading 65.
const require = createRequire(import.meta.url);

const URDU_FONT = 'NotoNaskh';
let urduFontPath = null;
try {
  urduFontPath = require.resolve(
    '@expo-google-fonts/noto-naskh-arabic/400Regular/NotoNaskhArabic_400Regular.ttf',
  );
} catch {
  // Missing font must never stop a report; Arabic text falls back to the
  // stripping below, which is what the whole report used to do.
  urduFontPath = null;
}

function registerFonts(doc) {
  if (!urduFontPath) return false;
  try {
    doc.registerFont(URDU_FONT, urduFontPath);
    return true;
  } catch (err) {
    logger.warn?.(`Urdu font unavailable, falling back to Latin: ${err.message}`);
    return false;
  }
}

// Arabic block (Urdu, Sindhi) plus its supplement and extended ranges.
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

function isArabicScript(value) {
  return ARABIC.test(String(value ?? ''));
}

// Strip anything the built-in Latin fonts cannot encode. Only reached for text
// that is not Arabic — Arabic now has a font of its own.
function toEncodableText(value) {
  const s = String(value ?? '')
    .normalize('NFC')
    // Typographic punctuation is outside Latin-1, so a model writing "Bell's
    // palsy" with a curly apostrophe printed "Bell?s palsy". Fold it to ASCII
    // before anything gets replaced with a question mark.
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ');
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

/**
 * Text that renders in whichever script it happens to be written in.
 *
 * Arabic-script text gets the embedded font and right alignment, which is what
 * makes the line read right-to-left. Everything else is unchanged.
 */
function scriptText(doc, value, x, y, options = {}, size = 10.5, color = TEXT_DARK) {
  const raw = String(value ?? '');
  const arabic = isArabicScript(raw) && urduFontPath;
  doc
    .font(arabic ? URDU_FONT : 'Helvetica')
    .fontSize(arabic ? size + 0.5 : size)
    .fillColor(color)
    .text(arabic ? raw.normalize('NFC') : toEncodableText(raw), x, y, {
      ...options,
      align: arabic ? 'right' : (options.align || 'left'),
    });
  return arabic;
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
  doc.moveDown(0.35);
  const y = doc.y;
  doc.save().strokeColor(RULE).lineWidth(1).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y)
    .stroke().restore();
  doc.moveDown(0.35);
}

function sectionHeading(doc, label) {
  // The one-page budget is tight; PDF_TRACE=1 prints where each section lands.
  if (process.env.PDF_TRACE) console.log(`  y=${doc.y.toFixed(0)}  ${label}`);
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

/**
 * Symptoms and observations, as a ruled table rather than a bullet list.
 *
 * One observation per row, numbered, with consciousness as the first row
 * because it is the thing the ward triages on before it reads anything else.
 */
function drawObservationTable(doc, consciousness, observations) {
  const width = contentWidth(doc);
  const rowHeight = 15;
  const numWidth = 22;
  const padding = 7;

  const rows = [
    { label: 'Consciousness', value: consciousness, head: true },
    ...observations.map((o, i) => ({ label: String(i + 1), value: o })),
  ];

  rows.forEach((row, index) => {
    const y = doc.y;
    if (row.head) {
      doc.save().rect(MARGIN, y, width, rowHeight).fill('#F1E7D8').restore();
    } else if (index % 2 === 0) {
      doc.save().rect(MARGIN, y, width, rowHeight).fill(TABLE_FILL).restore();
    }

    // The header row's left cell stays empty: "STATE" wrapped inside a 22pt
    // column and its second line landed on top of observation 1.
    if (!row.head) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(TEXT_GRAY)
        .text(row.label, MARGIN + padding, y + 4.5, { width: numWidth, lineBreak: false });
    }

    doc
      .font(row.head ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(9.5)
      .fillColor(TEXT_DARK)
      .text(
        toEncodableText(row.head ? `${row.label}: ${row.value}` : row.value),
        MARGIN + padding + numWidth,
        y + 4.5,
        { width: width - numWidth - padding * 2, height: rowHeight - 6, lineBreak: false, ellipsis: true },
      );

    doc.save().strokeColor(RULE).lineWidth(0.5)
      .moveTo(MARGIN, y + rowHeight).lineTo(MARGIN + width, y + rowHeight).stroke().restore();
    doc.y = y + rowHeight;
  });

  doc.x = MARGIN;
}

/**
 * What the hospital should have waiting — one line of red chips split by "|".
 *
 * A line rather than a stack: it is four or five words that must be taken in
 * at a glance by someone walking, and stacked boxes pushed the rest of the
 * report onto a second page.
 */
function drawResourceLine(doc, items) {
  const width = contentWidth(doc);
  const SEP = '  |  ';
  const padX = 7;
  const boxHeight = 19;

  // Shrink to fit rather than wrap. Below the floor, drop the tail into a
  // "+n more" chip so nothing is silently lost.
  let size = 10;
  let shown = items;
  const measure = (list, fontSize) => {
    doc.font('Helvetica-Bold').fontSize(fontSize);
    return list.reduce(
      (sum, item, i) => sum + doc.widthOfString(toEncodableText(item)) + padX * 2
        + (i ? doc.widthOfString(SEP) : 0),
      0,
    );
  };

  while (measure(shown, size) > width && size > 7.5) size -= 0.5;
  while (measure(shown, size) > width && shown.length > 1) {
    shown = shown.slice(0, -1);
    const more = items.length - shown.length;
    if (measure([...shown, `+${more} more`], size) <= width) {
      shown = [...shown, `+${more} more`];
      break;
    }
  }

  const y = doc.y;
  let x = MARGIN;
  shown.forEach((item, i) => {
    if (i) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor('#D9C9B4')
        .text(SEP, x, y + 5, { lineBreak: false });
      x += doc.widthOfString(SEP);
    }
    doc.font('Helvetica-Bold').fontSize(size);
    const w = doc.widthOfString(toEncodableText(item)) + padX * 2;
    doc.save().roundedRect(x, y, w, boxHeight, 4).fill('#FDECEC').restore();
    doc.font('Helvetica-Bold').fontSize(size).fillColor('#D62828')
      .text(toEncodableText(item), x + padX, y + 5.5, { lineBreak: false });
    x += w;
  });

  doc.x = MARGIN;
  doc.y = y + boxHeight + 5;
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
    // Case number and access code are gone by request. They are the patient's
    // handle on their own case, not something the receiving ward acts on.
    .text(`Generated ${formatDateTime()}`, textX, 50, {
      width: doc.page.width - textX - MARGIN,
    });

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
    const boxHeight = PHOTO_HEIGHT;
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

  registerFonts(doc);
  drawHeaderBand(doc, caseData, reportData, color);

  // 1. THE FACTS — who, where, when, and who is bringing them.
  sectionHeading(doc, 'Case details');
  // Trimmed to what the receiving ward acts on. Reached on, Reported by,
  // Channel, SOS at and Coordinates were dropped by request: the crew already
  // has the phone and the pin, and the ward reads the address.
  drawTable(doc, [
    ['Patient', caseData.patient_name || caseData.reporter_name || 'Not given'],
    ['Age', medicalProfile?.age ? `${medicalProfile.age} years` : 'Not on file'],
    ['Gender', titleCase(medicalProfile?.gender) || 'Not on file'],
    ['Blood group', medicalProfile?.blood_group || 'Not on file'],
    ['Report at', formatDateTime()],
    ['Ambulance', caseData.driver_name
      ? `${caseData.driver_name}${caseData.vehicle_number ? ` (${caseData.vehicle_number})` : ''}`
      : 'Not yet assigned'],
    ['Pickup', caseData.patient_address || 'Address not available', { span: true }],
    ['Destination', caseData.hospital_name || 'Not yet chosen', { span: true }],
  ]);

  // 2. THE PHOTO — the only part of this report no model wrote.
  if (photoBuffer) {
    sectionHeading(doc, 'Photo from the scene');
    drawPhoto(doc, photoBuffer);
  }

  // 3. WHAT HAPPENED — in the caller's own words, in the script they used.
  //    The old appendix repeated this same text on a page of its own, because
  //    this section could only render "?". With a font it can, so the
  //    duplicate page is gone.
  sectionHeading(doc, 'What the caller described');
  const spoken = String(reportData.transcribed_text || reportData.input_text || '').trim();
  if (spoken) {
    scriptText(doc, spoken, MARGIN, doc.y, {
      width: contentWidth(doc),
      height: 44,
      ellipsis: true,
      lineGap: 1,
    }, 10);
  } else {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(TEXT_GRAY)
      .text('Nothing was said or typed — this report is based on the photo alone.', MARGIN, doc.y);
  }
  doc.x = MARGIN;
  divider(doc);

  // 4. THE ASSESSMENT — consciousness and observations in one ruled table.
  sectionHeading(doc, 'Symptoms and observations');
  const observations = (Array.isArray(reportData.key_observations)
    ? reportData.key_observations : [])
    .filter((o) => o != null && String(o).trim() !== '')
    .slice(0, MAX_OBSERVATIONS);
  drawObservationTable(
    doc,
    titleCase(reportData.consciousness_state) || 'Unknown',
    observations.length ? observations : ['No specific observations recorded.'],
  );
  doc.moveDown(0.5);

  const conditions = (Array.isArray(reportData.possible_conditions)
    ? reportData.possible_conditions : []).filter(Boolean).slice(0, MAX_CONDITIONS);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEXT_GRAY)
    .text('POSSIBLE CONDITIONS', MARGIN, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9.5).fillColor(TEXT_DARK)
    .text(
      toEncodableText(conditions.length ? conditions.join('   ·   ') : 'No conditions suggested.'),
      MARGIN, doc.y, { width: contentWidth(doc), height: 21, ellipsis: true },
    );
  doc.moveDown(0.2);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(TEXT_GRAY)
    .text('AI assessment from the caller\'s description — clinical judgment required.', MARGIN, doc.y);
  divider(doc);

  // 5. THE ASK — what this hospital should have waiting. The whole point of
  //    sending the report ahead of the ambulance.
  const resources = Array.isArray(reportData.resources_needed)
    ? reportData.resources_needed.filter(Boolean)
    : [];
  sectionHeading(doc, 'Have ready on arrival');
  if (resources.length) {
    drawResourceLine(doc, resources);
  } else {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(TEXT_GRAY)
      .text('No specific resources identified.', MARGIN, doc.y);
    doc.moveDown(0.3);
  }
  doc.font('Helvetica').fontSize(9.5).fillColor(TEXT_DARK)
    .text(
      toEncodableText(reportData.hospital_preparation || 'No further preparation notes.'),
      MARGIN, doc.y, { width: contentWidth(doc), height: 21, ellipsis: true },
    );
  divider(doc);

  // 6. FIRST AID — what was done, or should be, before arrival.
  sectionHeading(doc, 'First aid given or advised');
  doc.font('Helvetica').fontSize(9.5).fillColor(TEXT_DARK)
    .text(
      toEncodableText(reportData.first_aid_suggestion || 'No first aid guidance recorded.'),
      MARGIN, doc.y, { width: contentWidth(doc), height: 21, ellipsis: true },
    );
  divider(doc);

  // 7. HISTORY — what we already knew about this patient.
  sectionHeading(doc, 'Known medical history');
  const meds = Array.isArray(reportData.medications_mentioned)
    ? reportData.medications_mentioned.filter(Boolean)
    : [];
  drawTable(doc, [
    ['Conditions', listOrDash(medicalProfile?.chronic_conditions)],
    ['Allergies', listOrDash(medicalProfile?.allergies)],
    ['Medicines', listOrDash(meds, 'None mentioned')],
    ['Profile', medicalProfile ? 'From the patient\'s account' : 'No account on file'],
  ]);

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
