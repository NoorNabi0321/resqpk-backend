// Entry point: starts the HTTP server and attaches Socket.io.
import http from 'http';

import app from './src/app.js';
import config from './src/config/env.js';
import logger from './src/middleware/logger.js';
import { initializeSocketServer } from './src/socket/socket.server.js';

// Build the HTTP server from the Express app so Socket.io can share the port.
const httpServer = http.createServer(app);

// Initialize the authenticated Socket.io server (handlers wired inside).
const io = initializeSocketServer(httpServer);

// Exported for convenience; modules can also use getIO() from socket.server.js.
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
