// GET /health — liveness probe + Supabase connectivity check.
import express from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { successResponse, errorResponse } from '../utils/response.js';

const router = express.Router();

router.get('/', async (req, res) => {
  let database = 'disconnected';

  // A cheap head query confirms the database is reachable without pulling rows.
  try {
    const { error } = await supabaseAdmin
      .from('hospitals')
      .select('id', { head: true, count: 'exact' });
    if (!error) database = 'connected';
  } catch {
    database = 'disconnected';
  }

  const payload = {
    status: database === 'connected' ? 'ok' : 'degraded',
    database,
    uptime: Number(process.uptime().toFixed(1)),
    timestamp: new Date().toISOString(),
  };

  if (database === 'connected') {
    return successResponse(res, payload, 'ResQPK backend is healthy', 200);
  }

  // Up, but the database is unreachable.
  return errorResponse(res, 'ResQPK backend is up but the database is unreachable', 503, [
    { field: 'database', message: 'disconnected' },
  ]);
});

export default router;
