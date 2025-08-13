/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type Resp =
  | { ok: true; data: any }
  | { ok: false; error: 'NO_AUTORIZADO' | 'VALIDATION' | 'DUPLICADO_EMAIL' | 'DUPLICADO_CEL' | 'DUPLICADO_DNI' | 'DUPLICADO' | 'DB' | 'SERVER' };

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'DB' });

  try {
    // --- Auth por token revocable ---
    const tokenHeader = req.headers['x-opc-token'];
    const opcToken = typeof tokenHeader === 'string' ? tokenHeader : '';
    if (!opcToken) return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });

    const { data: asesor } = await supabaseAdmin
      .from('asesores')
      .select('estado')
      .eq('capture_token', opcToken)
      .single();
    if (!asesor || !asesor.estado) return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });

    // --- Payload y normalizaciones básicas ---
    const b = (req.body ?? {}) as any;

    const emailNorm = (b.email ?? '').trim().toLowerCase();
    const celNorm = (b.celular ?? '').replace(/\D/g, '').replace(/^51/, '').replace(/^0+/, '');
    const dniNorm = (b.dni_ce ?? '').trim();

    // Validaciones mínimas (ajústalas si quieres)
    if (!b.nombre || !b.apellido || !b.celular) {
      return res.status(200).json({ ok: false, error: 'VALIDATION' });
    }

    // --- PRECHECK usando el RPC (evita .filter con expresiones) ---
    const { data: dup, error: rpcErr } = await supabaseAdmin.rpc('prospecto_existe', {
      p_celular: celNorm || null,
      p_dni: dniNorm || null,
      p_email: emailNorm || null,
    });

    if (!rpcErr && dup && typeof (dup as any).exists === 'boolean' && (dup as any).exists) {
      const where = (dup as any).match_on as 'celular' | 'dni' | 'email' | null;
      if (where === 'email') return res.status(200).json({ ok: false, error: 'DUPLICADO_EMAIL' });
      if (where === 'celular') return res.status(200).json({ ok: false, error: 'DUPLICADO_CEL' });
      if (where === 'dni') return res.status(200).json({ ok: false, error: 'DUPLICADO_DNI' });
      return res.status(200).json({ ok: false, error: 'DUPLICADO' });
    }

    // --- INSERT (email guardado normalizado) ---
    const { data, error } = await supabaseAdmin
      .from('prospectos')
      .insert([{
        lugar_prospeccion: b.lugar_prospeccion ?? null,
        nombre: (b.nombre ?? '').trim(),
        apellido: (b.apellido ?? '').trim(),
        celular: b.celular ?? null,        // se guarda tal cual ingresó
        dni_ce: dniNorm || null,
        email: emailNorm || null,          // normalizado
        proyecto_interes: b.proyecto_interes ?? null,
        comentario: b.comentario ?? null,
        utm_source: b.utm_source ?? null,
        utm_medium: b.utm_medium ?? null,
        utm_campaign: b.utm_campaign ?? null,
        lat: b.lat ?? null,
        lon: b.lon ?? null,
        asesor_codigo: b.asesor_codigo ?? 'OPC001',
        source: b.source ?? 'OPC',
      }])
      .select()
      .single();

    if (error) {
      // Si hay índice único por email normalizado:
      if ((error as any).code === '23505') {
        const msg = String((error as any).message || '');
        if (/ux_prospectos_email_norm2/i.test(msg)) {
          return res.status(200).json({ ok: false, error: 'DUPLICADO_EMAIL' });
        }
        // por si luego agregas índices únicos para cel/dni:
        if (/cel|phone|ux_prospectos_cel/i.test(msg)) {
          return res.status(200).json({ ok: false, error: 'DUPLICADO_CEL' });
        }
        if (/dni/i.test(msg)) {
          return res.status(200).json({ ok: false, error: 'DUPLICADO_DNI' });
        }
        return res.status(200).json({ ok: false, error: 'DUPLICADO' });
      }
      return res.status(200).json({ ok: false, error: 'DB' });
    }

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'SERVER' });
  }
}