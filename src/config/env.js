// Loads, validates, and exports a typed configuration object for the ResQPK backend.
// Importing this module has the side effect of loading the .env file via dotenv.
import dotenv from 'dotenv';

dotenv.config();

// Variables that MUST be present for the backend to boot.
// Integration keys added in later modules (OpenRouteService, OpenAI) are
// read with safe fallbacks below so early modules can run before those keys exist.
const REQUIRED_VARS = [
  'NODE_ENV',
  'PORT',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
];

const missing = REQUIRED_VARS.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === '';
});

if (missing.length > 0) {
  throw new Error(
    `[ResQPK] Missing required environment variable(s): ${missing.join(', ')}.\n` +
      'Copy .env.example to .env and fill in the values before starting the server.'
  );
}

const config = {
  // Runtime
  nodeEnv: process.env.NODE_ENV,
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',
  port: Number(process.env.PORT) || 3000,

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

  // JWT
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // Third-party integrations (wired up in later modules — optional for now)
  orsApiKey: process.env.ORS_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',

  // WhatsApp Cloud API — the second SOS intake channel. All optional: without
  // them the webhook simply reports itself as unconfigured.
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v25.0',
  },

  // App URLs
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  // Where tracking links point. The public web app, not the hospital dashboard.
  publicWebUrl: process.env.PUBLIC_WEB_URL || process.env.FRONTEND_URL || 'http://localhost:5173',
};

export default config;
export { config };
