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
const CRITICAL = '#D62828';
const TEXT_SOFT = '#57534E';
const TEXT_GRAY = '#78716C';
const RULE = '#E5D9C9';
const TABLE_FILL = '#F7F0E6';
const BRAND_INK = '#C2410C';

const MARGIN = 46;
const HEADER_HEIGHT = 78;

// --- The page budget --------------------------------------------------------
//
// One page when the report fits on one, never more than two.
//
// Squeezing everything onto a single page meant clamping the clinical free
// text to about two lines each and cutting the rest with an ellipsis, so a
// long first-aid instruction ended mid-sentence and the ward could not tell
// anything was missing. Silently truncated clinical text is worse than a
// second sheet, so the clamps below are generous now — they exist to bound the
// worst case at two pages, not to force one.
//
// The photo stays modest because it sits above everything a doctor reads, and
// pushing the assessment onto page two to make room for a bigger picture is
// the wrong trade.
//
// pdfkit starts a new page by itself the moment text passes the bottom margin,
// silently and only for the data that happens to be long, so
// evaluation/pdf-one-page.mjs renders both a realistic report and a
// deliberately absurd one: the first must be one page, the second at most two.
const PHOTO_MAX_HEIGHT = 118;
const MAX_OBSERVATIONS = 10;
const MAX_CONDITIONS = 8;

// Heights that clinical free text may occupy before it is cut. Roughly four
// lines each — past that a model is padding, not reporting.
const CALLER_TEXT_HEIGHT = 96;
const CLINICAL_TEXT_HEIGHT = 48;

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
/**
 * Lay an Arabic-script paragraph out right-to-left.
 *
 * fontkit shapes each word correctly — the letters join and take their
 * initial, medial and final forms — but pdfkit then places the words across
 * the line left to right, so the sentence came out back to front: the last
 * word sat where the first one should be. align:'right' only moved the block
 * to the right margin; it did not reverse it. Measured rather than eyeballed:
 * the rightmost word on the line was the end of the sentence.
 *
 * So the wrapping is done here, in logical order, and each finished line is
 * reversed before it is drawn. pdfkit then lays the reversed line out left to
 * right, which puts the first word at the right margin — where an Urdu reader
 * starts.
 *
 * @returns {number} the height used, so the caller can advance past it.
 */
function drawRtlParagraph(doc, text, x, y, { width, maxHeight, size, color, lineGap = 1.5 }) {
  doc.font(URDU_FONT).fontSize(size).fillColor(color);

  const lineHeight = doc.currentLineHeight() + lineGap;
  const words = String(text).trim().split(/\s+/).filter(Boolean);

  const lines = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (current.length && doc.widthOfString(candidate) > width) {
      lines.push(current);
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length) lines.push(current);

  const maxLines = maxHeight ? Math.max(Math.floor(maxHeight / lineHeight), 1) : lines.length;
  const shown = lines.slice(0, maxLines);
  const truncated = lines.length > shown.length;

  shown.forEach((line, index) => {
    // The ellipsis belongs at the end of the sentence, which in a
    // right-to-left line is the left edge — so it goes first once reversed.
    const words = line.slice().reverse();
    if (truncated && index === shown.length - 1) words.unshift('…');
    doc.text(words.join(' '), x, y + index * lineHeight, {
      width,
      align: 'right',
      lineBreak: false,
    });
  });

  return shown.length * lineHeight;
}

/**
 * Text in whichever script it happens to be written in.
 *
 * Leaves doc.y just below what it drew, in both branches — pdfkit does that
 * for itself on the Latin path, and drawRtlParagraph places lines absolutely,
 * so it has to be done by hand there.
 */
