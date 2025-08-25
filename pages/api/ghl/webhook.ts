/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';

function pickAssignedId(payload: any): string | null {
  return (
    payload?.assignedUserId ||
    payload?.userId ||
    payload?.assigned_to?.id ||
    payload?.assignedTo?.id ||
    null
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Permitir preflight y probes
  if (req.method === 'OPTIONS' || req.method === 'HEAD' || req.method === 'GET') {
    res.setHeader('Allow', 'POST,GET,OPTIONS,HEAD');
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET,OPTIONS,HEAD');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body: any = req.body || {};
    const locHeader = req.headers['location-id'] as string | undefined;
    const locationId = body.locationId || locHeader || null;

    // Validación suave de Location
    if (GHL_LOCATION_ID && locationId && locationId !== GHL_LOCATION_ID) {
      console.warn('WEBHOOK location mismatch', { got: locationId, want: GHL_LOCATION_ID });
    }

    // Normalizar payload
    const opp = body.opportunity || body.payload?.opportunity || body;
    const opportunityId: string | undefined = body.opportunityId || opp?.id;
    if (!opportunityId) {
      return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });
    }

    // IDs o nombres (ambos soportados)
    const pipelineId   = body.pipelineId   ?? opp?.pipelineId   ?? null;
    const pipelineName = body.pipelineName ?? opp?.pipeline_name ?? null;

    const stageId      = body.pipelineStageId   ?? opp?.pipelineStageId   ?? null;
    const stageName    = body.pipelineStageName ?? opp?.stage_name        ?? null;

    const assignedId   = pickAssignedId(body) ?? pickAssignedId(opp);

    // Buscar prospecto por hl_opportunity_id
    const { data: p, error: eP } = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (eP) {
      console.warn('WEBHOOK: select prospect error', eP);
      return res.status(200).json({ ok: true, skip: 'SELECT_ERROR' });
    }
    if (!p) {
      // Aún no linkeado; podrías agregar búsqueda por phone/contact aquí si lo necesitas
      return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND' });
    }

    // Resolver asesor por hl_user_id
    let asesorId: string | null = null;
    if (assignedId) {
      const { data: a } = await supabase
        .from('asesores')
        .select('id')
        .eq('hl_user_id', String(assignedId))
        .maybeSingle();
      asesorId = a?.id ?? null;
    }

    // Resolver nueva etapa por id o por nombre
    let newStage: string | null = null;
    if (stageId) {
      const { data: map } = await supabase
        .from('hl_stage_map')
        .select('stage')
        .eq('hl_stage_id', String(stageId))
        .maybeSingle();
      newStage = map?.stage ?? null;
    } else if (stageName) {
      const { data: map } = await supabase
        .from('hl_stage_map')
        .select('stage')
        .ilike('hl_stage_name', String(stageName))
        .maybeSingle();
      newStage = map?.stage ?? null;
    }

    // Patch en prospectos
    const patch: any = { updated_at: new Date().toISOString() };
    if (pipelineId)         patch.hl_pipeline_id = String(pipelineId);
    else if (pipelineName)  patch.hl_pipeline_id = String(pipelineName); // guarda nombre si no hay id
    if (asesorId)           patch.asesor_id = asesorId;

    let stageChanged = false;
    if (newStage && newStage !== p.etapa_actual) {
      patch.etapa_actual     = newStage;
      patch.stage_changed_at = new Date().toISOString();
      stageChanged = true;
    }

    if (Object.keys(patch).length > 1) {
      const { error: upErr } = await supabase
        .from('prospectos')
        .update(patch)
        .eq('id', p.id);
      if (upErr) console.warn('WEBHOOK: update prospect error', upErr);
    }

    // —— Backfills útiles ————————————————————————————————

    // 1) Completar el hl_opportunity_id en historial si estaba NULL
    await supabase
      .from('prospecto_stage_history')
      .update({ hl_opportunity_id: opportunityId })
      .eq('prospecto_id', p.id)
      .is('hl_opportunity_id', null);

    // 2) Completar actor en filas iniciales si no llegó desde HL
    if (asesorId) {
      await supabase
        .from('prospecto_stage_history')
        .update({ changed_by_asesor_id: asesorId })
        .eq('prospecto_id', p.id)
        .is('changed_by_asesor_id', null)
        .in('source', ['INSERT', 'BACKFILL']);
    }

    // —— Insertar historial cuando cambia la etapa —————————
    if (stageChanged) {
      const actorId = asesorId ?? p.asesor_id ?? null; // fallback si HL no manda user
      await supabase.from('prospecto_stage_history').insert([{
        prospecto_id: p.id,
        hl_opportunity_id: opportunityId,
        from_stage: p.etapa_actual,              // la etapa que tenía antes del update
        to_stage: newStage,
        changed_at: new Date().toISOString(),
        changed_by_asesor_id: actorId,
        source: 'WEBHOOK_HL',
      }]);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn('WEBHOOK error', e);
    return res.status(200).json({ ok: true, handled: false });
  }
}