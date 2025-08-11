/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- utils ---
function cleanPhone(v: string) { return v?.replace(/\D/g, '').slice(-9); }
function isValidDniCe(v?: string) {
  if (!v) return true;
  const s = v.trim().toUpperCase();
  if (/^\d{8}$/.test(s)) return true;       // DNI
  return /^[A-Z0-9]{9,12}$/.test(s);        // CE
}
function isValidEmail(v?: string) {
  if (!v) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // ======= AUTORIZACIÓN OPC (token revocable) =======
    const tokenHeader = req.headers['x-opc-token'];
    const opcToken =
      (typeof tokenHeader === 'string' && tokenHeader) ||
      (typeof body['opc_token'] === 'string' ? (body['opc_token'] as string) : '');

    if (!opcToken) return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });

    const { data: opc, error: opcErr } = await supabase
      .from('asesores')
      .select('id,codigo,estado')
      .eq('capture_token', opcToken)
      .single();

    if (opcErr || !opc || !opc.estado) {
      return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });
    }

    // ======= HONEYPOT (anti-bots) =======
    if (typeof body.web === 'string' && body.web.trim() !== '') {
      return res.status(200).json({ ok: true });
    }

    // ======= Campos =======
    const lugar_prospeccion = (body['lugar_prospeccion'] as string) ?? null;
    const nombre            = (body['nombre'] as string) ?? '';
    const apellido          = (body['apellido'] as string) ?? '';
    const celularRaw        = (body['celular'] as string) ?? '';
    const dni_ce            = (body['dni_ce'] as string) ?? '';
    const email             = (body['email'] as string) ?? '';
    const proyectoRaw       = (body['proyecto_interes'] as string) ?? null;
    const proyecto_interes  = proyectoRaw === 'NINGUNO' ? null : proyectoRaw;
    const comentario        = (body['comentario'] as string) ?? null;
    // asesor_codigo del front se ignora: usaremos el del OPC validado
    const utm_source        = (body['utm_source'] as string) ?? null;
    const utm_medium        = (body['utm_medium'] as string) ?? null;
    const utm_campaign      = (body['utm_campaign'] as string) ?? null;
    const lat               = (body['lat'] as number | undefined) ?? null;
    const lon               = (body['lon'] as number | undefined) ?? null;

    // ======= Validaciones mínimas (server) =======
    if (!nombre.trim())   return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!apellido.trim()) return res.status(200).json({ ok: false, error: 'VALIDATION' });

    const celular = cleanPhone(celularRaw || '');
    if (!celular || celular.length !== 9) return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidDniCe(dni_ce))            return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidEmail(email))             return res.status(200).json({ ok: false, error: 'VALIDATION' });

    // ======= Trazas (opcional) =======
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = (typeof ipHeader === 'string' && ipHeader)
      ? ipHeader.split(',')[0].trim()
      : req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    // ======= Inserción =======
    const { data, error } = await supabase
      .from('prospectos')
      .insert([{
        lugar_prospeccion,
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        celular,                       // 9 dígitos; índice único en BD normaliza a +51
        dni_ce: dni_ce?.trim() || null,
        email: email?.trim() || null,
        proyecto_interes,
        comentario,
        asesor_codigo: opc.codigo,     // <- SIEMPRE desde token validado
        utm_source, utm_medium, utm_campaign,
        lat, lon,
        user_agent: ua,
        ip_insercion: ip
      }])
      .select('id')
      .single();

    if (error) {
      // códigos Postgres
      // @ts-ignore
      if (error.code === '23505') return res.status(200).json({ ok: false, error: 'DUPLICADO' });
      // @ts-ignore
      if (error.code === '23514') return res.status(200).json({ ok: false, error: 'CHECK_VIOLATION' });
      return res.status(200).json({ ok: false, error: 'ERROR_DESCONOCIDO' });
    }

    return res.status(200).json({ ok: true, id: data.id });
  } catch {
    // nunca mensajes crudos
    return res.status(200).json({ ok: false, error: 'ERROR_DESCONOCIDO' });
  }
}