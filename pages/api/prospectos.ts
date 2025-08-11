/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function cleanPhone(v: string) {
  return v?.replace(/\D/g, '').slice(-9); // Perú: 9 dígitos
}
function isValidDniCe(v?: string) {
  if (!v) return true;
  const s = v.trim().toUpperCase();
  if (/^\d{8}$/.test(s)) return true;           // DNI
  return /^[A-Z0-9]{9,12}$/.test(s);            // CE
}
function isValidEmail(v?: string) {
  if (!v) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // honeypot
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.web === 'string' && body.web.trim() !== '') {
      return res.status(200).json({ ok: true });
    }

    const lugar_prospeccion = (body['lugar_prospeccion'] as string) ?? null;
    const nombre = (body['nombre'] as string) ?? '';
    const apellido = (body['apellido'] as string) ?? '';
    const celular = (body['celular'] as string) ?? '';
    const dni_ce = (body['dni_ce'] as string) ?? '';
    const email = (body['email'] as string) ?? '';
    const proyecto_interes = (body['proyecto_interes'] as string) ?? null;
    const comentario = (body['comentario'] as string) ?? null;
    const asesor_codigo = (body['asesor_codigo'] as string) ?? null;
    const utm_source = (body['utm_source'] as string) ?? null;
    const utm_medium = (body['utm_medium'] as string) ?? null;
    const utm_campaign = (body['utm_campaign'] as string) ?? null;
    const lat = (body['lat'] as number | undefined) ?? null;
    const lon = (body['lon'] as number | undefined) ?? null;

    // Validaciones
    if (!nombre.trim()) return res.status(400).json({ ok: false, error: 'Nombre es obligatorio' });
    if (!apellido.trim()) return res.status(400).json({ ok: false, error: 'Apellido es obligatorio' });

    const phone = cleanPhone(celular || '');
    if (!phone || phone.length !== 9) {
      return res.status(400).json({ ok: false, error: 'Celular inválido (9 dígitos)' });
    }
    if (!isValidDniCe(dni_ce)) return res.status(400).json({ ok: false, error: 'DNI/CE inválido' });
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Correo inválido' });

    // trazas
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = (typeof ipHeader === 'string' && ipHeader) ? ipHeader.split(',')[0].trim()
             : req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    const { data, error } = await supabase
      .from('prospectos')
      .insert([{
        lugar_prospeccion,
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        celular: phone,
        dni_ce: dni_ce?.trim() || null,
        email: email?.trim() || null,
        proyecto_interes,
        comentario,
        asesor_codigo,
        utm_source,
        utm_medium,
        utm_campaign,
        lat,
        lon,
        user_agent: ua,
        ip_insercion: ip
      }])
      .select('id')
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error inesperado';
    return res.status(500).json({ ok: false, error: msg });
  }
}