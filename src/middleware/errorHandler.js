// Global Express error handler. Must be the LAST middleware mounted in app.js.
import config from '../config/env.js';
import { errorResponse } from '../utils/response.js';
import logger from './logger.js';

// The 4-argument signature is what marks this as an Express error handler.
// eslint-disable-next-line no-unused-vars
export default function errorHandler(err, req, res, next) {
  // Full stack in development; message-only in production.
  if (config.isDevelopment) {
    logger.error(err.stack || err.message || err);
  } else {
    logger.error(err.message || 'Unhandled error');
  }

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let errors = err.errors || null;

  // Map common Supabase / Postgres error codes to sensible HTTP statuses.
  if (err.code) {
    switch (err.code) {
      case '23505': // unique_violation
        statusCode = 409;
        message = 'A record with these details already exists';
        break;
      case '23503': // foreign_key_violation
        statusCode = 400;
        message = 'A related record was not found';
        break;
      case '23502': // not_null_violation
        statusCode = 400;
        message = 'A required field is missing';
        break;
      case 'PGRST116': // PostgREST: no rows returned for .single()
        statusCode = 404;
        message = 'Resource not found';
        break;
      default:
        break;
    }
  }

  // Never leak internal details in production.
  if (config.isProduction) {
    errors = null;
  }

  return errorResponse(res, message, statusCode, errors);
}
