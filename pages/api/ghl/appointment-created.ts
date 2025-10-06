/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ------------ helpers (mismos patrones que usas) ------------- */
function normEmail(v?: string | null) {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, '') || null;
}
function phone9(v?: string | null) {
  const s = (v ?? '').replace(/\D/g, '');
  if (!s) return null;
  return s.slice(-9) || null;
}
function pick(obj: any, ...paths: string[]) {
  for (const p of paths) {
    if (!obj) break;
    const parts = p.split('.');
    let cur: any = obj;
    let ok = true;
    for (const k of parts) {
      if (cur && k in cur) cur = cur[k];
      else { ok = false; break; }
    }
    if (ok && cur != null) return cur;
  }
  return null;
}
function deep(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return null;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const v = deep(obj[k], key);
    if (v != null) return v;
  }
  return null;
}
const parseISO = (v: any) => (v ? new Date(String(v)).toISOString() : null);

/* ------------------------- handler --------------------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (['GET','HEAD','OPTIONS'].includes(req.method || '')) {
      res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    const raw: any = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const body: any = raw.customData ?? raw; // HL suele anidar en customData

    // Campos que pediremos desde el workflow HL (ver sección 3)
    const calendar_key = (body.calendar_key || '').trim().toLowerCase(); // 'presentaciones' | 'visitas'
    const hl_appointment_id = body.hl_appointment_id ?? pick(raw, 'appointment.id') ?? null;
    const hl_calendar_id = body.hl_calendar_id ?? pick(raw, 'appointment.calendar_id') ?? null;
    const calendar_name = body.calendar_name ?? pick(raw, 'appointment.calendar_name') ?? null;
    const status = body.status ?? pick(raw, 'appointment.status') ?? 'booked';
    const starts_at = parseISO(body.start_time ?? pick(raw, 'appointment.start_time'));
    const ends_at = parseISO(body.end_time ?? pick(raw, 'appointment.end_time'));
    const meeting_url = body.meeting_url ?? pick(raw, 'appointment.meeting_url') ?? null;
    const location = body.location ?? pick(raw, 'appointment.location') ?? null;

    const hl_opportunity_id =
      body.hl_opportunity_id ??
      pick(raw, 'opportunity.id', 'payload.opportunityId', 'opportunityId') ??
      null;

    // contacto (para fallback por email/phone)
    const contact = {
      id: pick(raw, 'contact.id'),
      first_name: pick(raw, 'contact.firstName', 'contact.first_name', 'first_name'),
      last_name:  pick(raw, 'contact.lastName',  'contact.last_name',  'last_name'),
      email:      pick(raw, 'contact.email', 'email') || null,
      phone:      pick(raw, 'contact.phone', 'phone') || null,
    };

    if (!hl_appointment_id || !starts_at || !calendar_key) {
      // faltan mínimos para registrar
      return res.status(200).json({ ok: true, skip: 'MISSING_MIN_FIELDS', received: body });
    }

    // ===== Resolver prospecto/opc/asesor =====
    let prospecto_id: string | null = null;
    let opc_id: string | null = null;
    let asesor_id: string | null = null;

    // 1) Por oportunidad (ancla principal)
    if (hl_opportunity_id) {
      const { data: p1 } = await supabase
        .from('prospectos')
        .select('id, opc_id, asesor_id')
        .eq('hl_opportunity_id', hl_opportunity_id)
        .maybeSingle();
      if (p1) {
        prospecto_id = (p1 as any).id;
        opc_id = (p1 as any).opc_id ?? null;
        asesor_id = (p1 as any).asesor_id ?? null;
      }
    }

    // 2) Fallback por teléfono/email si no encontramos por oportunidad
    if (!prospecto_id) {
      const cel = phone9(contact.phone);
      const ema = normEmail(contact.email);
      if (cel) {
        const { data: pCel } = await supabase
          .from('prospectos')
          .select('id, opc_id, asesor_id')
          .eq('celular', cel)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (pCel) {
          prospecto_id = (pCel as any).id;
          opc_id = (pCel as any).opc_id ?? null;
          asesor_id = (pCel as any).asesor_id ?? null;
        }
      }
      if (!prospecto_id && ema) {
        const { data: pEma } = await supabase
          .from('prospectos')
          .select('id, opc_id, asesor_id')
          .eq('email', ema)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (pEma) {
          prospecto_id = (pEma as any).id;
          opc_id = (pEma as any).opc_id ?? null;
          asesor_id = (pEma as any).asesor_id ?? null;
        }
      }
    }

    // 3) Último intento: asignado HL -> asesores.hl_user_id
    if (!asesor_id) {
      const hl_user_id = pick(raw, 'user.id', 'assignedUserId', 'assigned_to.id');
      if (hl_user_id) {
        const { data: a } = await supabase
          .from('asesores')
          .select('id')
          .eq('hl_user_id', String(hl_user_id))
          .maybeSingle();
        if (a?.id) asesor_id = a.id;
      }
    }

    // Insert
    const row = {
      hl_appointment_id,
      hl_opportunity_id,
      hl_calendar_id,
      calendar_key,
      calendar_name,
      starts_at,
      ends_at,
      status,
      location,
      meeting_url,
      prospecto_id,
      opc_id,
      asesor_id,
      contact,
      raw,
    };

    const { error } = await supabase.from('agenda_programada').insert(row);
    if (error) return res.status(200).json({ ok: true, saved: false, error: error.message });

    return res.status(200).json({ ok: true, saved: true });
  } catch (e: any) {
    return res.status(200).json({ ok: true, saved: false, error: e?.message || String(e) });
  }
}