// Firebase Cloud Messaging push notifications. Best-effort: if Firebase isn't
// configured, every send returns { success: false, reason: 'not_configured' }
// without throwing — the Socket.io layer carries real-time delivery regardless.
import admin from 'firebase-admin';
import logger from '../middleware/logger.js';

let firebaseReady = false;
let initAttempted = false;

function initFirebase() {
  if (firebaseReady) return true;
  if (initAttempted) return firebaseReady; // only try once
  initAttempted = true;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn('Firebase not configured — FCM disabled (Socket.io still delivers in real time).');
    return false;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
    firebaseReady = true;
    logger.info('Firebase Admin initialized');
    return true;
  } catch (err) {
    logger.error(`Firebase Admin init failed: ${err.message}`);
    return false;
  }
}

export async function sendDriverDispatchNotification(driverFcmToken, payload) {
  if (!initFirebase()) return { success: false, reason: 'not_configured' };
  if (!driverFcmToken) return { success: false, reason: 'no_token' };

  const { caseId, caseNumber, patientName, distanceText, timeoutMs } = payload;
  const message = {
    token: driverFcmToken,
    notification: {
      title: '🚨 Emergency Request',
      body: `${patientName} needs help • ${distanceText} away`,
    },
    data: {
      type: 'dispatch_request',
      caseId: String(caseId ?? ''),
      caseNumber: String(caseNumber ?? ''),
      distanceText: String(distanceText ?? ''),
      timeoutMs: String(timeoutMs ?? ''),
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'emergency_dispatch',
        priority: 'max',
        sound: 'emergency_alert',
        vibrateTimingsMillis: [0, 500, 200, 500],
      },
    },
  };

  try {
    await admin.messaging().send(message);
    return { success: true };
  } catch (err) {
    logger.error(`FCM driver dispatch failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function sendPatientConfirmationNotification(patientFcmToken, payload) {
  if (!initFirebase()) return { success: false, reason: 'not_configured' };
  if (!patientFcmToken) return { success: false, reason: 'no_token' };

  const { driverName, vehicleNumber, etaText } = payload;
  const message = {
    token: patientFcmToken,
    notification: {
      title: '✅ Ambulance on the way',
      body: `${driverName} is coming • ETA: ${etaText}`,
    },
    data: {
      type: 'driver_assigned',
      driverName: String(driverName ?? ''),
      vehicleNumber: String(vehicleNumber ?? ''),
      etaText: String(etaText ?? ''),
    },
    android: { priority: 'high' },
  };

  try {
    await admin.messaging().send(message);
    return { success: true };
  } catch (err) {
    logger.error(`FCM patient confirmation failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function sendHospitalNotification(hospitalAdminFcmTokens, payload) {
  if (!initFirebase()) return { success: false, reason: 'not_configured' };
  const tokens = (hospitalAdminFcmTokens || []).filter(Boolean);
  if (tokens.length === 0) return { success: false, reason: 'no_tokens' };

  const { patientName, urgencyLevel, etaText, caseNumber } = payload;
  const message = {
    tokens,
    notification: {
      title: `🏥 Incoming: ${urgencyLevel ?? 'Emergency'}`,
      body: `${patientName} • ETA ${etaText} • ${caseNumber}`,
    },
    data: {
      type: 'hospital_new_case',
      caseNumber: String(caseNumber ?? ''),
      urgencyLevel: String(urgencyLevel ?? ''),
    },
    android: { priority: 'high' },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(message);
    return { success: true, sent: res.successCount };
  } catch (err) {
    logger.error(`FCM hospital notify failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// SMS to family is a future feature — for now just log the tracking link.
export async function sendFamilyTrackingNotification(familyPhone, shareUrl, patientName) {
  logger.info(`FAMILY ALERT: ${patientName} emergency. Track: ${shareUrl} (to ${familyPhone})`);
  return { success: true, method: 'logged' };
}

export default {
  sendDriverDispatchNotification,
  sendPatientConfirmationNotification,
  sendHospitalNotification,
  sendFamilyTrackingNotification,
};
