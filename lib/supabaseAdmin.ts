import { createClient } from '@supabase/supabase-js';

// ⚠️ SOLO servidor: usa la Service Role Key (no la expongas en el front)
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,      // misma URL
  process.env.SUPABASE_SERVICE_ROLE_KEY!      // service role
);