function scriptText(doc, value, x, y, options = {}, size = 10.5, color = TEXT_DARK) {
  const raw = String(value ?? '');

  if (isArabicScript(raw) && urduFontPath) {
    const used = drawRtlParagraph(doc, raw.normalize('NFC'), x, y, {
      width: options.width,
      maxHeight: options.height,
      size: size + 0.5,
      color,
    });
    doc.y = y + used;
    return;
  }

  doc
    .font('Helvetica')
    .fontSize(size)
    .fillColor(color)
    .text(toEncodableText(raw), x, y, { ...options, align: options.align || 'left' });
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
  // PDF_TRACE=1 prints where each section lands, for retuning the budget.
  if (process.env.PDF_TRACE) console.log(`  y=${doc.y.toFixed(0)}  ${label}`);
  // A heading alone at the foot of page one, with its content overleaf, is
  // the worst way to spend the second page.
  if (doc.y > doc.page.height - 120) doc.addPage();
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
 * The clarification questions and the answers given from the scene.
 *
 * Drawn as question-then-answer pairs rather than a table, because the question
 * is the context an answer is meaningless without: "Yes" on its own tells a
 * reader nothing. Unanswered questions are printed too, greyed, so the record
 * is honest about what was asked and not settled rather than quietly omitting
 * it — a doctor who can see that nobody could say whether the chest was moving
 * knows something a silent report does not tell them.
 *
 * Draws nothing at all when no questions were put, so reports from the
 * WhatsApp channel and from before this feature existed are unchanged.
 */
function drawClarifications(doc, clarifications) {
  const questions = (Array.isArray(clarifications) ? clarifications : []).filter(
    (c) => c && c.question,
  );
  if (questions.length === 0) return;

  divider(doc);
  sectionHeading(doc, 'Answers from the scene');

  const width = contentWidth(doc);
  for (const q of questions) {
    if (doc.y > doc.page.height - 90) doc.addPage();

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(TEXT_GRAY)
      .text(toEncodableText(q.question), MARGIN, doc.y, {
        width,
        height: 24,
        ellipsis: true,
      });

    const answered = q.answer != null && q.answer !== '';
    doc
      .font(answered ? 'Helvetica-Bold' : 'Helvetica-Oblique')
      .fontSize(10)
      .fillColor(answered ? TEXT_DARK : TEXT_GRAY)
      .text(
        toEncodableText(answered ? q.answer : 'Not answered'),
        MARGIN + 12,
        doc.y + 1,
        { width: width - 12, height: 20, ellipsis: true },
      );
    doc.moveDown(0.4);
    doc.x = MARGIN;
  }

  doc
    .font('Helvetica-Oblique')
    .fontSize(8)
    .fillColor(TEXT_GRAY)
    .text(
      'Asked before this report was written. The answers are observations from '
        + 'the scene and the report above reflects them.',
      MARGIN,
      doc.y,
      { width },
    );
  doc.x = MARGIN;
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
    // Rows are drawn as absolute rectangles, so pdfkit's own pagination does
    // not see them coming; the break has to be asked for.
    if (doc.y + rowHeight > doc.page.height - MARGIN) doc.addPage();
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
    if (doc.y + rowHeight > doc.page.height - MARGIN) doc.addPage();
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
function drawResourceLine(doc, items, opts = {}) {
  const originX = opts.x ?? MARGIN;
  const width = opts.width ?? contentWidth(doc);
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
  let x = originX;
  shown.forEach((item, i) => {
    if (i) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor('#D9C9B4')
        .text(SEP, x, y + 5, { lineBreak: false });
      x += doc.widthOfString(SEP);
    }
    doc.font('Helvetica-Bold').fontSize(size);
    const w = doc.widthOfString(toEncodableText(item)) + padX * 2;
    doc.save().roundedRect(x, y, w, boxHeight, 4)
      .fill(opts.onTint ? '#FFFFFF' : '#FDECEC').restore();
    doc.font('Helvetica-Bold').fontSize(size).fillColor(CRITICAL)
      .text(toEncodableText(item), x + padX, y + 5.5, { lineBreak: false });
    x += w;
  });

  doc.x = originX;
  doc.y = y + boxHeight + 5;
}


// --- The rebuilt layout -----------------------------------------------------

/**
 * One line of facts, with the blanks left out.
 *
 * The old table printed "Not on file" in a row of its own for every field
 * nobody had filled in — five of them on a walk-in case, five lines of nothing
 * sitting above the clinical detail. What is unknown is simply not said.
 */
function drawFactLine(doc, facts, { x = MARGIN, gap = 14 } = {}) {
  const shown = facts.filter((f) => f && f.value != null && String(f.value).trim() !== '');
  if (!shown.length) return;

  const y = doc.y;
  let cursor = x;
  shown.forEach((fact, index) => {
    if (index) {
      doc.font('Helvetica').fontSize(12).fillColor('#CFC4B2')
        .text('|', cursor, y - 1, { lineBreak: false });
      cursor += doc.widthOfString('|') + gap / 2;
    }
    doc.font('Helvetica').fontSize(8).fillColor(TEXT_GRAY)
      .text(fact.label.toUpperCase(), cursor, y, { lineBreak: false, characterSpacing: 0.4 });
    const labelWidth = doc.widthOfString(fact.label.toUpperCase()) + 5;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(TEXT_DARK)
      .text(toEncodableText(fact.value), cursor + labelWidth, y - 2.5, { lineBreak: false });
    cursor += labelWidth + doc.widthOfString(toEncodableText(fact.value)) + gap / 2;
  });

  doc.x = MARGIN;
  doc.y = y + 16;
}

/**
 * The band that answers "how bad, and when" before anything else is read.
 */
function drawUrgencyBand(doc, reportData, caseData, color) {
  const width = contentWidth(doc);
  const height = 46;
  const y = doc.y;

  doc.save().roundedRect(MARGIN, y, width, height, 8).fill(color).restore();

  const level = String(reportData?.urgency_level || 'unknown').toUpperCase();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF')
    .text(level, MARGIN + 14, y + 9, { characterSpacing: 1, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF')
    .text(titleCase(reportData?.emergency_type) || 'Type not determined',
      MARGIN + 14, y + 21, { width: width - 180, lineBreak: false });

  // Arrival, right-aligned — the fact a ward plans around.
  const eta = Number(caseData?.eta_minutes);
  const label = Number.isFinite(eta) ? `~${eta} min` : 'En route';
  const sub = Number.isFinite(eta) ? 'to arrival' : 'arrival time unknown';
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#FFFFFF')
    .text(label, MARGIN + width - 160, y + 8, { width: 146, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor('#FFFFFF')
    .text(sub, MARGIN + width - 160, y + 30, { width: 146, align: 'right', lineBreak: false });

  doc.x = MARGIN;
  doc.y = y + height + 14;
}

/** The ask, as the second thing on the page rather than the seventh. */
function drawPrepareBlock(doc, resources, note) {
  const width = contentWidth(doc);
  const hasList = resources.length > 0;
  const y = doc.y;

  // Measure the note first so the panel can be drawn behind it in one go.
  doc.font('Helvetica').fontSize(9.5);
  const noteText = note ? toEncodableText(note) : '';
  const noteHeight = noteText
    ? Math.min(doc.heightOfString(noteText, { width: width - 28 }), 30)
    : 0;
  const height = 30 + (hasList ? 24 : 0) + (noteHeight ? noteHeight + 6 : 0);

  doc.save()
    .roundedRect(MARGIN, y, width, height, 8)
    .fillAndStroke('#FDECEC', '#F3C9C9')
    .restore();

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(CRITICAL)
    .text('HAVE READY ON ARRIVAL', MARGIN + 14, y + 10, { characterSpacing: 0.8 });

  if (hasList) {
    doc.y = y + 26;
    doc.x = MARGIN + 14;
    drawResourceLine(doc, resources, { x: MARGIN + 14, width: width - 28, onTint: true });
  } else {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(TEXT_GRAY)
      .text('Nothing specific requested.', MARGIN + 14, y + 25);
  }

  if (noteText) {
    doc.font('Helvetica').fontSize(9.5).fillColor(TEXT_DARK)
      .text(noteText, MARGIN + 14, y + height - noteHeight - 8,
        { width: width - 28, height: noteHeight, ellipsis: true });
  }

  doc.x = MARGIN;
  doc.y = y + height + 14;
}

// Brand band across the top of page 1, coloured by urgency.
function drawHeaderBand(doc, caseData, reportData, color) {
  doc.save().rect(0, 0, doc.page.width, HEADER_HEIGHT).fill(color).restore();

  let textX = MARGIN;
  if (logoBuffer) {
    // White plate behind the mark so the logo reads on any urgency colour.
    doc.save().roundedRect(MARGIN, 16, 46, 46, 10).fill('#FFFFFF').restore();
    try {
      doc.image(logoBuffer, MARGIN + 6, 22, { fit: [34, 34] });
    } catch {
      /* unreadable logo — the band still works without it */
    }
    textX = MARGIN + 62;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(19)
    .fillColor('#FFFFFF')
    .text('ResQPK Emergency Report', textX, 22, { width: doc.page.width - textX - MARGIN });

  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor('#FFFFFF')
    // Case number and access code are gone by request. They are the patient's
    // handle on their own case, not something the receiving ward acts on.
    .text(`Generated ${formatDateTime()}`, textX, 46, {
      width: doc.page.width - textX - MARGIN,
    });

  // The urgency and the emergency type used to be repeated here. They are the
  // first thing in the band below, at a size worth reading, with the arrival
  // time beside them — saying it twice only made the header louder.
  doc.fillColor(TEXT_DARK);
  doc.x = MARGIN;
  doc.y = HEADER_HEIGHT + 16;
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

  const boxWidth = contentWidth(doc);
  let drawWidth = boxWidth;
  let drawHeight = PHOTO_MAX_HEIGHT;

  try {
    // Size the frame to the picture rather than the picture to the frame. A
    // fixed box letterboxed a phone photo between two black bars half the
    // width of the page, which looked like a broken image.
    const image = doc.openImage(photoBuffer);
    const scale = Math.min(boxWidth / image.width, PHOTO_MAX_HEIGHT / image.height);
    drawWidth = image.width * scale;
    drawHeight = image.height * scale;
  } catch {
    // Unreadable header — fall through and let doc.image report properly.
  }

  const x = MARGIN + (boxWidth - drawWidth) / 2;
  const y = doc.y;

  try {
    doc.save()
      .roundedRect(x, y, drawWidth, drawHeight, 6)
      .clip()
      .image(photoBuffer, x, y, { width: drawWidth, height: drawHeight })
      .restore();
    doc.save().roundedRect(x, y, drawWidth, drawHeight, 6)
      .lineWidth(0.5).strokeColor(RULE).stroke().restore();

    doc.y = y + drawHeight + 5;
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
    // HEIC, WebP and anything else pdfkit cannot decode. Say so rather than
    // leaving a gap: a ward that knows a photo exists can ask the crew for it,
    // and silence looked like no photo was ever taken.
    doc.save()
      .roundedRect(MARGIN, y, boxWidth, 34, 6)
      .fillAndStroke(TABLE_FILL, RULE)
      .restore();
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(TEXT_SOFT)
      .text('A photo was sent but could not be displayed here — ask the crew to show it.',
        MARGIN + 10, y + 12, { width: boxWidth - 20 });
    doc.y = y + 40;
    doc.x = MARGIN;
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

  // The order is the order a receiving ward reads in: how bad and how long,
  // what to have ready, who is coming, then the clinical detail. It used to
  // open with a table of administrative facts and bury the ask two thirds of
  // the way down.

  // 1. HOW BAD, AND WHEN.
  drawUrgencyBand(doc, reportData, caseData, color);

  // 2. THE ASK — the reason this is sent ahead of the ambulance.
  const resources = Array.isArray(reportData.resources_needed)
    ? reportData.resources_needed.filter(Boolean)
    : [];
  drawPrepareBlock(doc, resources, reportData.hospital_preparation);

  // 3. WHO. One line, blanks omitted.
  sectionHeading(doc, 'Patient');
  drawFactLine(doc, [
    { label: 'Name', value: caseData.patient_name || caseData.reporter_name },
    { label: 'Age', value: medicalProfile?.age ? `${medicalProfile.age}` : null },
    { label: 'Sex', value: titleCase(medicalProfile?.gender) || null },
    { label: 'Blood', value: medicalProfile?.blood_group || null },
  ]);
  const history = [
    listOrDash(medicalProfile?.chronic_conditions, '') && `Conditions: ${listOrDash(medicalProfile.chronic_conditions, '')}`,
    listOrDash(medicalProfile?.allergies, '') && `Allergies: ${listOrDash(medicalProfile.allergies, '')}`,
    (Array.isArray(reportData.medications_mentioned) && reportData.medications_mentioned.filter(Boolean).length)
      ? `Medicines: ${reportData.medications_mentioned.filter(Boolean).join(', ')}` : '',
  ].filter(Boolean).join('    ·    ');
  if (history) {
    doc.font('Helvetica').fontSize(9).fillColor(TEXT_SOFT)
      .text(toEncodableText(history), MARGIN, doc.y, { width: contentWidth(doc), height: 24, ellipsis: true });
  } else {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(TEXT_GRAY)
      .text('No medical history on file.', MARGIN, doc.y);
  }
  divider(doc);

  // 4. THE SCENE — the photo, then the caller's own words under it.
  if (photoBuffer) {
    sectionHeading(doc, 'Photo from the scene');
    drawPhoto(doc, photoBuffer);
  }

  sectionHeading(doc, 'What the caller described');
  const spoken = String(reportData.transcribed_text || reportData.input_text || '').trim();
  if (spoken) {
    scriptText(doc, spoken, MARGIN, doc.y, {
      width: contentWidth(doc),
      height: CALLER_TEXT_HEIGHT,
      ellipsis: true,
      lineGap: 1,
    }, 10);
  } else {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(TEXT_GRAY)
      .text('Nothing was said or typed.', MARGIN, doc.y);
  }
  doc.x = MARGIN;

  // 4b. WHAT WE ASKED, AND WHAT THEY SAID.
  //
  // These answers were given before this report was written and are part of
  // what it was written from, so a clinician checking the source needs them
  // next to the description — same reason the transcription is printed above.
  // The distinction matters: the description is what someone volunteered, these
  // are answers to specific questions, and a tap on "Not responding at all" is
  // firmer evidence than a sentence that never mentioned consciousness.
  drawClarifications(doc, reportData.clarifications);

  divider(doc);

  // 5. THE ASSESSMENT.
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
      MARGIN, doc.y, { width: contentWidth(doc), height: 24, ellipsis: true },
    );
  doc.moveDown(0.2);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(TEXT_GRAY)
    .text("AI assessment from the caller's description — clinical judgment required.", MARGIN, doc.y);
  divider(doc);

  // 6. FIRST AID.
  sectionHeading(doc, 'First aid given or advised');
  doc.font('Helvetica').fontSize(9.5).fillColor(TEXT_DARK)
    .text(
      toEncodableText(reportData.first_aid_suggestion || 'No first aid guidance recorded.'),
      MARGIN, doc.y, { width: contentWidth(doc), height: CLINICAL_TEXT_HEIGHT, ellipsis: true },
    );
  divider(doc);

  // 7. LOGISTICS — small, last, out of the way of the clinical reading.
  sectionHeading(doc, 'Transport');
  drawFactLine(doc, [
    {
      label: 'Ambulance',
      value: caseData.driver_name
        ? `${caseData.driver_name}${caseData.vehicle_number ? ` (${caseData.vehicle_number})` : ''}`
        : 'Not yet assigned',
    },
    { label: 'To', value: caseData.hospital_name || 'Not yet chosen' },
  ]);
  if (caseData.patient_address) {
    doc.font('Helvetica').fontSize(9).fillColor(TEXT_SOFT)
      .text(`Pickup: ${toEncodableText(caseData.patient_address)}`, MARGIN, doc.y,
        { width: contentWidth(doc), height: 22, ellipsis: true });
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
