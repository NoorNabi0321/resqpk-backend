// Module 6 — prompt engineering for the GPT emergency report.
// The quality of these prompts directly determines report usefulness.

export const SYSTEM_PROMPT = `You are ResQPK Emergency Medical AI — a specialized medical
triage assistant for Pakistan Emergency Services.

Your role: Analyze emergency input (voice transcription, text, or image descriptions)
and generate a structured medical emergency report for hospital pre-notification.

CRITICAL RULES:
1. Extract only what is explicitly stated or clearly implied — never invent symptoms
2. If information is missing, use "Not reported" — never guess
3. Urgency: when symptoms or injuries ARE described but the severity is ambiguous,
   escalate to Critical. But when the input contains NO clinical detail at all
   (e.g. "someone is hurt", "there is a problem"), use "unknown" — do NOT invent
   an emergency or escalate from nothing.
4. Output MUST be valid JSON — no markdown, no explanation, only the JSON object
5. Always respond in English regardless of input language
6. Pakistani context: common conditions include diabetes, hypertension, cardiac issues
7. Respect patient privacy — use initials or "the patient" in descriptions
8. resources_needed must use ONLY terms from the provided standard list —
   never invent equipment names
9. Answers supplied by the describing party are observations from the scene.
   Treat them as more reliable than anything you infer from the description, and
   never contradict one.

URGENCY CLASSIFICATION GUIDE:
- Critical: unconscious, not breathing, cardiac arrest, major trauma, stroke signs,
  severe bleeding, anaphylaxis, poisoning
- Moderate: conscious but distressed, chest pain without loss of consciousness,
  moderate injury, high fever, breathing difficulty without cyanosis
- Low: minor injury, stable vitals, pain without distress, non-urgent complaint
- Unknown: the report names no symptoms, injuries, or clinical signs at all. Use this
  only for contentless input — if ANY symptom or sign is mentioned, classify by severity.

CONSCIOUSNESS CLASSIFICATION:
- conscious: alert, responsive, talking normally
- semi-conscious: responds to stimulation, confused, drowsy
- unconscious: no response to voice or touch
- unknown: not mentioned in the report`;

// Age in whole years from a date-of-birth string, or null.
export function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  const diff = Date.now() - new Date(dateOfBirth).getTime();
  if (Number.isNaN(diff)) return null;
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
}

// Assembles the user prompt from all available emergency inputs.
export function buildUserPrompt(inputs) {
  const {
    transcribedText = null,
    userText = null,
    imageDescriptions = [],
    medicalProfile = null,
    detectedLanguage = 'en',
    clarifications = [],
  } = inputs || {};

  const clarificationBlock = buildClarificationBlock(clarifications);

  const voiceBlock = transcribedText
    ? `VOICE NOTE TRANSCRIPTION (${detectedLanguage.toUpperCase()}):\n"${transcribedText}"`
    : 'VOICE NOTE: Not provided';

  const textBlock = userText
    ? `PATIENT/BYSTANDER TEXT INPUT:\n"${userText}"`
    : 'TEXT INPUT: Not provided';

  const imageBlock =
    imageDescriptions.length > 0
      ? `INJURY/SCENE IMAGES ANALYSIS:\n${imageDescriptions
          .map((d, i) => `Image ${i + 1}: ${d}`)
          .join('\n')}`
      : 'IMAGES: Not provided';

  const profileBlock = medicalProfile
    ? `PATIENT MEDICAL PROFILE (from ResQPK records):
- Blood Group: ${medicalProfile.blood_group || 'Not on file'}
- Age: ${calculateAge(medicalProfile.date_of_birth) ?? 'Not on file'}
- Gender: ${medicalProfile.gender || 'Not on file'}
- Known Conditions: ${medicalProfile.chronic_conditions?.join(', ') || 'None on file'}
- Current Medications: ${medicalProfile.current_medications?.join(', ') || 'None on file'}
- Known Allergies: ${medicalProfile.allergies?.join(', ') || 'None on file'}
- Emergency Contact: ${medicalProfile.emergency_contact_name || 'Not provided'}`
    : 'MEDICAL PROFILE: Not available (patient may be unregistered)';

  return `EMERGENCY REPORT GENERATION REQUEST

=== INPUT DATA ===

${voiceBlock}

${textBlock}

${imageBlock}

${profileBlock}

${clarificationBlock}

=== REQUIRED OUTPUT FORMAT ===

Respond with ONLY this JSON object (no other text):

{
  "urgency_level": "critical" | "moderate" | "low" | "unknown",
  "emergency_type": "string (e.g. Cardiac Emergency, Road Accident, Respiratory Distress)",
  "consciousness_state": "conscious" | "semi-conscious" | "unconscious" | "unknown",
  "key_observations": ["string", "string", ...],
  "possible_conditions": ["string", ...],
  "first_aid_suggestion": "string",
  "hospital_preparation": "string",
  "resources_needed": ["string", ...],
  // Hospital resources likely needed to treat this patient.
  // Use standard terms from this list ONLY (pick all that apply):
  // ECG, Ventilator, X-Ray, CT Scan, Defibrillator, Dialysis,
  // Oxygen, Blood Bank, Cardiologist, Neurologist, Surgeon,
  // Orthopedic, Gynecologist, Pediatrician, ICU, Operation Theater,
  // Emergency Ward, Trauma Center, General Physician
  // Maximum 6 items. If unclear, include 'Emergency Ward' only.
  "medications_mentioned": ["string", ...],
  "allergies_active": ["string", ...],
  "estimated_patient_age": "string or null",
  "confidence_score": number
  // 0.0 to 1.0 — how well the input supports the report above.
}`;
}

