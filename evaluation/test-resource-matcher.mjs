// Offline unit tests for the deterministic resource matcher (Instruction 2.5).
// Uses the real resolveCanonicalKey/buildChecks with a keyword map mirroring
// the Phase 1 seed, so no database is required.
import { resolveCanonicalKey, buildChecks } from '../src/services/resource.service.js';

// Mirrors public.resource_keywords from Phase 1, sorted longest-first exactly
// as loadKeywordMap() does.
const KEYWORD_MAP = [
  ['ecg', 'ecg'], ['ecg machine', 'ecg'], ['electrocardiogram', 'ecg'],
  ['cardiac monitor', 'ecg'], ['heart monitor', 'ecg'],
  ['ventilator', 'ventilator'], ['mechanical ventilation', 'ventilator'],
  ['breathing support', 'ventilator'],
  ['x-ray', 'xray'], ['xray', 'xray'], ['radiograph', 'xray'],
  ['ct scan', 'ct_scan'], ['ct', 'ct_scan'], ['computed tomography', 'ct_scan'],
  ['defibrillator', 'defibrillator'], ['aed', 'defibrillator'],
  ['dialysis', 'dialysis'],
  ['oxygen', 'oxygen'], ['oxygen supply', 'oxygen'], ['o2', 'oxygen'],
  ['blood bank', 'blood_bank'], ['blood transfusion', 'blood_bank'], ['blood', 'blood_bank'],
  ['cardiologist', 'cardiologist'], ['cardiology', 'cardiologist'],
  ['heart specialist', 'cardiologist'], ['cath lab', 'cardiologist'],
  ['neurologist', 'neurologist'], ['neurology', 'neurologist'],
  ['stroke specialist', 'neurologist'],
  ['surgeon', 'surgeon'], ['surgery', 'surgeon'], ['surgical team', 'surgeon'],
  ['orthopedic', 'orthopedic'], ['orthopedic surgeon', 'orthopedic'],
  ['bone specialist', 'orthopedic'], ['fracture management', 'orthopedic'],
  ['gynecologist', 'gynecologist'], ['obstetrician', 'gynecologist'],
  ['pediatrician', 'pediatrician'], ['child specialist', 'pediatrician'],
  ['icu', 'icu'], ['icu bed', 'icu'], ['intensive care', 'icu'], ['critical care', 'icu'],
  ['operation theater', 'operation_theater'], ['operating room', 'operation_theater'],
  ['ot', 'operation_theater'],
  ['emergency ward', 'emergency_ward'], ['emergency room', 'emergency_ward'], ['er', 'emergency_ward'],
  ['trauma center', 'trauma_center'], ['trauma care', 'trauma_center'],
  ['general physician', 'general_physician'], ['doctor', 'general_physician'],
]
  .map(([keyword, canonicalKey]) => ({ keyword, canonicalKey }))
  .sort((a, b) => b.keyword.length - a.keyword.length);

