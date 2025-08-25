/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';
const GHL_ACCESS_TOKEN = process.env.GHL_ACCESS_TOKEN ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function phone9(v?: string | null) {
  const n = String(v ?? '').replace(/\D/g, '').replace(/^51/, '');
  return n.slice(-9) || null;
}
function emailNorm(v?: string | null) {
  const e = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return e || null;
}

async function fetchJsonWithFallback(paths: string[], headers: Record<string, string>) {
  for (const url of paths) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json().catch(() => ({}));
    } catch {}
  }
  return null;
}

async function fetchOppDetail(opportunityId: string): Promise<any | null> {
  if (!GHL_ACCESS_TOKEN) return null;
  const headers = {
    Authorization: `Bearer ${GHL_ACCESS_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Version: '2021-07-28',
    'Location-Id': GHL_LOCATION_ID,
  };
  const urls = [
    `https://services.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
    `https://api.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
  ];
  return fetchJsonWithFallback(urls, headers);
}

async function fetchContact(contactId: string): Promise<any | null> {
  if (!GHL_ACCESS_TOKEN) return null;
  const headers = {
    Authorization: `Bearer ${GHL_ACCESS_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Version: '2021-07-28',
    'Location-Id': GHL_LOCATION_ID,
  };
  const urls = [
    `https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`,
    `https://api.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`,
  ];
  return fetchJsonWithFallback(urls, headers);
}

async function fetchAssignedWithRetry(opportunityId: string, tries = 4, delayMs = 1200): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const d = await fetchOppDetail(opportunityId);
    if (d) {
      const uid =
        d?.assignedUserId ||
        d?.assignedTo?.id ||
        d?.userId ||
        d?.opportunity?.assignedTo?.id ||
        d?.data?.assignedUserId ||
        null;
      if (uid) return String(uid);
    }
    await sleep(delayMs);
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body: any = req.body || {};

    // Validación suave por location
    const locHeader = req.headers['location-id'] as string | undefined;
    const locationId = body.locationId || locHeader || null;
    if (GHL_LOCATION_ID && locationId && locationId !== GHL_LOCATION_ID) {
      console.warn('WEBHOOK_HL location mismatch', { got: locationId, want: GHL_LOCATION_ID });
    }

    // Oportunidad
    const opp: any = body.opportunity ?? body.payload?.opportunity ?? body;
    const opportunityId: string | undefined = body.opportunityId ?? opp?.id;
    if (!opportunityId) return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });

    // 1) Obtener HL user asignado (retries por latencia)
    let hlUserId: string | null =
      (body.assignedUserId ?? body.userId ?? body.assigned_to?.id ?? body.assignedTo?.id ?? opp?.assignedUserId)
        ? String(body.assignedUserId ?? body.userId ?? body.assigned_to?.id ?? body.assignedTo?.id ?? opp?.assignedUserId)
        : null;

    if (!hlUserId) {
      hlUserId = await fetchAssignedWithRetry(opportunityId, 4, 1200);
    }
    if (!hlUserId) return res.status(200).json({ ok: true, skip: 'NO_ASSIGNED_USER' });

    // 2) Mapear asesor
    const { data: ases } = await supabase
      .from('asesores')
      .select('id')
      .eq('hl_user_id', hlUserId)
      .maybeSingle();
    const asesorId = ases?.id ?? null;
    if (!asesorId) return res.status(200).json({ ok: true, skip: 'ASESOR_NOT_MAPPED' });

    // 3) Buscar prospecto por hl_opportunity_id
    let { data: prospecto } = await supabase
      .from('prospectos')
      .select('id, asesor_id, celular, email')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    // 4) Fallback: si no existe, buscar por contacto (tel/email) y setear hl_opportunity_id
    if (!prospecto) {
      const d = await fetchOppDetail(opportunityId);
      const contactId =
        d?.contactId || d?.opportunity?.contactId || d?.data?.contactId || null;

      let cel9: string | null = null;
      let mailN: string | null = null;

      if (contactId) {
        const c = await fetchContact(String(contactId));
        const phone =
          c?.phone || c?.contact?.phone || c?.data?.phone ||
          c?.primaryPhone || c?.contact?.primaryPhone || null;
        const email =
          c?.email || c?.contact?.email || c?.data?.email ||
          c?.primaryEmail || c?.contact?.primaryEmail || null;

        cel9 = phone9(phone);
        mailN = emailNorm(email);
      }

      // buscar por celular
      if (cel9) {
        const { data: byCel } = await supabase
          .from('prospectos')
          .select('id, asesor_id, hl_opportunity_id')
          .eq('celular', cel9)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (byCel) {
          prospecto = byCel;
        }
      }

      // si aún no, buscar por email
      if (!prospecto && mailN) {
        const { data: byEmail } = await supabase
          .from('prospectos')
          .select('id, asesor_id, hl_opportunity_id')
          .eq('email', mailN)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (byEmail) {
          prospecto = byEmail;
        }
      }

      // si lo encontramos por contacto, setear el opportunityId
      if (prospecto && !prospecto.hl_opportunity_id) {
        await supabase
          .from('prospectos')
          .update({ hl_opportunity_id: opportunityId, updated_at: new Date().toISOString() })
          .eq('id', prospecto.id);
      }
    }

    if (!prospecto) {
      return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND' });
    }

    // 5) Actualizar asesor si cambió
    if (prospecto.asesor_id !== asesorId) {
      await supabase
        .from('prospectos')
        .update({ asesor_id: asesorId, updated_at: new Date().toISOString() })
        .eq('id', prospecto.id);
    }

    // Nada de historial aquí
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn('WEBHOOK_HL error', e);
    return res.status(200).json({ ok: true, handled: false });
  }
}