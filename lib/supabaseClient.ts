import { createClient } from '@supabase/supabase-js';

// Cliente para usar desde el navegador (ANON KEY)
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);