// A hospital with the Phase 1 seed, then adjusted per-test.
function hospitalResources(overrides = {}) {
  const base = {
    ecg: { resource_name: 'ECG Machine', status: 'available', quantity: 2 },
    ventilator: { resource_name: 'Ventilator', status: 'available', quantity: 2 },
    xray: { resource_name: 'X-Ray', status: 'available', quantity: 1 },
    ct_scan: { resource_name: 'CT Scan', status: 'available', quantity: 1 },
    defibrillator: { resource_name: 'Defibrillator', status: 'available', quantity: 2 },
    dialysis: { resource_name: 'Dialysis Machine', status: 'available', quantity: 1 },
    oxygen: { resource_name: 'Oxygen Supply', status: 'available', quantity: 10 },
    blood_bank: { resource_name: 'Blood Bank', status: 'available', quantity: 1 },
    cardiologist: { resource_name: 'Cardiologist', status: 'available', quantity: 1 },
    icu: { resource_name: 'ICU', status: 'available', quantity: 1 },
    emergency_ward: { resource_name: 'Emergency Ward', status: 'available', quantity: 1 },
  };
  const merged = { ...base, ...overrides };
  return Object.entries(merged)
    .filter(([, v]) => v !== null)
    .map(([canonical_key, v]) => ({ canonical_key, ...v }));
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// --- resolveCanonicalKey ----------------------------------------------------
check('exact match', resolveCanonicalKey('ECG', KEYWORD_MAP) === 'ecg');
check('case/whitespace insensitive', resolveCanonicalKey('  IcU  ', KEYWORD_MAP) === 'icu');
check('multi-word exact', resolveCanonicalKey('CT Scan', KEYWORD_MAP) === 'ct_scan');
check('synonym maps correctly', resolveCanonicalKey('cardiac monitor', KEYWORD_MAP) === 'ecg');
check('cath lab maps to cardiologist', resolveCanonicalKey('cath lab', KEYWORD_MAP) === 'cardiologist');
check('substring fallback', resolveCanonicalKey('Dialysis Machine', KEYWORD_MAP) === 'dialysis');
check('longest keyword wins',
  resolveCanonicalKey('Orthopedic Surgeon', KEYWORD_MAP) === 'orthopedic',
  'must not resolve to surgeon');
check('unknown phrase → null', resolveCanonicalKey('Hyperbaric Chamber', KEYWORD_MAP) === null);
check('empty → null', resolveCanonicalKey('', KEYWORD_MAP) === null);
check('null → null', resolveCanonicalKey(null, KEYWORD_MAP) === null);

// --- buildChecks ------------------------------------------------------------
const allOk = buildChecks(['ECG', 'ICU', 'Oxygen'], hospitalResources(), KEYWORD_MAP);
check('all available → overallOk', allOk.overallOk === true && allOk.missingCount === 0);
check('ok check carries resource name + qty',
  allOk.checks[0].status === 'ok' && allOk.checks[0].resource === 'ECG Machine' && allOk.checks[0].quantity === 2);
check('summary when all ok', allOk.summary === 'All required resources available');

const unavailable = buildChecks(
  ['ECG', 'Cardiologist'],
  hospitalResources({ cardiologist: { resource_name: 'Cardiologist', status: 'unavailable', quantity: 0 } }),
  KEYWORD_MAP,
);
check('unavailable → missing', unavailable.checks[1].status === 'missing');
check('unavailable note', unavailable.checks[1].note === 'Currently unavailable/down');
check('overallOk false when missing', unavailable.overallOk === false && unavailable.missingCount === 1);
check('summary counts missing',
  unavailable.summary === '1 required resource(s) unavailable — consider redirect');

const limited = buildChecks(
  ['Dialysis'],
  hospitalResources({ dialysis: { resource_name: 'Dialysis Machine', status: 'limited', quantity: 1 } }),
  KEYWORD_MAP,
);
check('limited → limited status', limited.checks[0].status === 'limited');
check('limited does NOT block overallOk', limited.overallOk === true, 'limited is a warning, not a blocker');

const absent = buildChecks(['CT Scan'], hospitalResources({ ct_scan: null }), KEYWORD_MAP);
check('resource absent from hospital → missing', absent.checks[0].status === 'missing');
check('absent note', absent.checks[0].note === 'Hospital does not have this resource');

const unknown = buildChecks(['Hyperbaric Chamber'], hospitalResources(), KEYWORD_MAP);
check('unrecognised phrase → unknown', unknown.checks[0].status === 'unknown');
check('unknown note asks for manual check',
  unknown.checks[0].note === 'Not in hospital resource list — verify manually');
check('unknown does NOT block overallOk', unknown.overallOk === true);

const mixed = buildChecks(
  ['ECG', 'Cardiologist', 'CT Scan', 'Hyperbaric Chamber'],
  hospitalResources({
    cardiologist: { resource_name: 'Cardiologist', status: 'unavailable', quantity: 0 },
    ct_scan: null,
  }),
  KEYWORD_MAP,
);
check('mixed case counts both missing kinds', mixed.missingCount === 2 && mixed.overallOk === false);
check('mixed summary', mixed.summary === '2 required resource(s) unavailable — consider redirect');
check('check count matches input', mixed.checks.length === 4);

// The realistic cardiac scenario from the plan's test-case list.
const cardiac = buildChecks(
  ['ECG', 'Defibrillator', 'Cardiologist', 'ICU', 'Oxygen'],
  hospitalResources({ cardiologist: { resource_name: 'Cardiologist', status: 'unavailable', quantity: 0 } }),
  KEYWORD_MAP,
);
check('cardiac scenario flags only the cardiologist',
  cardiac.missingCount === 1 && cardiac.checks.find((c) => c.status === 'missing').resource === 'Cardiologist');

console.log(failures === 0 ? '\nAll resource matcher checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
