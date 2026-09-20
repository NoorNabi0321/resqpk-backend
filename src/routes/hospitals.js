import express from 'express';
import { nearbyHospitals } from '../controllers/case.controller.js';

const router = express.Router();

// Emergency-capable hospitals sorted by distance from ?lat=&lng=
//
// Public. Which hospitals have an emergency ward is not private information,
// and the people who need it most have no account: a patient choosing where
// the ambulance takes them now does so without ever signing in. Behind auth,
// this returned 401 and the hospital list came up empty mid-emergency.
router.get('/nearby', nearbyHospitals);

export default router;
