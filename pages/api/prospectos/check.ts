/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type CheckResp = { exists: boolean; match_on: null | 'celular' | 'dni' | 'email' };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CheckResp | { error: string }>
) {
  // Preflight/health
  if (req.method === 'OPTIONS' || req.method === 'HEAD' || req.method === 'GET') {
    res.setHeader('Allow', 'POST,GET,OPTIONS,HEAD');
    return res.status(200).json({ exists: false, match_on: null });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET,OPTIONS,HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // --- auth (silenciosa) ---
    const h = req.headers['x-opc-token'];
    const opcToken = typeof h === 'string' ? h : '';
    if (!opcToken) return res.status(200).json({ exists: false, match_on: null });

    const { data: opc, error: errOpc } = await supabaseAdmin
      .from('opcs')
      .select('estado')
      .eq('capture_token', opcToken)
      .single();

    if (errOpc || !opc || !opc.estado) {
      return res.status(200).json({ exists: false, match_on: null });
    }

    // --- payload ---
    const { celular, dni, email } = (req.body ?? {}) as {
      celular?: string; dni?: string; email?: string;
    };
    if (!celular && !dni && !email) {
      return res.status(200).json({ exists: false, match_on: null });
    }

    // --- normalizaciones (igual que en el RPC) ---
    const celN = (celular ?? '').replace(/\D/g, '').replace(/^51/, '').replace(/^0+/, '');
    const dniN = (dni ?? '').trim();
    const emailN = (email ?? '').trim().toLowerCase().replace(/\s+/g, '');

    const { data, error } = await supabaseAdmin.rpc('prospecto_existe', {
      p_celular: celN || null,
      p_dni: dniN || null,
      p_email: emailN || null,
    });

    if (error || !data) return res.status(200).json({ exists: false, match_on: null });

    const exists = Boolean((data as any).exists);
    const match_on = ((data as any).match_on ?? null) as CheckResp['match_on'];
    return res.status(200).json({ exists, match_on });
  } catch {
    return res.status(200).json({ exists: false, match_on: null });
  }
}