/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------- utils ----------------
function norm(s?: string | null) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function pick(body: any, ...keys: string[]): any {
  for (const k of keys) {
    const v = body?.[k];
    if (v != null) return v;
  }
  return null;
}
// ---------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // preflight / health
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body: any = req.body || {};
    const opp: any = body.opportunity ?? body.payload?.opportunity ?? body;

    // --- Identificadores principales del evento ---
    const opportunityId: string | undefined =
      (pick(body, 'opportunityId') ?? opp?.id)?.toString();

    const stageNameRaw: string | null =
      (pick(body, 'pipelineStageName', 'stageName') ??
        opp?.pipelineStageName ??
        opp?.stage_name ??
        null)?.toString() ?? null;

    const assignedUserIdRaw: string | null =
      (pick(body, 'assignedUserId', 'userId') ??
        opp?.assignedUserId ??
        opp?.userId ??
        null)?.toString() ?? null;

    if (!opportunityId) {
      return res.status(200).json({ ok: true, skip: 'NO_OPPORTUNITY_ID' });
    }
    if (!stageNameRaw) {
      return res.status(200).json({ ok: true, skip: 'NO_STAGE_NAME' });
    }

    // --- Buscar el prospecto por opportunityId ---
    const { data: p, error: eP } = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (eP) return res.status(200).json({ ok: true, skip: 'SELECT_PROSPECT_ERROR' });
    if (!p) return res.status(200).json({ ok: true, skip: 'PROSPECT_NOT_FOUND', opportunityId });

    // --- Resolver nombre de etapa (usar tabla pipeline_stages) ---
    const stageWant = norm(stageNameRaw);
    const { data: allStages } = await supabase
      .from('pipeline_stages')
      .select('stage, etapas');

    let newStage: string | null = null;
    if (allStages && allStages.length) {
      for (const r of allStages) {
        const n1 = norm(r.stage);
        const n2 = norm(r.etapas);
        if (n1 === stageWant || n2 === stageWant) {
          newStage = r.stage; // usamos la columna 'stage' (sin acento) como canónica
          break;
        }
      }
    }
    // fallback: si no matcheó con la tabla, usar el nombre normalizado
    if (!newStage) newStage = stageWant;

    const fromStage = p.etapa_actual ?? null;
    const toStage = newStage;

    // Dedupe rápido (evita doble insert por la misma transición en ≤ 60 s)
    const { data: last } = await supabase
      .from('prospecto_stage_history')
      .select('from_stage, to_stage, changed_at')
      .eq('prospecto_id', p.id)
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const now = new Date();
    const lastAt = last?.changed_at ? new Date(last.changed_at).getTime() : 0;
    const within60s = lastAt > 0 && Math.abs(now.getTime() - lastAt) <= 60_000;
    const sameMove =
      last?.from_stage === fromStage && last?.to_stage === toStage;

    // --- INSERTAR HISTORIAL (si no es duplicado inmediato) ---
    let insertedHistory = false;
    if (!(sameMove && within60s)) {
      const { error: insErr } = await supabase
        .from('prospecto_stage_history')
        .insert([{
          prospecto_id: p.id,
          hl_opportunity_id: opportunityId,
          from_stage: fromStage,
          to_stage: toStage,
          changed_at: now.toISOString(),
          // dueño del prospecto; si viene un assignedUserId y no hay owner aún, tratamos de mapearlo
          asesor_id: p.asesor_id ?? null,
          source: 'WEBHOOK_HL',
        }]);
      insertedHistory = !insErr;

      // si no había owner pero vino assignedUserId, intentamos mapear y actualizar esa fila recién creada
      if (!p.asesor_id && assignedUserIdRaw) {
        const { data: a } = await supabase
          .from('asesores')
          .select('id')
          .eq('hl_user_id', assignedUserIdRaw)
          .maybeSingle();
        if (a?.id) {
          // actualizar owner en prospecto y en la fila insertada más reciente (por si se insertó)
          await supabase.from('prospectos')
            .update({ asesor_id: a.id, updated_at: now.toISOString() })
            .eq('id', p.id);
          await supabase
            .from('prospecto_stage_history')
            .update({ asesor_id: a.id })
            .eq('prospecto_id', p.id)
            .eq('hl_opportunity_id', opportunityId)
            .is('asesor_id', null);
        }
      }
    }

    // --- ACTUALIZAR prospecto: etapa_actual + stage_changed_at (+ updated_at) ---
    const stageChanged = toStage !== fromStage;
    if (stageChanged) {
      await supabase
        .from('prospectos')
        .update({
          etapa_actual: toStage,
          stage_changed_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('id', p.id);
    }

    return res.status(200).json({
      ok: true,
      opportunityId,
      fromStage,
      toStage,
      stageChanged,
      historyInserted: insertedHistory,
    });
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}