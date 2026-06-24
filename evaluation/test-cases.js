// Module 6 E1 — AI evaluation test cases (FYP academic deliverable).
// 15 cases across English / Urdu / Roman-Urdu / mixed + edge cases.
export const TEST_CASES = [
  // --- English ---
  {
    id: 'EN-001',
    language: 'en',
    input: {
      text: '55 year old male, severe chest pain radiating to left arm, sweating profusely, history of hypertension',
    },
    expectedOutput: {
      urgency_level: 'critical',
      emergency_type_should_contain: 'Cardiac',
      consciousness_state: 'conscious',
      key_observations_should_contain: ['chest pain', 'left arm', 'sweating'],
    },
  },
  {
    id: 'EN-002',
    language: 'en',
    input: { text: 'Child fell from bicycle, crying, small cut on knee, alert and talking' },
    expectedOutput: {
      urgency_level: 'low',
      consciousness_state: 'conscious',
    },
  },
  {
    id: 'EN-003',
    language: 'en',
    input: {
      text: 'Person found unconscious on road, not breathing, no pulse visible, road accident',
    },
    expectedOutput: {
      urgency_level: 'critical',
      consciousness_state: 'unconscious',
    },
  },
  {
    id: 'EN-004',
    language: 'en',
    input: {
      text: 'Motorcycle accident, man has a deep cut on his leg bleeding heavily, conscious but in severe pain',
    },
    expectedOutput: {
      urgency_level: 'critical',
      consciousness_state: 'conscious',
      key_observations_should_contain: ['bleeding', 'leg'],
    },
  },

  // --- Urdu ---
  {
    id: 'UR-001',
    language: 'ur',
    input: {
      text: 'مریض کو سینے میں شدید درد ہے اور وہ بے ہوش ہو رہے ہیں۔ انہیں شوگر کی بیماری ہے۔',
    },
    expectedOutput: {
      urgency_level: 'critical',
      key_observations_should_contain: ['chest pain', 'diabet'],
    },
  },
  {
    id: 'UR-002',
    language: 'ur',
    input: { text: 'بچہ گر گیا ہے، پاؤں میں چوٹ لگی ہے، رو رہا ہے لیکن ہوش میں ہے' },
    expectedOutput: {
      urgency_level: 'low',
      consciousness_state: 'conscious',
    },
  },
  {
    id: 'UR-003',
    language: 'ur',
    input: {
      text: 'بزرگ خاتون کو سانس لینے میں شدید دشواری ہو رہی ہے، ہونٹ نیلے پڑ رہے ہیں',
    },
    expectedOutput: {
      urgency_level: 'critical',
      emergency_type_should_contain: 'Respiratory',
    },
  },

  // --- Roman Urdu ---
  {
    id: 'RU-001',
    language: 'roman_ur',
    input: { text: 'Bhai ko seenay mein dard hai, haath thanda ho raha hai, aankhein band ho rahi hain' },
    expectedOutput: {
      urgency_level: 'critical',
    },
  },
  {
    id: 'RU-002',
    language: 'roman_ur',
    input: { text: 'Meri ammi ko bukhaar hai, 38 degree, paani pi rahi hain, thodi kamzori hai' },
    expectedOutput: {
      urgency_level: 'low',
      consciousness_state: 'conscious',
    },
  },
  {
    id: 'RU-003',
    language: 'roman_ur',
    input: {
      text: 'Bachay ko bohot tez bukhaar hai 104, jhatke aa rahe hain aur woh behosh hota ja raha hai',
    },
    expectedOutput: {
      urgency_level: 'critical',
    },
  },

  // --- Mixed language ---
  {
    id: 'MX-001',
    language: 'auto',
    input: {
      text: 'Patient is 40 saal ka, usse severe breathing problem hai, oxygen level girta ja raha hai, diabetic hai',
    },
    expectedOutput: {
      urgency_level: 'critical',
      emergency_type_should_contain: 'Respiratory',
    },
  },
  {
    id: 'MX-002',
    language: 'auto',
    input: {
      text: 'Mere uncle ko sudden chest pain hua, left arm mein dard, pasina aa raha hai, woh 60 saal ke hain',
    },
    expectedOutput: {
      urgency_level: 'critical',
      emergency_type_should_contain: 'Cardiac',
    },
  },

  // --- Edge cases ---
  {
    id: 'ED-001',
    language: 'en',
    input: { text: 'Someone is hurt' }, // minimal — should stay conservative
    expectedOutput: {
      urgency_level: 'unknown',
    },
  },
  {
    id: 'ED-002',
    language: 'en',
    input: { text: 'Snake bit my father, he is shaking and the bitten area is swelling' },
    expectedOutput: {
      urgency_level: 'critical',
      emergency_type_should_contain: 'Snake',
    },
  },
  {
    id: 'ED-003',
    language: 'en',
    input: { text: 'There is a problem, please come quickly' }, // vague — conservative
    expectedOutput: {
      urgency_level: 'unknown',
    },
  },
];

export default { TEST_CASES };
