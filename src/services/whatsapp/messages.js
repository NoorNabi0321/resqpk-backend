// Every string the bot sends, in the three languages ResQPK serves.
//
// Language is chosen by the word that triggered the conversation: "SOS" or
// "help" → English, "مدد" → Urdu, "madad" → Roman Urdu. Someone in an emergency
// should not have to pick a language from a menu first.
//
// Copy rules: short lines, one instruction at a time, no system vocabulary.
// "Ambulance is 6 minutes away", never "status: driver_assigned".

export const TRIGGERS = {
  en: ['sos', 'help', 'emergency', 'ambulance'],
  ur: ['مدد', 'ایمرجنسی', 'ایمبولینس'],
  roman: ['madad', 'madat', 'ambulance chahiye'],
};

export const CANCEL_WORDS = ['cancel', 'stop', 'منسوخ', 'band karo', 'cancel karo'];

/** Which language a trigger word implies, or null if it is not a trigger. */
export function detectTrigger(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  for (const [language, words] of Object.entries(TRIGGERS)) {
    if (words.some((w) => t === w || t.startsWith(`${w} `) || t.startsWith(w))) return language;
  }
  return null;
}

export function isCancel(text) {
  const t = String(text || '').trim().toLowerCase();
  return CANCEL_WORDS.some((w) => t === w);
}

