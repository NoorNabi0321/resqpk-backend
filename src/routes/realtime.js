// Development-only routes for inspecting/testing the Socket.io layer.
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { getIO } from '../socket/socket.server.js';
import config from '../config/env.js';
import { successResponse, errorResponse } from '../utils/response.js';

const router = express.Router();

// These endpoints are diagnostic only — never enabled in production.
function devOnly(req, res, next) {
  if (config.isProduction) return errorResponse(res, 'Not available in production', 403);
  return next();
}

// Emit an arbitrary event to a room (for testing without two live clients).
router.post('/test-broadcast', authenticate, devOnly, (req, res) => {
  const { room, event, data } = req.body || {};
  if (!room || !event) return errorResponse(res, 'room and event are required', 400);

  const io = getIO();
  if (!io) return errorResponse(res, 'Socket server not initialized', 503);

  io.to(room).emit(event, data ?? {});
  return successResponse(res, { room, event }, 'Broadcast sent', 200);
});

// Count of currently connected sockets.
router.get('/connected-sockets', authenticate, devOnly, (req, res) => {
  const io = getIO();
  const count = io ? io.engine.clientsCount : 0;
  return successResponse(res, { count }, 'Connected sockets', 200);
});

export default router;
