/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';

/* ---------------- helpers ---------------- */

function norm(s?: string | null) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pick(body: any, ...keys: string[]) {
  for (const k of keys) {
    if (k.includes('.')) {
      // soporte de rutas tipo "opportunity.stage_name"
      const parts = k.split('.');
      let cur: any = body;
      let ok = true;
      for (const p of parts) {
        if (cur && p in cur) cur = cur[p];
        else {
          ok = false;
          break;
        }
      }
      if (ok && cur != null) return cur;
    } else if (body?.[k] != null) {
      return body[k];
    }
  }
  return null;
}

/** Devuelve {stage, etapas} de la tabla pipeline_stages según un nombre de etapa */
async function resolveStageByName(stageNameRaw: string) {
  const nameN = norm(stageNameRaw);

  // Traemos todas una sola vez y resolvemos en memoria (8 filas)
  const { data: all, error } = await supabase
    .from('pipeline_stages')
    .select('stage, etapas');

  if (error || !all) return null;

  // 1) match por 'etapas' (texto humano)
  let hit = all.find((r) => norm(r.etapas) === nameN);
  if (hit) return hit;

  // 2) match por 'stage' (código en mayúsculas con underscores)
  hit = all.find((r) => norm(r.stage) === nameN);
  if (hit) return hit;

  // 3) heuristic: reemplazar espacios por underscores
  const asCode = nameN.replace(/\s+/g, '_');
  hit = all.find((r) => norm(r.stage) === asCode);
  if (hit) return hit;

  return null;
}

function extractAssignedUserId(body: any, opp: any): string | null {
  const cands = [
    pick(body, 'assignedUserId', 'userId', 'assigned_to.id', 'assignedTo.id'),
    pick(opp, 'assignedUserId', 'userId', 'assigned_to.id', 'assignedTo.id'),
  ].filter(Boolean) as string[];
  return cands.length ? String(cands[0]) : null;
}

/* --------------- handler ------------------ */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // health
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || '')) {
    res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const debug = String(req.headers['x-debug'] || '').trim() === '1';

  try {
    const body: any = req.body || {};
    const opp: any = body.opportunity ?? body.payload?.opportunity ?? body;

    const locationId =
      pick(body, 'locationId', 'Location-Id') ??
      pick(req.headers, 'location-id') ??
      null;
    const locOk = GHL_LOCATION_ID ? (locationId || '') === GHL_LOCATION_ID : true;

    const opportunityId: string | undefined =
      (pick(body, 'opportunityId') ??
        pick(opp, 'opportunityId', 'id')) || undefined;

    if (!opportunityId) {
      const out = { ok: true, skip: 'NO_OPPORTUNITY_ID' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // Aceptamos todas las variantes conocidas
    const stageNameRaw =
      (pick(body, 'stageName', 'stage_name', 'pipelineStageName', 'pipeline_stage_name') ??
        pick(opp, 'stageName', 'stage_name', 'pipelineStageName', 'pipeline_stage_name')) ||
      null;

    if (!stageNameRaw) {
      const out = { ok: true, skip: 'NO_STAGE_NAME' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // Buscar prospecto por oportunidad HL
    const { data: p, error: eP } = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (eP) {
      const out = { ok: true, skip: 'SELECT_ERROR' as const };
      return res.status(200).json(debug ? { ...out, eP } : out);
    }
    if (!p) {
      const out = { ok: true, skip: 'PROSPECT_NOT_FOUND' as const, opportunityId };
      return res.status(200).json(out);
    }

    // Resolver asesor (si vino)
    let asesorId: string | null = null;
    const assignedUserId = extractAssignedUserId(body, opp);
    if (assignedUserId) {
      const { data: a } = await supabase
        .from('asesores')
        .select('id')
        .eq('hl_user_id', String(assignedUserId))
        .maybeSingle();
      asesorId = a?.id ?? null;
    }
    // fallback: mantenemos dueño actual si no vino
    if (!asesorId) asesorId = p.asesor_id ?? null;

    // Resolver etapa de destino a partir del nombre recibido
    const resolved = await resolveStageByName(String(stageNameRaw));
    if (!resolved) {
      const out = { ok: true, skip: 'STAGE_NOT_MAPPED' as const, stageNameRaw };
      return res.status(200).json(debug ? { ...out, stageListExpected: 'pipeline_stages' } : out);
    }
    const toStage = resolved.stage; // p.ej. 'PROSPECCION'
    const fromStage = p.etapa_actual ?? null;

    const now = new Date().toISOString();

    // Dedupe rápido: último movimiento igual en ≤60s
    const { data: last } = await supabase
      .from('prospecto_stage_history')
      .select('from_stage, to_stage, changed_at')
      .eq('prospecto_id', p.id)
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let skipInsert = false;
    if (last) {
      const isSame = last.from_stage === fromStage && last.to_stage === toStage;
      const lastAt = last.changed_at ? new Date(last.changed_at).getTime() : 0;
      const within60s = lastAt > 0 && Math.abs(Date.now() - lastAt) <= 60_000;
      skipInsert = isSame && within60s;
    }

    if (!skipInsert) {
      await supabase.from('prospecto_stage_history').insert([
        {
          prospecto_id: p.id,
          hl_opportunity_id: opportunityId,
          from_stage: fromStage,
          to_stage: toStage,
          changed_at: now,
          source: 'WEBHOOK_HL_STAGE',
          asesor_id: asesorId ?? null,
        },
      ]);
    }

    // Actualizar prospecto (etapa_actual + fecha de cambio + dueño si cambió)
    const patch: Record<string, any> = {
      etapa_actual: toStage,
      stage_changed_at: now,
      updated_at: now,
    };
    if (asesorId && asesorId !== p.asesor_id) patch.asesor_id = asesorId;

    await supabase.from('prospectos').update(patch).eq('id', p.id);

    return res.status(200).json(
      debug
        ? {
            ok: true,
            opportunityId,
            fromStage,
            toStage,
            asesorId,
            saved: !skipInsert,
            locOk,
          }
        : { ok: true }
    );
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}