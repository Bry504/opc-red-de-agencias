/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';

// ---- helpers ---------------------------------------------------------------
function pickAssignedId(payload: any): string | null {
  return (
    payload?.assignedUserId ||
    payload?.userId ||
    payload?.assigned_to?.id ||
    payload?.assignedTo?.id ||
    null
  );
}

// normaliza texto: quita acentos, minúsculas y recorta
function norm(s?: string | null) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // preflight / health
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

    // validación suave por location
    if (GHL_LOCATION_ID && locationId && locationId !== GHL_LOCATION_ID) {
      console.warn('WEBHOOK_HL location mismatch', { got: locationId, want: GHL_LOCATION_ID });
    }

    // HL a veces anida la oportunidad
    const opp: any = body.opportunity ?? body.payload?.opportunity ?? body;

    // id de oportunidad HL
    const opportunityId: string | undefined = body.opportunityId ?? opp?.id;
    if (!opportunityId) {
      console.log('WEBHOOK_HL skip: NO_OPPORTUNITY_ID');
      return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });
    }

    // valores recibidos (por id o por nombre)
    const stageIdRaw: string | null =
      (body.pipelineStageId ?? opp?.pipelineStageId ?? null) as any;
    const stageNameRaw: string | null =
      (body.pipelineStageName ?? body.stageName ?? opp?.stage_name ?? null) as any;

    const pipelineIdRaw: string | null =
      (body.pipelineId ?? opp?.pipelineId ?? null) as any;
    const pipelineNameRaw: string | null =
      (body.pipelineName ?? opp?.pipeline_name ?? null) as any;

    // normalizados para buscar en *_norm
    const stageNameNorm = norm(stageNameRaw);
    const pipelineNameNorm = norm(pipelineNameRaw);

    const assignedId = pickAssignedId(body) ?? pickAssignedId(opp);

    // buscar prospecto
    const { data: p, error: eP } = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (eP) {
      console.warn('WEBHOOK_HL select prospect error', eP);
      return res.status(200).json({ ok: true, skip: 'SELECT_ERROR' });
    }
    if (!p) {
      console.log('WEBHOOK_HL skip: PROSPECT_NOT_FOUND', { opportunityId });
      return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND' });
    }

    // resolver asesor (si vino)
    let asesorId: string | null = null;
    if (assignedId) {
      const { data: a } = await supabase
        .from('asesores')
        .select('id')
        .eq('hl_user_id', String(assignedId))
        .maybeSingle();
      asesorId = a?.id ?? null;
    }

    // resolver etapa nueva
    let newStage: string | null = null;

    // 1) por stageId directo
    if (stageIdRaw) {
      const { data: mapById } = await supabase
        .from('hl_stage_map')
        .select('stage')
        .eq('hl_stage_id', String(stageIdRaw))
        .maybeSingle();
      newStage = mapById?.stage ?? null;
    }

    // 2) por nombre normalizado + pipeline normalizado
    if (!newStage && (stageNameNorm || pipelineNameNorm)) {
      let q = supabase.from('hl_stage_map').select('stage').limit(1);
      if (stageNameNorm) q = q.eq('hl_stage_name_norm', stageNameNorm);
      if (pipelineNameNorm) q = q.eq('hl_pipeline_name_norm', pipelineNameNorm);
      const { data: mapByName } = await q.maybeSingle();
      newStage = mapByName?.stage ?? null;

      // fallback: si no vino pipelineName, probar solo por stage (por si fuera único)
      if (!newStage && stageNameNorm) {
        const { data: mapOnlyStage } = await supabase
          .from('hl_stage_map')
          .select('stage')
          .eq('hl_stage_name_norm', stageNameNorm)
          .maybeSingle();
        newStage = mapOnlyStage?.stage ?? null;
      }
    }

    console.log('WEBHOOK_HL incoming', {
      opportunityId,
      stageIdRaw,
      stageNameRaw,
      pipelineIdRaw,
      pipelineNameRaw,
      resolvedStage: newStage,
    });

    // parche a prospectos
    const patch: any = { updated_at: new Date().toISOString() };

    if (pipelineIdRaw) {
      patch.hl_pipeline_id = String(pipelineIdRaw);
    } else if (pipelineNameRaw) {
      // si no hay id, guardamos el nombre
      patch.hl_pipeline_id = String(pipelineNameRaw);
    }

    if (asesorId) patch.asesor_id = asesorId;

    let stageChanged = false;
    const fromStage = p.etapa_actual ?? null;

    if (newStage && newStage !== p.etapa_actual) {
      patch.etapa_actual = newStage;
      patch.stage_changed_at = new Date().toISOString();
      stageChanged = true;
    }

    if (Object.keys(patch).length > 1) {
      const { error: upErr } = await supabase.from('prospectos').update(patch).eq('id', p.id);
      if (upErr) console.warn('WEBHOOK_HL update prospect error', upErr);
    }

    // historial de etapas
    if (stageChanged) {
      console.log('WEBHOOK_HL stage change', {
        prospecto_id: p.id,
        from: fromStage,
        to: newStage,
      });
      await supabase.from('prospecto_stage_history').insert([
        {
          prospecto_id: p.id,
          hl_opportunity_id: opportunityId,
          from_stage: fromStage,
          to_stage: newStage,
          changed_at: new Date().toISOString(),
          changed_by_asesor_id: asesorId ?? null,
          source: 'WEBHOOK_HL',
        },
      ]);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn('WEBHOOK_HL error', e);
    return res.status(200).json({ ok: true, handled: false });
  }
}