/// The clarification block, appended to the report prompt once answers exist.
///
/// Answers are presented as confirmed scene observations rather than as more
/// text to interpret, because that is what they are: a human looking at the
/// patient chose one of a small set of options. A model that treats them as
/// another opinion will average them against its own guess from the
/// description, which is the opposite of why they were asked.
export function buildClarificationBlock(clarifications) {
  const answered = (clarifications || []).filter((c) => c?.answer);
  if (answered.length === 0) {
    return `ANSWERS FROM THE SCENE: none — the describing party skipped the questions.
Write the report from the description alone, and leave anything it does not state
as "Not reported". Do not compensate for the missing answers by guessing.`;
  }

  const lines = answered
    .map((c) => `- ${c.question}\n  ANSWER: ${c.answer}`)
    .join('\n');

  const skipped = (clarifications || []).filter((c) => !c?.answer).length;

  return `ANSWERS FROM THE SCENE (confirmed observations — these outrank your own
inference from the description above, and must be reflected in the report):

${lines}
${skipped > 0 ? `\n${skipped} further question(s) were left unanswered. Leave those fields as "Not reported".` : ''}`;
}

/// Phase one: the questions, and nothing else.
///
/// Deliberately not a report. Under the blocking sequence the record is written
/// once, after the answers are in, so asking the model for a provisional report
/// here would produce a draft nobody is allowed to act on and invite someone to
/// ship it by mistake.
export function buildClarificationPrompt(inputs) {
  const {
    transcribedText = null,
    userText = null,
    imageDescriptions = [],
    photoAttached = false,
    medicalProfile = null,
    detectedLanguage = 'en',
  } = inputs || {};

  const voiceBlock = transcribedText
    ? `VOICE NOTE TRANSCRIPTION (${detectedLanguage.toUpperCase()}):\n"${transcribedText}"`
    : 'VOICE NOTE: Not provided';

  const textBlock = userText ? `TEXT INPUT:\n"${userText}"` : 'TEXT INPUT: Not provided';

  // A photo is usually still being analysed when the questions are composed —
  // describing it takes a vision call of its own, and the questions do not wait
  // for it. Saying so matters: without it the model reads "no images" and asks
  // about things the photograph already answers.
  const imageBlock = imageDescriptions.length > 0
    ? `IMAGE ANALYSIS:\n${imageDescriptions.map((d, i) => `Image ${i + 1}: ${d}`).join('\n')}`
    : photoAttached
      ? 'PHOTOGRAPH: One was taken at the scene and goes to the hospital with the '
        + 'report, but it has not been analysed yet. Do not ask about anything a '
        + 'photograph of the patient would answer by itself — visible wounds, '
        + 'blood, position, obvious deformity.'
      : 'IMAGES: Not provided';

  const profileBlock = medicalProfile
    ? `ON FILE ALREADY (do not ask about any of these):
- Blood Group: ${medicalProfile.blood_group || 'not on file'}
- Age: ${calculateAge(medicalProfile.date_of_birth) ?? 'not on file'}
- Known Conditions: ${medicalProfile.chronic_conditions?.join(', ') || 'none on file'}
- Current Medications: ${medicalProfile.current_medications?.join(', ') || 'none on file'}
- Known Allergies: ${medicalProfile.allergies?.join(', ') || 'none on file'}`
    : 'ON FILE ALREADY: nothing — this patient is unregistered.';

  return `CLARIFICATION QUESTION REQUEST

Someone is standing over a casualty and has just described what they can see.
A doctor at the receiving hospital will act on the report built from it. Before
that report is written, you get to ask between two and four questions.

=== WHAT THEY TOLD US ===

${voiceBlock}

${textBlock}

${imageBlock}

${profileBlock}

=== WHAT TO ASK ===

Ask about what this description does NOT settle, in the order that would most
change what the hospital prepares. Airway, breathing, consciousness and bleeding
come before history. Rules, all of them binding:

- Between 2 and 4 questions. Fewer is better than padding with filler.
- Each has 2 to 4 options. At most 4 words per option. Mutually exclusive.
- The person answers with ONE TAP and cannot type. Never ask for a number, a
  name, a time, a dose or anything open-ended.
- Phrase for a frightened bystander with no medical training. "Is their chest
  moving?" not "Assess respiratory effort".
- Ask NOTHING the description, the images or the file above already answers.
- Include an option that means "I cannot tell" wherever a bystander genuinely
  might not be able to tell. Forcing a guess is worse than knowing nothing.

=== LANGUAGE ===

The report is written in English, so the English question and options below go
into the record and are read by hospital staff.

${languageInstruction(detectedLanguage)}

=== REQUIRED OUTPUT FORMAT ===

Respond with ONLY this JSON object (no other text):

{
  "clarification_questions": [
    {
      "field": "one of: consciousness_state | urgency_level | emergency_type | key_observations | medications_mentioned | allergies_active",
      "question": "string — in English",
      "options": ["string", "string", ...],
      "question_local": "string — the same question, for the person to read",
      "options_local": ["string", "string", ...]
    }
  ]
}

options_local must have exactly the same number of entries as options, in the
same order, because the person answers by position. Omit both _local fields
entirely where the instruction above says to — do not repeat the English.`;
}

