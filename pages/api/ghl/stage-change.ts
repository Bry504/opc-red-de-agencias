/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GHL_ACCESS_TOKEN = process.env.GHL_ACCESS_TOKEN ?? process.env.GHL_TOKEN ?? '';
const GHL_LOCATION_ID  = process.env.GHL_LOCATION_ID ?? '';

type HLFetchResult = { ok:boolean; json?:any; status?:number; textStart?:string|null };

// -------- helpers ----------
const norm = (s?:string|null) =>
  (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();

const pick = (obj:any, ...keys:string[]) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null) return v;
  }
  return null;
};

async function fetchHL(url: string, headers: Record<string,string>): Promise<HLFetchResult> {
  try {
    const r = await fetch(url, { headers });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      return { ok: true, json: j, status: r.status, textStart: null };
    } else {
      const t = await r.text().catch(() => '');
      return { ok: false, status: r.status, textStart: t?.slice(0,200) ?? null };
    }
  } catch {
    return { ok: false, status: undefined, textStart: null };
  }
}

async function fetchOpportunityFromHL(opportunityId: string): Promise<HLFetchResult> {
  if (!GHL_ACCESS_TOKEN) return { ok: false };

  const base: Record<string,string> = {
    Authorization: `Bearer ${GHL_ACCESS_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
  const withLocation = GHL_LOCATION_ID ? { ...base, 'Location-Id': GHL_LOCATION_ID } : base;

  const urls = [
    `https://services.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
    `https://api.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
  ];

  let last: HLFetchResult | undefined;
  for (const u of urls) { const r = await fetchHL(u, withLocation); if (r.ok) return r; last = r; }
  for (const u of urls) { const r = await fetchHL(u, base);         if (r.ok) return r; last = r; }
  return last ?? { ok:false };
}

function extractAssignedUserId(obj:any): string | null {
  const cands = [
    obj?.assignedUserId, obj?.userId,
    obj?.assigned_to?.id, obj?.assignedTo?.id,
    obj?.opportunity?.assignedTo?.id,
    obj?.opportunity?.assignedUserId,
    obj?.data?.assignedUserId, obj?.result?.assignedUserId,
  ].filter(Boolean);
  return cands.length ? String(cands[0]) : null;
}

function extractStageName(anyBody:any): string | null {
  // 1) nombres directos
  const byKey = pick(anyBody, 'stageName', 'pipelineStageName');
  if (byKey) return String(byKey);

  // 2) estructuras comunes
  const opp = anyBody?.opportunity ?? anyBody?.payload?.opportunity ?? anyBody;
  const cands = [
    opp?.stage_name,
    opp?.stageName,
    opp?.stage?.name,
    anyBody?.stage_name,
  ].filter(Boolean);
  return cands.length ? String(cands[0]) : null;
}

// -------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // health
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
    return res.status(200).json({ ok:true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
    return res.status(405).json({ ok:false, error:'METHOD_NOT_ALLOWED' });
  }

  const debug = String(req.headers['x-debug'] || '').trim() === '1';

  try {
    const body:any = req.body || {};
    const opp = body.opportunity ?? body.payload?.opportunity ?? body;

    const opportunityId: string | undefined =
      pick(body, 'opportunityId') ?? opp?.id ?? undefined;
    if (!opportunityId) {
      const out = { ok:true, skip:'NO_OPPORTUNITY_ID' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // -------- resolver etapa --------
    let stageNameRaw = extractStageName(body);
    let lookedHL = false, lookedOk = false, lookedStatus: number|undefined, lookedText: string|null|undefined;

    if (!stageNameRaw) {
      lookedHL = true;
      const r = await fetchOpportunityFromHL(opportunityId);
      lookedStatus = r.status; lookedText = r.textStart;
      if (r.ok && r.json) {
        stageNameRaw = extractStageName(r.json);
        lookedOk = Boolean(stageNameRaw);
      }
    }
    if (!stageNameRaw) {
      const out = { ok:true, skip:'NO_STAGE_NAME' as const,
        debug: debug ? { lookedHL, lookedOk, lookedStatus, lookedText } : undefined
      };
      return res.status(200).json(out);
    }

    const stageWant = norm(stageNameRaw);

    // -------- mapear a nombre canónico usando pipeline_stages --------
    let newStage: string | null = null;
    {
      const { data: allStages } = await supabase
        .from('pipeline_stages')
        .select('stage, etapas');

      if (allStages?.length) {
        for (const r of allStages) {
          const n1 = norm(r.stage);
          const n2 = norm(r.etapas);
          if (n1 === stageWant || n2 === stageWant) { newStage = r.stage; break; }
        }
      }
    }
    if (!newStage) newStage = stageNameRaw; // fallback: usa lo recibido

    // -------- prospecto --------
    const { data: p } = await supabase
      .from('prospectos')
      .select('id, etapa_actual, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (!p) return res.status(200).json({ ok:true, skip:'PROSPECT_NOT_FOUND', opportunityId });

    // -------- resolver asesor --------
    const assignedUserId = extractAssignedUserId(body) ?? extractAssignedUserId(opp);
    let asesorId: string | null = p.asesor_id ?? null;

    if (assignedUserId) {
      const { data: a } = await supabase
        .from('asesores').select('id').eq('hl_user_id', String(assignedUserId)).maybeSingle();
      if (a?.id) asesorId = a.id;
    }

    const fromStage = p.etapa_actual ?? null;
    const toStage   = newStage;

    // dedupe rápido (mismo movimiento ≤60s)
    const { data: last } = await supabase
      .from('prospecto_stage_history')
      .select('from_stage, to_stage, changed_at')
      .eq('prospecto_id', p.id)
      .order('changed_at', { ascending:false })
      .limit(1)
      .maybeSingle();

    const lastFrom = last?.from_stage ?? null;
    const lastTo   = last?.to_stage ?? null;
    const lastAt   = last?.changed_at ? new Date(last.changed_at).getTime() : 0;
    const isSame   = lastFrom === fromStage && lastTo === toStage;
    const within60 = lastAt > 0 && Math.abs(Date.now() - lastAt) <= 60_000;

    // -------- inserta historia (si procede) --------
    if (!(isSame && within60)) {
      await supabase.from('prospecto_stage_history').insert([{
        prospecto_id: p.id,
        hl_opportunity_id: opportunityId,
        from_stage: fromStage,
        to_stage: toStage,
        changed_at: new Date().toISOString(),
        source: 'WEBHOOK_HL',
        asesor_id: asesorId,
      }]);
    }

    // -------- actualiza prospecto --------
    const patch: Record<string,any> = {
      etapa_actual: toStage,
      stage_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (asesorId && asesorId !== p.asesor_id) patch.asesor_id = asesorId;

    await supabase.from('prospectos').update(patch).eq('id', p.id);

    return res.status(200).json({
      ok: true,
      opportunityId,
      stageNameRaw,
      resolvedStage: toStage,
      fromStage,
      asesorId,
    });

  } catch (e:any) {
    return res.status(200).json({ ok:true, handled:false, error: e?.message || String(e) });
  }
}