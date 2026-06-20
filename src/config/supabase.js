// Creates the two Supabase clients used across the backend.
import { createClient } from '@supabase/supabase-js';
import config from './env.js';

// Server-side clients never need to persist sessions or auto-refresh tokens.
const serverAuthOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
};

// Anon client — uses the public anon key and respects Row Level Security.
// Use for auth operations and anything that should run under RLS.
export const supabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseAnonKey,
  serverAuthOptions
);

// Admin client — uses the service role key and BYPASSES all RLS policies.
// Use only on the trusted server for privileged database operations.
// Never expose this key or client to any client-side code.
export const supabaseAdmin = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  serverAuthOptions
);

export default { supabaseClient, supabaseAdmin };
