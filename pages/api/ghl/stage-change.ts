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
function phone9(v?: string | null) {
  const s = (v ?? '').replace(/\D/g, '');
  if (!s) return null;
  return s.slice(-9) || null;
}
function normEmail(v?: string | null) {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, '') || null;
}

async function resolveStageByName(stageNameRaw: string) {
  const nameN = norm(stageNameRaw);
  const { data: all, error } = await supabase
    .from('pipeline_stages')
    .select('stage, etapas');
  if (error || !all) return null;

  let hit = all.find((r) => norm(r.etapas) === nameN);
  if (hit) return hit;
  hit = all.find((r) => norm(r.stage) === nameN);
  if (hit) return hit;
  const asCode = nameN.replace(/\s+/g, '_');
  hit = all.find((r) => norm(r.stage) === asCode);
  if (hit) return hit;
  return null;
}

function extractAssignedUserId(body: any, opp: any): string | null {
  const cands = [
    pick(body, 'assignedUserId', 'userId', 'assigned_to.id', 'assignedTo.id'),
    pick(body, 'customData.assignedUserId'),
    pick(opp, 'assignedUserId', 'userId', 'assigned_to.id', 'assignedTo.id'),
  ].filter(Boolean) as string[];
  return cands.length ? String(cands[0]) : null;
}

/* --------------- handler ------------------ */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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
      pick(body, 'locationId', 'Location-Id', 'customData.locationId') ??
      pick(req.headers as any, 'location-id') ??
      null;
    const locOk = GHL_LOCATION_ID ? (locationId || '') === GHL_LOCATION_ID : true;

    const opportunityId: string | undefined =
      (pick(body, 'opportunityId', 'customData.opportunityId') ??
        pick(opp, 'opportunityId', 'id')) || undefined;

    if (!opportunityId) {
      const out = { ok: true, skip: 'NO_OPPORTUNITY_ID' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    const stageNameRaw =
      (pick(
        body,
        'stageName',
        'stage_name',
        'pipelineStageName',
        'pipeline_stage_name',
        'customData.stageName',
        'customData.pipelineStageName',
        'customData.stage_name',
        'customData.pipeline_stage_name'
      ) ??
        pick(
          opp,
          'stageName',
          'stage_name',
          'pipelineStageName',
          'pipeline_stage_name'
        )) || null;

    if (!stageNameRaw) {
      const out = { ok: true, skip: 'NO_STAGE_NAME' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // Buscar prospecto
    let p: { id: number; etapa_actual: string | null; asesor_id: string | null } | null = null;

    const byOpp = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();
    if (!byOpp.error && byOpp.data) p = byOpp.data;

    if (!p) {
      // fallback por teléfono/email (payload estándar)
      const rawPhone = (pick(body, 'phone', 'contact.phone', 'payload.phone') ?? pick(opp, 'phone')) as string | null;
      const rawEmail = (pick(body, 'email', 'contact.email', 'payload.email') ?? pick(opp, 'email')) as string | null;
      const cel = phone9(rawPhone);
      const ema = normEmail(rawEmail);

      if (cel) {
        const r = await supabase
          .from('prospectos')
          .select('id, etapa_actual, asesor_id')
          .eq('celular', cel)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!r.error && r.data) p = r.data;
      }
      if (!p && ema) {
        const r = await supabase
          .from('prospectos')
          .select('id, etapa_actual, asesor_id')
          .eq('email', ema)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!r.error && r.data) p = r.data;
      }
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
    if (!asesorId) asesorId = p.asesor_id ?? null;

    // Resolver etapa
    const resolved = await resolveStageByName(String(stageNameRaw));
    if (!resolved) {
      const out = { ok: true, skip: 'STAGE_NOT_MAPPED' as const, stageNameRaw };
      return res.status(200).json(debug ? { ...out } : out);
    }

    const toStage = resolved.stage;
    const fromStage = p.etapa_actual ?? null;
    const now = new Date().toISOString();

    // Si no hay cambio real de etapa (p.ej. PROSPECCIÓN -> PROSPECCIÓN), no insertes fila
    let skipInsert = fromStage === toStage;

    // Dedupe adicional (≤60s con misma transición)
    if (!skipInsert) {
      const { data: last } = await supabase
        .from('prospecto_stage_history')
        .select('from_stage, to_stage, changed_at')
        .eq('prospecto_id', p.id)
        .order('changed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (last) {
        const isSame = last.from_stage === fromStage && last.to_stage === toStage;
        const lastAt = last.changed_at ? new Date(last.changed_at).getTime() : 0;
        const within60s = lastAt > 0 && Math.abs(Date.now() - lastAt) <= 60_000;
        skipInsert = isSame && within60s;
      }
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

    // Actualiza prospecto
    const patch: Record<string, any> = {
      etapa_actual: toStage,
      stage_changed_at: now,
      updated_at: now,
    };
    if (asesorId && asesorId !== p.asesor_id) patch.asesor_id = asesorId;

    await supabase.from('prospectos').update(patch).eq('id', p.id);

    return res.status(200).json(
      debug
        ? { ok: true, opportunityId, fromStage, toStage, asesorId, saved: !skipInsert, locOk }
        : { ok: true }
    );
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}