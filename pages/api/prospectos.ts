import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// Cliente Supabase con Service Role (solo en servidor)
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Helpers de validación
function cleanPhone(v: string) {
  return v?.replace(/\D/g, '').slice(-9); // últimos 9 dígitos (Perú)
}
function isValidDniCe(v?: string) {
  if (!v) return true; // opcional
  const s = v.trim().toUpperCase();
  if (/^\d{8}$/.test(s)) return true;          // DNI
  return /^[A-Z0-9]{9,12}$/.test(s);           // CE 9-12 alfanum.
}
function isValidEmail(v?: string) {
  if (!v) return true; // opcional
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    // Honeypot anti-bots: si viene relleno, ignoramos
    if (req.body?.web) return res.status(200).json({ ok: true });

    const {
      lugar_prospeccion,
      nombre,
      apellido,
      celular,
      dni_ce,
      email,
      proyecto_interes,
      comentario,
      asesor_codigo,
      utm_source,
      utm_medium,
      utm_campaign,
      lat,
      lon
    } = req.body || {};

    // Obligatorios
    if (!nombre?.trim()) return res.status(400).json({ ok: false, error: 'Nombre es obligatorio' });
    if (!apellido?.trim()) return res.status(400).json({ ok: false, error: 'Apellido es obligatorio' });

    const phone = cleanPhone(celular || '');
    if (!phone || phone.length !== 9) {
      return res.status(400).json({ ok: false, error: 'Celular inválido (9 dígitos)' });
    }
    if (!isValidDniCe(dni_ce)) return res.status(400).json({ ok: false, error: 'DNI/CE inválido' });
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'Correo inválido' });

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    const { data, error } = await supabase
      .from('prospectos')
      .insert([{
        lugar_prospeccion: lugar_prospeccion || null,
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        celular: phone,
        dni_ce: dni_ce?.trim() || null,
        email: email?.trim() || null,
        proyecto_interes: proyecto_interes || null,
        comentario: comentario || null,
        asesor_codigo: asesor_codigo || null,
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
        lat: lat ?? null,
        lon: lon ?? null,
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