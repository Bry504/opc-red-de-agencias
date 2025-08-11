/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// URL del proyecto (usa la pública si está definida)
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
// 🔒 Service Role SOLO en el servidor
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type CheckResp = { exists: boolean; match_on: null | 'celular' | 'dni' };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CheckResp | { error: string }>
) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ======= AUTORIZACIÓN OPC (token revocable) =======
    const tokenHeader = req.headers['x-opc-token'];
    const opcToken =
      (typeof tokenHeader === 'string' && tokenHeader) ||
      (typeof (req.body ?? {})['opc_token'] === 'string' ? (req.body as any)['opc_token'] : '');

    // Si no hay token, no revelamos nada (como si no existiera)
    if (!opcToken) return res.status(200).json({ exists: false, match_on: null });

    const { data: opc } = await supabaseAdmin
      .from('asesores')
      .select('estado')
      .eq('capture_token', opcToken)
      .single();

    // Si no existe o está inactivo, no permitimos chequeo
    if (!opc || !opc.estado) return res.status(200).json({ exists: false, match_on: null });

    // ======= Payload del chequeo =======
    const { celular, dni } = (req.body ?? {}) as { celular?: string; dni?: string };

    // Si no llega nada, no bloquear
    if (!celular && !dni) return res.status(200).json({ exists: false, match_on: null });

    // ======= RPC que respeta normalización (+ usa dni_ce en la BD) =======
    const { data, error } = await supabaseAdmin.rpc('prospecto_existe', {
      p_celular: celular ?? null,
      p_dni: dni ?? null,
    });

    if (error || !data) return res.status(200).json({ exists: false, match_on: null });

    // data esperado: { exists: boolean, match_on: 'celular' | 'dni' | null }
    return res.status(200).json(data as CheckResp);
  } catch {
    // No romper UX en caso de fallo: asumimos no existe
    return res.status(200).json({ exists: false, match_on: null });
  }
}