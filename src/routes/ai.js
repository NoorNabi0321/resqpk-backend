// Module 6 — AI report routes.
import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { uploadMiddleware, generateReport, getReport } from '../controllers/ai.controller.js';

const router = express.Router();

// Patient generates an AI report (multipart voice/image/text).
router.post('/report', authenticate, requireRole('patient'), uploadMiddleware, generateReport);

// Patient (own case) or hospital admin (their hospital) reads the report.
router.get('/report/:caseId', authenticate, getReport);

export default router;
