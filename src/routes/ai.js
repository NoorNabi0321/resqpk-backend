// Module 6 — AI report routes.
import express from 'express';
import caseAuth from '../middleware/case-auth.js';
import {
  uploadMiddleware,
  generateReport,
  getReport,
  getReportPdf,
  resendReportToHospital,
  getClarifications,
  answerClarification,
  skipClarifications,
  submitClarifications,
} from '../controllers/ai.controller.js';

const router = express.Router();

// Generate a report from voice, text or photos (multipart).
// caseAuth accepts a case token — a WhatsApp or web reporter has no account —
// or a normal user JWT. The controllers decide what each principal may touch.
router.post('/report', caseAuth, uploadMiddleware, generateReport);

// The reporter (by token or account) or the receiving hospital reads it.
// The /pdf variant is declared first so it isn't captured by :caseId.
router.get('/report/:caseId/pdf', caseAuth, getReportPdf);
router.post('/report/:caseId/send', caseAuth, resendReportToHospital);

// Blocking clarification: the questions put before the record is written. One
// single-tap answer at a time; the last answer, or a skip, writes the record
// and delivers it. Declared before :caseId for the same reason /pdf is.
router.post('/report/:caseId/clarify/submit', caseAuth, submitClarifications);
router.post('/report/:caseId/clarify/skip', caseAuth, skipClarifications);
router.get('/report/:caseId/clarify', caseAuth, getClarifications);
router.post('/report/:caseId/clarify', caseAuth, answerClarification);

router.get('/report/:caseId', caseAuth, getReport);

export default router;
