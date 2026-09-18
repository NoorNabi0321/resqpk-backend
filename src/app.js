// Express application setup: security, CORS, body parsing, logging, rate
// limiting, routes, and the global error handler.
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import config from './config/env.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import realtimeRouter from './routes/realtime.js';
import sosRouter from './routes/sos.js';
import casesRouter from './routes/cases.js';
import hospitalsRouter from './routes/hospitals.js';
import resourcesRouter from './routes/resources.js';
import decisionsRouter from './routes/decisions.js';
import campsRouter from './routes/camps.js';
import analyticsRouter from './routes/analytics.js';
import aiRouter from './routes/ai.js';
import firstAidRouter from './routes/firstaid.js';
import whatsappRouter from './routes/whatsapp.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

// Render (and most PaaS) sit behind a reverse proxy. Trust the first proxy hop
// so req.ip and express-rate-limit's X-Forwarded-For handling work correctly.
app.set('trust proxy', 1);

// Security headers.
app.use(helmet());

// CORS — allow the React dashboard, local dev origins, and the production
// Render URL. Any origin set via FRONTEND_URL is also allowed.
const allowedOrigins = [
  config.frontendUrl,
  'http://localhost:5173', // React dev
  'http://localhost:3000', // local backend test
  'https://resqpk-backend.onrender.com', // production (Render)
];
app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser requests (no Origin header) and whitelisted origins.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

// Body parsing — 50mb to accommodate base64 image uploads used by AI reports.
// The raw buffer is kept because Meta signs the WhatsApp webhook over the exact
// bytes sent; re-serialising the parsed object would change the signature.
app.use(
  express.json({
    limit: '50mb',
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith('/api/whatsapp/')) req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging in development only.
if (config.isDevelopment) {
  app.use(morgan('dev'));
}

// Rate limiting — 100 requests per 15 minutes, skipping the health probe.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // The WhatsApp webhook is exempt: a 429 makes Meta retry, which would deliver
  // the same emergency twice. It is protected by signature verification instead.
  skip: (req) => req.path === '/health' || req.path.startsWith('/api/whatsapp/webhook'),
});
app.use(limiter);

// Routes.
app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/realtime', realtimeRouter);
app.use('/api/sos', sosRouter);
app.use('/api/cases', casesRouter);
app.use('/api/hospitals', hospitalsRouter);
app.use('/api/resources', resourcesRouter);
app.use('/api/decisions', decisionsRouter);
app.use('/api/camps', campsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/first-aid', firstAidRouter);
app.use('/api/whatsapp', whatsappRouter);

// Global error handler — must be registered last.
app.use(errorHandler);

export default app;
