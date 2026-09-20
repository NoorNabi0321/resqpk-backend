// Dev helper: extract the visible text from a generated report PDF so the
// section structure can be verified without a PDF viewer.
import fs from 'fs';
import zlib from 'zlib';

const file = process.argv[2] || 'evaluation/sample-report.pdf';
const buf = fs.readFileSync(file);

let raw = '';
const marker = Buffer.from('stream');
let i = 0;
while ((i = buf.indexOf(marker, i)) !== -1) {
  let s = i + marker.length;
  if (buf[s] === 13) s += 1;
  if (buf[s] === 10) s += 1;
  const e = buf.indexOf(Buffer.from('endstream'), s);
  if (e === -1) break;
  const slice = buf.subarray(s, e);
  try {
    // Z_SYNC_FLUSH tolerates the newline PDFKit writes before 'endstream'.
    raw += `${zlib
      .inflateSync(slice, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      .toString('latin1')}\n`;
  } catch {
    raw += `${slice.toString('latin1')}\n`;
  }
  // Advance past 'endstream' — landing on it would re-match its own 'stream'.
  i = e + 9;
}

// PDFKit emits kerned text as hex strings inside TJ arrays, e.g.
//   [<555247454e4359> 50 <3a> 40 <20435249544943414c> 0] TJ
// so decode every <hex> run. Parenthesised literals are handled too, for
// completeness, since PDFKit uses them when kerning is disabled.
function decodeHex(hex) {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

const hexShown = [...raw.matchAll(/<([0-9a-fA-F\s]+)>/g)]
  .map((m) => decodeHex(m[1].replace(/\s+/g, '')))
  .join('');

const literalShown = [...raw.matchAll(/\((?:\\.|[^()\\])*\)/g)]
  .map((m) => m[0].slice(1, -1).replace(/\\([()\\])/g, '$1'))
  .join(' ');

const shown = `${hexShown} ${literalShown}`;

if (process.env.DEBUG_PDF) {
  console.log('[debug] inflated chars:', raw.length);
  console.log('[debug] open parens   :', (raw.match(/\(/g) || []).length);
  console.log('[debug] extracted len :', shown.length);
  console.log('[debug] extracted head:', JSON.stringify(shown.slice(0, 300)));
  console.log('[debug] raw sample    :', JSON.stringify(raw.slice(500, 900)));
}

// The sections a receiving doctor reads, in the order the report answers them.
// Run against the sample the README describes; a MISS means the layout dropped
// something staff rely on.
const expected = [
  'ResQPK Emergency Report',
  'Case RQ-',
  'Code RQ-',
  'CRITICAL',
  'CASE DETAILS',
  'PATIENT',
  'BLOOD GROUP',
  'REACHED ON',
  'PICKUP',
  'AMBULANCE',
  'DESTINATION',
  'PHOTO FROM THE SCENE',
  'WHAT THE CALLER DESCRIBED',
  'SYMPTOMS AND OBSERVATIONS',
  'Consciousness',
  'POSSIBLE CONDITIONS',
  'clinical judgment required',
  'HAVE READY ON ARRIVAL',
  'FIRST AID GIVEN OR ADVISED',
  'KNOWN MEDICAL HISTORY',
  'ALLERGIES',
  'MEDICINES',
  'ORIGINAL INPUT',
  'does not replace it',
  'Page 1 of',
];

const upper = shown.toUpperCase();
let missing = 0;
for (const want of expected) {
  const ok = upper.includes(want.toUpperCase());
  if (!ok) missing += 1;
  console.log(`${ok ? 'ok   ' : 'MISS '}${want}`);
}
console.log(`\nmissing: ${missing}`);

const idx = shown.indexOf('Please send an ambulance');
if (idx !== -1) {
  console.log('\n--- how the Urdu transcription rendered ---');
  console.log(shown.slice(Math.max(0, idx - 140), idx + 70));
}
process.exit(missing === 0 ? 0 : 1);
