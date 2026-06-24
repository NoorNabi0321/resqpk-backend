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
  } = inputs || {};

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
  "medications_mentioned": ["string", ...],
  "allergies_active": ["string", ...],
  "estimated_patient_age": "string or null",
  "confidence_score": number
}`;
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

export default { SYSTEM_PROMPT, buildUserPrompt, calculateAge, buildImageAnalysisPrompt };
