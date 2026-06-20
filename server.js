// Entry point: starts the HTTP server and attaches Socket.io.
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';

import app from './src/app.js';
import config from './src/config/env.js';
import logger from './src/middleware/logger.js';

// Build the HTTP server from the Express app so Socket.io can share the port.
const httpServer = http.createServer(app);

// Attach Socket.io. Real-time event handlers are wired up in Module 3; for now
// we stand up the server with CORS matching the REST layer.
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: [config.frontendUrl, 'http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Exported so later modules (Module 3) can import and register handlers.
export { io };

httpServer.listen(config.port, () => {
  logger.info(`[ResQPK] Backend running on port ${config.port} | Environment: ${config.nodeEnv}`);
});

// Crash cleanly on programming errors rather than running in a bad state.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err.stack || err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection:', reason instanceof Error ? reason.stack : reason);
  process.exit(1);
});
