import express from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  listResources,
  updateResource,
  matchCaseResources,
} from '../controllers/resource.controller.js';

const router = express.Router();

// Every resource endpoint is hospital-admin only.
router.use(authenticate, requireRole('hospital_admin'));

// Specific paths before /:canonicalKey so they aren't swallowed as a key.
router.get('/match/:caseId', matchCaseResources);

router.get('/', listResources);
router.put('/:canonicalKey', updateResource);

export default router;
