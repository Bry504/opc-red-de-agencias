/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';
const GHL_ACCESS_TOKEN = process.env.GHL_ACCESS_TOKEN ?? ''; // <- necesario para consultar HL

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// consulta detalle de oportunidad en HL para conocer el assignedTo.id
async function fetchOppAssignedUserId(opportunityId: string): Promise<string | null> {
  if (!GHL_ACCESS_TOKEN) return null;

  const baseHeaders = {
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
      const r = await fetch(url, { headers: baseHeaders });
      if (!r.ok) continue;
      const j: any = await r.json().catch(() => ({}));
      // intenta varias rutas típicas
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body: any = req.body || {};

    // validación suave por location
    const locHeader = req.headers['location-id'] as string | undefined;
    const locationId = body.locationId || locHeader || null;
    if (GHL_LOCATION_ID && locationId && locationId !== GHL_LOCATION_ID) {
      console.warn('WEBHOOK_HL_ASSIGN location mismatch', { got: locationId, want: GHL_LOCATION_ID });
    }

    // IDs básicos
    const opp: any = body.opportunity ?? body.payload?.opportunity ?? body;
    const opportunityId: string | undefined = body.opportunityId ?? opp?.id;
    if (!opportunityId) return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });

    // 1) buscar prospecto local
    const { data: p } = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (!p) return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND' });

    // 2) obtener HL user id
    //    - primero, usa lo que venga en el body (si lo pusiste)
    //    - si no hay, consulta HL para leer el assignedTo.id correcto
    let hlUserId: string | null =
      (body.assignedUserId ?? body.userId ?? body.assigned_to?.id ?? body.assignedTo?.id ?? opp?.assignedUserId)
        ? String(body.assignedUserId ?? body.userId ?? body.assigned_to?.id ?? body.assignedTo?.id ?? opp?.assignedUserId)
        : null;

    if (!hlUserId) {
      hlUserId = await fetchOppAssignedUserId(opportunityId);
    }

    if (!hlUserId) return res.status(200).json({ ok: true, skip: 'NO_ASSIGNED_USER' });

    // 3) mapear a asesores.id
    const { data: a } = await supabase
      .from('asesores')
      .select('id')
      .eq('hl_user_id', hlUserId)
      .maybeSingle();

    const nuevoAsesorId = a?.id ?? null;
    if (!nuevoAsesorId) {
      console.log('WEBHOOK_HL_ASSIGN asesor no mapeado', { hlUserId });
      return res.status(200).json({ ok: true, skip: 'ASESOR_NOT_MAPPED' });
    }

    // 4) actualizar prospecto si cambió
    const nowIso = new Date().toISOString();
    if (p.asesor_id !== nuevoAsesorId) {
      await supabase
        .from('prospectos')
        .update({ asesor_id: nuevoAsesorId, updated_at: nowIso })
        .eq('id', p.id);
    }

    // 5) dejar rastro de asignación en historial (sin cambio de etapa)
    await supabase.from('prospecto_stage_history').insert({
      prospecto_id: p.id,
      hl_opportunity_id: opportunityId,
      from_stage: p.etapa_actual ?? 'PROSPECCION',
      to_stage: p.etapa_actual ?? 'PROSPECCION',
      changed_at: nowIso,
      asesor_id: nuevoAsesorId,
      source: 'WEBHOOK_HL_ASSIGN',
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn('WEBHOOK_HL_ASSIGN error', e);
    return res.status(200).json({ ok: true, handled: false });
  }
}