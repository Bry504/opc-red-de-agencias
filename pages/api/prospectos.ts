/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== HighLevel / LeadConnector env =====
const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN ?? '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';

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

// (pushToHighLevel) — lo dejas como ya lo tienes

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // --- auth ---
    const tokenHeader = req.headers['x-opc-token'];
    const opcToken = typeof tokenHeader === 'string' ? tokenHeader : '';
    if (!opcToken) return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });

    const { data: opc, error: opcErr } = await supabase
      .from('asesores')
      .select('id,codigo,estado')
      .eq('capture_token', opcToken)
      .single();
    if (opcErr || !opc || !opc.estado) {
      return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });
    }

    // --- campos ---
    const lugar_prospeccion = (body['lugar_prospeccion'] as string) ?? null;
    const nombre            = (body['nombre'] as string) ?? '';
    const apellido          = (body['apellido'] as string) ?? '';
    const celularRaw        = (body['celular'] as string) ?? '';
    const dni_ce            = (body['dni_ce'] as string) ?? '';
    const emailRaw          = (body['email'] as string) ?? '';
    const proyectoRaw       = (body['proyecto_interes'] as string) ?? null;
    const proyecto_interes  = proyectoRaw === 'NINGUNO' ? null : proyectoRaw;
    const comentario        = (body['comentario'] as string) ?? null;
    const utm_source        = (body['utm_source'] as string) ?? null;
    const utm_medium        = (body['utm_medium'] as string) ?? null;
    const utm_campaign      = (body['utm_campaign'] as string) ?? null;
    const lat               = (body['lat'] as number | undefined) ?? null;
    const lon               = (body['lon'] as number | undefined) ?? null;

    // --- validaciones mínimas ---
    if (!nombre.trim() || !apellido.trim()) return res.status(200).json({ ok: false, error: 'VALIDATION' });
    const celular = cleanPhone(celularRaw || '');
    if (!celular || celular.length !== 9) return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidDniCe(dni_ce))            return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidEmail(emailRaw))          return res.status(200).json({ ok: false, error: 'VALIDATION' });

    // --- precheck server-side (RPC) para duplicados ---
    const celN   = celular.replace(/^51/, '').replace(/^0+/, '');
    const dniN   = (dni_ce ?? '').trim();
    const emailN = (emailRaw ?? '').trim().toLowerCase().replace(/\s+/g, '');
    const { data: dup, error: rpcErr } = await supabase.rpc('prospecto_existe', {
      p_celular: celN || null,
      p_dni: dniN || null,
      p_email: emailN || null,
    });
    if (!rpcErr && dup && (dup as any).exists) {
      const where = (dup as any).match_on as 'celular'|'dni'|'email'|null;
      if (where === 'email')   return res.status(200).json({ ok: false, error: 'DUPLICADO_EMAIL' });
      if (where === 'celular') return res.status(200).json({ ok: false, error: 'DUPLICADO_CEL' });
      if (where === 'dni')     return res.status(200).json({ ok: false, error: 'DUPLICADO_DNI' });
      return res.status(200).json({ ok: false, error: 'DUPLICADO' });
    }

    // --- insert ---
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = (typeof ipHeader === 'string' && ipHeader)
      ? ipHeader.split(',')[0].trim()
      : req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    const { data, error } = await supabase
      .from('prospectos')
      .insert([{
        lugar_prospeccion,
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        celular,                             // 9 dígitos
        dni_ce: dniN || null,
        email: emailN || null,               // normalizado al guardar
        proyecto_interes,
        comentario,
        asesor_codigo: opc.codigo,
        utm_source, utm_medium, utm_campaign,
        lat, lon,
        user_agent: ua,
        ip_insercion: ip
      }])
      .select('id')
      .single();

    if (error) {
      // @ts-ignore
      if (error.code === '23505') {
        const m = String((error as any).message || '');
        if (/ux_prospectos_email_norm2/i.test(m)) return res.status(200).json({ ok: false, error: 'DUPLICADO_EMAIL' });
        // agrega aquí si luego creas índices para cel/dni
        return res.status(200).json({ ok: false, error: 'DUPLICADO' });
      }
      // @ts-ignore
      if (error.code === '23514') return res.status(200).json({ ok: false, error: 'CHECK_VIOLATION' });
      return res.status(200).json({ ok: false, error: 'ERROR_DESCONOCIDO' });
    }

    // (pushToHighLevel) — lo dejas igual, no bloqueante
    // await pushToHighLevel({ ... });

    return res.status(200).json({ ok: true, id: data.id });
  } catch {
    return res.status(200).json({ ok: false, error: 'ERROR_DESCONOCIDO' });
  }
}