/// What to do about the language the questions are shown in.
///
/// The record stays in English for hospital record-keeping, but the questions
/// are read by whoever is standing over the patient. Asking an Urdu speaker
/// "Is their chest moving?" in English wastes the question and is the opposite
/// of what a multilingual intake channel is for.
function languageInstruction(language) {
  switch (language) {
    case 'ur':
      return `The person describing the patient is writing Urdu. Give question_local and
options_local in Urdu script. Keep them short — these are tap targets, not prose.`;
    case 'roman_ur':
      return `The person describing the patient is writing Roman Urdu — Urdu in Latin
script, as it is actually typed on a phone in Pakistan ("mareez hosh mein hai?").
Give question_local and options_local in that form, not in Urdu script and not in
formal English.`;
    case 'sd':
      return `The person describing the patient is speaking Sindhi. Give question_local and
options_local in Urdu script, which they will be able to read.`;
    default:
      // Omitted rather than duplicated. Repeating every question and option
      // verbatim doubled the response for English reporters, and output length
      // is most of the latency on the one call someone is waiting through.
      return `The person describing the patient is writing English, so the English
question and options are already what they will read. OMIT question_local and
options_local entirely — do not repeat the English into them.`;
  }
}

// Prompt for GPT-4o vision analysis of a single injury/scene image.
export function buildImageAnalysisPrompt(imageIndex) {
  return `You are analyzing an emergency scene image for a medical triage system in Pakistan.
Describe ONLY what is medically relevant:
- Visible injuries (location, severity, type)
- Patient position and apparent consciousness
- Any visible medical equipment or medications
- Environmental hazards if any
Be clinical and factual. Maximum 3 sentences.
If the image shows no relevant medical content, say: 'No medically relevant content visible.'`;
}

export default {
  SYSTEM_PROMPT,
  buildUserPrompt,
  buildClarificationPrompt,
  buildClarificationBlock,
  calculateAge,
  buildImageAnalysisPrompt,
};
