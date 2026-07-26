import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { nearbyHospitals } from '../controllers/case.controller.js';

const router = express.Router();

// Emergency-capable hospitals sorted by distance from ?lat=&lng=
router.get('/nearby', authenticate, nearbyHospitals);

export default router;
