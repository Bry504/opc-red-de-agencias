/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GHL_LOCATION_ID  = process.env.GHL_LOCATION_ID ?? '';

function norm(s?: string | null) {
  return (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
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
      body.opportunityId ?? opp?.id ?? undefined;

    if (!opportunityId) {
      return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });
    }

    // stage recibido
    const stageNameRaw: string | null =
      (body.stageName ?? body.pipelineStageName ?? opp?.stage_name ?? null) as any;
    const pipelineNameRaw: string | null =
      (body.pipelineName ?? opp?.pipeline_name ?? null) as any;

    if (!stageNameRaw) {
      return res.status(200).json({ ok: true, skip: 'NO_STAGE_NAME', body });
    }

    const stageNorm = norm(stageNameRaw);
    const pipeNorm  = norm(pipelineNameRaw);

    // mapa en pipeline_stages
    let newStage: string | null = null;
    {
      let q = supabase.from('pipeline_stages').select('etapas, stage').eq('stage', stageNameRaw).limit(1);
      const { data: mapByStage } = await q.maybeSingle();
      if (mapByStage?.etapas) newStage = mapByStage.etapas;
    }
    if (!newStage) newStage = stageNameRaw; // fallback – ya está normalizado en tu tabla

    // buscar prospecto
    const { data: p } = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (!p) {
      return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND' });
    }

    const fromStage = p.etapa_actual ?? null;
    const toStage   = newStage;

    // Último movimiento para dedupe (60s)
    const { data: last } = await supabase
      .from('prospecto_stage_history')
      .select('id, from_stage, to_stage, changed_at, asesor_id, source')
      .eq('prospecto_id', p.id)
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const now = Date.now();
    const lastAt = last?.changed_at ? new Date(last.changed_at).getTime() : 0;
    const within60 = lastAt > 0 && (now - lastAt) <= 60_000;

    if (last && last.from_stage === fromStage && last.to_stage === toStage && within60) {
      // Si falta asesor, rellenar con el dueño actual.
      if (!last.asesor_id && p.asesor_id) {
        await supabase.from('prospecto_stage_history').update({ asesor_id: p.asesor_id }).eq('id', last.id);
      }
      return res.status(200).json({ ok: true, skip: 'DUPLICATE_60S' });
    }

    // Dedupe extra para PROSPECCIÓN→PROSPECCIÓN (o cualquier same-stage)
    if (toStage === fromStage) {
      const threeMinAgo = new Date(now - 3 * 60_000).toISOString();
      const { data: recentSame } = await supabase
        .from('prospecto_stage_history')
        .select('id, to_stage, asesor_id')
        .eq('prospecto_id', p.id)
        .eq('to_stage', toStage)
        .gte('changed_at', threeMinAgo)
        .order('changed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recentSame) {
        // Completa asesor si falta y salimos
        if (!recentSame.asesor_id && p.asesor_id) {
          await supabase.from('prospecto_stage_history').update({ asesor_id: p.asesor_id }).eq('id', recentSame.id);
        }
        return res.status(200).json({ ok: true, skip: 'SAME_STAGE_3MIN' });
      }
    }

    // Insertar historia
    await supabase.from('prospecto_stage_history').insert([{
      prospecto_id: p.id,
      hl_opportunity_id: opportunityId,
      from_stage: fromStage,
      to_stage: toStage,
      changed_at: new Date().toISOString(),
      asesor_id: p.asesor_id ?? null,
      source: 'WEBHOOK_HL_STAGE',
    }]);

    // Actualizar prospecto
    await supabase
      .from('prospectos')
      .update({
        etapa_actual: toStage,
        stage_changed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', p.id);

    return res.status(200).json({ ok: true, changed: true, prospecto_id: p.id, fromStage, toStage });
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}