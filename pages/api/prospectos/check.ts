/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// URL del proyecto (usa la pública si está definida)
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
// 🔒 Service Role SOLO en el servidor
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type CheckResp = { exists: boolean; match_on: null | 'celular' | 'dni' | 'email' };

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

    // Sin token: no revelamos nada (comportarnos como "no existe")
    if (!opcToken) return res.status(200).json({ exists: false, match_on: null });

    const { data: opc, error: errAsesor } = await supabaseAdmin
      .from('asesores')
      .select('estado')
      .eq('capture_token', opcToken)
      .single();

    if (errAsesor || !opc || !opc.estado) {
      // Si hay error o token inválido/inactivo, no filtramos info
      return res.status(200).json({ exists: false, match_on: null });
    }

    // ======= Payload =======
    const { celular, dni, email } = (req.body ?? {}) as {
      celular?: string;
      dni?: string;       // <- tu frontend envía dniCe como 'dni'
      email?: string;
    };

    // Nada que chequear
    if (!celular && !dni && !email) {
      return res.status(200).json({ exists: false, match_on: null });
    }

    // ======= RPC: normaliza y compara al vuelo (sin tocar tu tabla) =======
    const { data, error } = await supabaseAdmin.rpc('prospecto_existe', {
      p_celular: celular ?? null,
      p_dni: dni ?? null,
      p_email: email ?? null,
    });

    if (error || !data) {
      // No romper UX ni filtrar data sensible: asumir que no existe
      return res.status(200).json({ exists: false, match_on: null });
    }

    // data es el JSONB devuelto por la función
    // Aseguramos typings mínimamente
    const exists = typeof (data as any).exists === 'boolean' ? (data as any).exists : false;
    const match_on = ((data as any).match_on ?? null) as CheckResp['match_on'];

    return res.status(200).json({ exists, match_on });
  } catch {
    // Falla silenciosa: no bloquear por error de red/RPC
    return res.status(200).json({ exists: false, match_on: null });
  }
}