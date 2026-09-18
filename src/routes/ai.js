// Module 6 — AI report routes.
import express from 'express';
import caseAuth from '../middleware/case-auth.js';
import {
  uploadMiddleware,
  generateReport,
  getReport,
  getReportPdf,
} from '../controllers/ai.controller.js';

const router = express.Router();

// Generate a report from voice, text or photos (multipart).
// caseAuth accepts a case token — a WhatsApp or web reporter has no account —
// or a normal user JWT. The controllers decide what each principal may touch.
router.post('/report', caseAuth, uploadMiddleware, generateReport);

// The reporter (by token or account) or the receiving hospital reads it.
// The /pdf variant is declared first so it isn't captured by :caseId.
router.get('/report/:caseId/pdf', caseAuth, getReportPdf);
router.get('/report/:caseId', caseAuth, getReport);

export default router;
