// Socket.io server: JWT-authenticated connections routed to role handlers.
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

import config from '../config/env.js';
import { EVENTS, ROOMS } from './socket.events.js';
import driverHandler from './handlers/driver.handler.js';
import patientHandler from './handlers/patient.handler.js';
import hospitalHandler from './handlers/hospital.handler.js';
import { supabaseAdmin } from '../config/supabase.js';
import logger from '../middleware/logger.js';

let _io = null;

// Accessor so non-socket modules (e.g. dispatch service) can emit events.
export const getIO = () => _io;

export function initializeSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: [config.frontendUrl, 'http://localhost:5173', 'http://localhost:3000'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });

  _io = io;

  // --- Authentication: every connection must present a valid JWT. ---
  io.use((socket, next) => {
    let token = socket.handshake.auth?.token;
    if (!token) {
      const header = socket.handshake.headers?.authorization || '';
      if (header.startsWith('Bearer ')) token = header.slice(7);
    }
    if (!token) return next(new Error('Authentication token required'));

    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      socket.userId = decoded.id;
      socket.role = decoded.role;
      socket.driverId = decoded.driver_id || null;
      socket.hospitalId = decoded.hospital_id || null;
      socket.phone = decoded.phone || null;
      return next();
    } catch {
      return next(new Error('Invalid or expired token'));
    }
  });

  // --- Connection handling. ---
  io.on('connection', (socket) => {
    logger.info(
      `Socket connected: ${socket.id} | Role: ${socket.role} | User: ${socket.userId}`,
    );

    // Personal per-user room (named patient:<userId> for all roles).
    socket.join(ROOMS.patientRoom(socket.userId));

    if (socket.role === 'driver' && socket.driverId) {
      socket.join(ROOMS.driverRoom(socket.driverId));
    }
    if (socket.role === 'hospital_admin' && socket.hospitalId) {
      socket.join(ROOMS.hospitalRoom(socket.hospitalId));
    }

    socket.emit(EVENTS.CONNECTION.AUTHENTICATED, {
      userId: socket.userId,
      role: socket.role,
      socketId: socket.id,
    });

    // Register role-specific event handlers.
    if (socket.role === 'driver') driverHandler(io, socket);
    if (socket.role === 'patient') patientHandler(io, socket);
    if (socket.role === 'hospital_admin') hospitalHandler(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id} | Reason: ${reason}`);

      // A driver going away should no longer receive dispatch requests.
      if (socket.role === 'driver' && socket.driverId) {
        supabaseAdmin
          .from('drivers')
          .update({ is_available: false })
          .eq('id', socket.driverId)
          .then(() => {
            io.emit(EVENTS.DRIVER.DRIVER_STATUS_CHANGED, {
              driverId: socket.driverId,
              isAvailable: false,
              reason: 'disconnected',
            });
          });
      }
    });
  });

  // Periodic health log: connected clients + active rooms.
  const monitor = setInterval(() => {
    logger.info(
      `[socket monitor] clients: ${io.engine.clientsCount}, rooms: ${io.sockets.adapter.rooms.size}`,
    );
  }, 60000);
  monitor.unref(); // don't keep the process alive just for the monitor

  return io;
}