const copy = {
  en: {
    who: 'Emergency received.\n\nWho needs the ambulance?',
    whoSelf: 'For me',
    whoOther: 'Someone else',
    type: 'What kind of emergency?',
    typeAccident: 'Accident',
    typeCardiac: 'Heart / chest',
    typeBreathing: 'Breathing',
    typeOther: 'Something else',
    location: 'Tap the button below to send your location.\n\nWe cannot send an ambulance without it.',
    landmark:
      'No location received.\n\nType the nearest landmark instead — for example "near Civil Hospital gate, Hyderabad".',
    landmarkFailed:
      'Could not find that place. Try a bigger landmark nearby, or tap 📎 → Location to send a pin.',
    confirm: (place) =>
      `Location received${place ? `: ${place}` : ''}.\n\nSend *1* to confirm and we will dispatch an ambulance.`,
    confirmYes: 'Yes, send ambulance',
    confirmNo: 'Cancel',
    searching: (code, link) =>
      `🚑 Searching for the nearest ambulance.\n\nYour request code: *${code}*\nTrack here: ${link}\n\nStay with the patient. Reply CANCEL to stop.`,
    driverAssigned: (d) =>
      `✅ Ambulance on the way\n\n*${d.name}*\nVehicle: ${d.vehicle}\nArriving in about ${d.eta}\nCall driver: ${d.phone}\n\nTrack: ${d.link}`,
    hospital: (name) => `🏥 Destination hospital: *${name}*\nThey have been notified.`,
    arrived: 'The ambulance has reached the patient.',
    enRoute: (name) => `On the way to ${name || 'hospital'}.`,
    completed: 'The patient has reached hospital. We hope they recover soon.',
    noDriver:
      '❌ No ambulance is available right now.\n\nPlease call:\nRescue 1122 — *1122*\nEdhi — *115*\nChhipa — *1020*',
    cancelled: 'Your request has been cancelled.',
    rateLimited:
      'You already have a request in progress. Reply CANCEL first, or call 1122 if this is a new emergency.',
    unknown: 'Send *SOS* to request an ambulance.',
    voicePrompt:
      'You can send a voice note describing the situation — what happened, is the patient conscious, any bleeding. The hospital will receive it before the ambulance arrives.',
  },

  ur: {
    who: 'ایمرجنسی موصول ہوئی۔\n\nایمبولینس کس کے لیے چاہیے؟',
    whoSelf: 'میرے لیے',
    whoOther: 'کسی اور کے لیے',
    type: 'کس قسم کی ایمرجنسی ہے؟',
    typeAccident: 'حادثہ',
    typeCardiac: 'دل / سینہ',
    typeBreathing: 'سانس',
    typeOther: 'کچھ اور',
    location: 'نیچے بٹن دبا کر اپنی لوکیشن بھیجیں۔\n\nلوکیشن کے بغیر ایمبولینس نہیں بھیجی جا سکتی۔',
    landmark: 'لوکیشن موصول نہیں ہوئی۔\n\nقریب کی مشہور جگہ لکھیں — مثلاً "سول ہسپتال گیٹ، حیدرآباد"۔',
    landmarkFailed: 'یہ جگہ نہیں ملی۔ کوئی بڑی جگہ لکھیں یا 📎 → Location سے پن بھیجیں۔',
    confirm: (place) =>
      `لوکیشن موصول ہو گئی${place ? `: ${place}` : ''}۔\n\nتصدیق کے لیے *1* بھیجیں، ایمبولینس روانہ کی جائے گی۔`,
    confirmYes: 'ہاں، ایمبولینس بھیجیں',
    confirmNo: 'منسوخ کریں',
    searching: (code, link) =>
      `🚑 قریب ترین ایمبولینس تلاش کی جا رہی ہے۔\n\nآپ کا کوڈ: *${code}*\nٹریک کریں: ${link}\n\nمریض کے پاس رہیں۔ منسوخی کے لیے CANCEL لکھیں۔`,
    driverAssigned: (d) =>
      `✅ ایمبولینس روانہ ہو گئی\n\n*${d.name}*\nگاڑی: ${d.vehicle}\nتقریباً ${d.eta} میں پہنچے گی\nڈرائیور کو کال کریں: ${d.phone}\n\nٹریک: ${d.link}`,
    hospital: (name) => `🏥 ہسپتال: *${name}*\nانہیں اطلاع دے دی گئی ہے۔`,
    arrived: 'ایمبولینس مریض تک پہنچ گئی ہے۔',
    enRoute: (name) => `${name || 'ہسپتال'} کی طرف روانہ۔`,
    completed: 'مریض ہسپتال پہنچ گیا ہے۔ جلد صحتیابی کی دعا ہے۔',
    noDriver: '❌ اس وقت کوئی ایمبولینس دستیاب نہیں۔\n\nبراہ کرم کال کریں:\nریسکیو *1122*\nایدھی *115*\nچھیپا *1020*',
    cancelled: 'آپ کی درخواست منسوخ کر دی گئی ہے۔',
    rateLimited: 'آپ کی ایک درخواست پہلے سے جاری ہے۔ پہلے CANCEL لکھیں، یا نئی ایمرجنسی پر 1122 کال کریں۔',
    unknown: 'ایمبولینس کے لیے *SOS* بھیجیں۔',
    voicePrompt:
      'صورتحال بتانے کے لیے وائس نوٹ بھیجیں — کیا ہوا، مریض ہوش میں ہے یا نہیں، خون تو نہیں بہہ رہا۔ ہسپتال کو ایمبولینس سے پہلے اطلاع مل جائے گی۔',
  },

  roman: {
    who: 'Emergency mil gayi.\n\nAmbulance kis ke liye chahiye?',
    whoSelf: 'Mere liye',
    whoOther: 'Kisi aur ke liye',
    type: 'Kis tarah ki emergency hai?',
    typeAccident: 'Accident',
    typeCardiac: 'Dil / seena',
    typeBreathing: 'Saans',
    typeOther: 'Kuch aur',
    location: 'Neeche button daba kar apni location bhejein.\n\nLocation ke baghair ambulance nahi bhej sakte.',
    landmark: 'Location nahi mili.\n\nQareeb ki mashhoor jagah likhein — jaise "Civil Hospital gate, Hyderabad".',
    landmarkFailed: 'Ye jagah nahi mili. Koi bari jagah likhein ya 📎 → Location se pin bhejein.',
    confirm: (place) =>
      `Location mil gayi${place ? `: ${place}` : ''}.\n\nConfirm karne ke liye *1* bhejein, ambulance rawana ki jayegi.`,
    confirmYes: 'Haan, ambulance bhejein',
    confirmNo: 'Cancel',
    searching: (code, link) =>
      `🚑 Qareeb tareen ambulance dhoondi ja rahi hai.\n\nAap ka code: *${code}*\nTrack karein: ${link}\n\nMareez ke paas rahein. Cancel ke liye CANCEL likhein.`,
    driverAssigned: (d) =>
      `✅ Ambulance rawana ho gayi\n\n*${d.name}*\nGaari: ${d.vehicle}\nTaqreeban ${d.eta} mein pahunchegi\nDriver ko call karein: ${d.phone}\n\nTrack: ${d.link}`,
    hospital: (name) => `🏥 Hospital: *${name}*\nUnhein ittila de di gayi hai.`,
    arrived: 'Ambulance mareez tak pahunch gayi hai.',
    enRoute: (name) => `${name || 'hospital'} ki taraf rawana.`,
    completed: 'Mareez hospital pahunch gaya hai. Jald sehatyabi ki dua hai.',
    noDriver: '❌ Is waqt koi ambulance dastiyab nahi.\n\nCall karein:\nRescue *1122*\nEdhi *115*\nChhipa *1020*',
    cancelled: 'Aap ki request cancel kar di gayi hai.',
    rateLimited: 'Aap ki ek request pehle se jari hai. Pehle CANCEL likhein, ya nai emergency par 1122 call karein.',
    unknown: 'Ambulance ke liye *SOS* bhejein.',
    voicePrompt:
      'Situation batane ke liye voice note bhejein — kya hua, mareez hosh mein hai ya nahi, khoon to nahi beh raha. Hospital ko ambulance se pehle ittila mil jayegi.',
  },
};

/** Copy for a language, falling back to English for anything unrecognised. */
export function t(language = 'en') {
  return copy[language] || copy.en;
}

export default { TRIGGERS, CANCEL_WORDS, detectTrigger, isCancel, t };
