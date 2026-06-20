// Loads, validates, and exports a typed configuration object for the ResQPK backend.
// Importing this module has the side effect of loading the .env file via dotenv.
import dotenv from 'dotenv';

dotenv.config();

// Variables that MUST be present for the backend to boot.
// Integration keys added in later modules (Google Maps, OpenAI, gateway URL) are
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
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',

  // App URLs
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  missedCallGatewayUrl: process.env.MISSED_CALL_GATEWAY_URL || '',
};

export default config;
export { config };
