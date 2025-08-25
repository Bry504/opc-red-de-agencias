/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GHL_LOCATION_ID  = process.env.GHL_LOCATION_ID ?? '';
const GHL_ACCESS_TOKEN = process.env.GHL_ACCESS_TOKEN ?? process.env.GHL_TOKEN ?? '';

function norm(s?: string | null) {
  return (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function pick(body: any, ...keys: string[]) {
  for (const k of keys) {
    const v = body?.[k];
    if (v != null) return v;
  }
  return null;
}

function extractAssignedUserId(obj: any): string | null {
  const cands = [
    obj?.assignedUserId,
    obj?.userId,
    obj?.assigned_to?.id,
    obj?.assignedTo?.id,
    obj?.opportunity?.assignedTo?.id,
    obj?.opportunity?.assignedUserId,
    obj?.data?.assignedUserId,
    obj?.result?.assignedUserId,
  ].filter(Boolean);
  return cands.length ? String(cands[0]) : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body: any = req.body ?? {};
    const opp = body.opportunity ?? body.payload?.opportunity ?? body;

    const opportunityId: string | undefined =
      pick(body, 'opportunityId') ?? opp?.id ?? undefined;

    if (!opportunityId) {
      return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });
    }

    // 1) localizar prospecto
    const { data: p } = await supabase
      .from('prospectos')
      .select('id, asesor_id, etapa_actual, stage_changed_at')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (!p) return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND' });

    // 2) mapear hl_user -> asesores.id
    const assignedUserId =
      pick(body, 'assignedUserId', 'userId') ?? extractAssignedUserId(opp);
    if (!assignedUserId) return res.status(200).json({ ok: true, skip: 'NO_ASSIGNED_USER' });

    const { data: a } = await supabase
      .from('asesores')
      .select('id')
      .eq('hl_user_id', String(assignedUserId))
      .maybeSingle();

    if (!a?.id) {
      return res.status(200).json({ ok: true, skip: 'ASESOR_NOT_FOUND', assignedUserId });
    }

    // 3) actualizar el dueño en prospectos si cambió
    if (a.id !== p.asesor_id) {
      await supabase
        .from('prospectos')
        .update({ asesor_id: a.id, updated_at: new Date().toISOString() })
        .eq('id', p.id);
    }

    // 4) completar/actualizar la fila inicial del history (si existe y es reciente)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: recent } = await supabase
      .from('prospecto_stage_history')
      .select('id, to_stage, from_stage, asesor_id, source, changed_at')
      .eq('prospecto_id', p.id)
      .gte('changed_at', fiveMinAgo)
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recent && recent.to_stage === p.etapa_actual) {
      if (!recent.asesor_id) {
        await supabase
          .from('prospecto_stage_history')
          .update({ asesor_id: a.id, source: 'ASSIGN' })
          .eq('id', recent.id);
      }
      return res.status(200).json({
        ok: true,
        mode: 'UPDATED_EXISTING_HISTORY',
        prospecto_id: p.id,
        asesor_id: a.id,
      });
    }

    // 5) si no hubo fila reciente, insertamos una de "asignación" sobre la etapa actual
    await supabase.from('prospecto_stage_history').insert([{
      prospecto_id: p.id,
      hl_opportunity_id: opportunityId,
      from_stage: p.etapa_actual,
      to_stage: p.etapa_actual,
      changed_at: new Date().toISOString(),
      asesor_id: a.id,
      source: 'ASSIGN',
    }]);

    return res.status(200).json({
      ok: true,
      mode: 'INSERTED_ASSIGN_HISTORY',
      prospecto_id: p.id,
      asesor_id: a.id,
    });
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}