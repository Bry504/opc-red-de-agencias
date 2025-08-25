/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';
const GHL_ACCESS_TOKEN = process.env.GHL_ACCESS_TOKEN ?? ''; // necesario para leer la oportunidad

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchOppAssignedUserId(opportunityId: string): Promise<string | null> {
  if (!GHL_ACCESS_TOKEN) return null;
  const headers = {
    Authorization: `Bearer ${GHL_ACCESS_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Version: '2021-07-28',
    'Location-Id': GHL_LOCATION_ID,
  } as const;

  const urls = [
    `https://services.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
    `https://api.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const j: any = await r.json().catch(() => ({}));
      const uid =
        j?.assignedUserId ||
        j?.assignedTo?.id ||
        j?.userId ||
        j?.opportunity?.assignedTo?.id ||
        j?.data?.assignedUserId ||
        null;
      if (uid) return String(uid);
    } catch (_) {}
  }
  return null;
}

async function fetchAssignedWithRetry(opportunityId: string, tries = 4, delayMs = 1200): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const uid = await fetchOppAssignedUserId(opportunityId);
    if (uid) return uid;
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

    // validación suave de location
    const locHeader = req.headers['location-id'] as string | undefined;
    const locationId = body.locationId || locHeader || null;
    if (GHL_LOCATION_ID && locationId && locationId !== GHL_LOCATION_ID) {
      console.warn('WEBHOOK_HL_ASSIGN location mismatch', { got: locationId, want: GHL_LOCATION_ID });
    }

    // id de oportunidad
    const opp: any = body.opportunity ?? body.payload?.opportunity ?? body;
    const opportunityId: string | undefined = body.opportunityId ?? opp?.id;
    if (!opportunityId) return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });

    // buscar prospecto
    const { data: p } = await supabase
      .from('prospectos')
      .select('id, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (!p) return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND' });

    // 1) intenta con el body (si lo mandaste)
    let hlUserId: string | null =
      (body.assignedUserId ?? body.userId ?? body.assigned_to?.id ?? body.assignedTo?.id ?? opp?.assignedUserId)
        ? String(body.assignedUserId ?? body.userId ?? body.assigned_to?.id ?? body.assignedTo?.id ?? opp?.assignedUserId)
        : null;

    // 2) si no hay o viene vacío, consulta HL con reintentos (por la latencia de persistencia)
    if (!hlUserId) {
      hlUserId = await fetchAssignedWithRetry(opportunityId, 4, 1200);
    }

    if (!hlUserId) {
      console.log('WEBHOOK_HL_ASSIGN skip: NO_ASSIGNED_USER', { opportunityId });
      return res.status(200).json({ ok: true, skip: 'NO_ASSIGNED_USER' });
    }

    // mapear al asesor local
    const { data: a } = await supabase
      .from('asesores')
      .select('id')
      .eq('hl_user_id', hlUserId)
      .maybeSingle();

    const nuevoAsesorId = a?.id ?? null;
    if (!nuevoAsesorId) {
      console.log('WEBHOOK_HL_ASSIGN skip: ASESOR_NOT_MAPPED', { hlUserId });
      return res.status(200).json({ ok: true, skip: 'ASESOR_NOT_MAPPED' });
    }

    // actualizar solo si cambia
    if (p.asesor_id !== nuevoAsesorId) {
      await supabase
        .from('prospectos')
        .update({ asesor_id: nuevoAsesorId, updated_at: new Date().toISOString() })
        .eq('id', p.id);
    }

    // IMPORTANTE: no insertamos historial aquí (solo asignación)
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn('WEBHOOK_HL_ASSIGN error', e);
    return res.status(200).json({ ok: true, handled: false });
  }
}