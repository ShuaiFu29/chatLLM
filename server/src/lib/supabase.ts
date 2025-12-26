import { createClient } from '@supabase/supabase-js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL!;
// Prefer Service Role Key for backend operations to bypass RLS
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY!;

const options: any = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  }
};

if (process.env.HTTPS_PROXY) {
  console.log(`[Supabase] Using Proxy: ${process.env.HTTPS_PROXY}`);
  const proxyAgent = new ProxyAgent(process.env.HTTPS_PROXY);

  options.global = {
    fetch: (url: any, init: any) => {
      return undiciFetch(url, {
        ...init,
        dispatcher: proxyAgent,
      });
    }
  };
}

export const supabase = createClient(supabaseUrl, supabaseKey, options);

// Create a separate admin client for background tasks that need to bypass RLS
// We strictly require the Service Role Key here
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceRoleKey) {
  console.warn('[Supabase] SUPABASE_SERVICE_ROLE_KEY is missing. Background tasks may fail if RLS is enabled.');
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey || supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  ...(process.env.HTTPS_PROXY ? {
    global: {
      fetch: (url: any, init: any) => {
        const { ProxyAgent, fetch: undiciFetch } = require('undici');
        const proxyAgent = new ProxyAgent(process.env.HTTPS_PROXY);
        // undici requires duplex: 'half' for streaming bodies
        const duplex = init.body && typeof init.body.pipe === 'function' ? 'half' : undefined;
        return undiciFetch(url, {
          ...init,
          dispatcher: proxyAgent,
          duplex: duplex || init.duplex,
        });
      }
    }
  } : {})
});
