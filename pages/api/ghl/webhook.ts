/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const GHL_LOCATION_ID  = process.env.GHL_LOCATION_ID ?? '';
const GHL_ACCESS_TOKEN = process.env.GHL_ACCESS_TOKEN ?? process.env.GHL_TOKEN ?? '';

type HLFetchResult = {
  ok: boolean;
  json?: any;
  status?: number;
  textStart?: string | null;
};

async function fetchHL(url: string, headers: Record<string,string>): Promise<HLFetchResult> {
  try {
    const r = await fetch(url, { headers });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      return { ok: true, json: j, status: r.status, textStart: null };
    } else {
      const t = await r.text().catch(() => '');
      return { ok: false, status: r.status, textStart: t?.slice(0, 200) ?? null };
    }
  } catch {
    return { ok: false, status: undefined, textStart: null };
  }
}

async function fetchOpportunityFromHL(opportunityId: string): Promise<HLFetchResult> {
  if (!GHL_ACCESS_TOKEN) return { ok: false };

  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${GHL_ACCESS_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
  const withLocation = GHL_LOCATION_ID
    ? { ...baseHeaders, 'Location-Id': GHL_LOCATION_ID }
    : baseHeaders;

  const urls = [
    `https://services.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
    `https://api.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
  ];

  let last: HLFetchResult = { ok: false };

  // 1) con Location-Id
  for (const u of urls) {
    const r = await fetchHL(u, withLocation);
    if (r.ok) return r;
    last = r;
  }
  // 2) sin Location-Id
  for (const u of urls) {
    const r = await fetchHL(u, baseHeaders);
    if (r.ok) return r;
    last = r;
  }
  return last;
}

// --- utils -----------------------------------------

function coerceId(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && v.id != null) return String(v.id);
  return null;
}

function extractAssignedUserId(obj: any): string | null {
  const cands = [
    coerceId(obj?.assignedUserId),
    coerceId(obj?.userId),
    coerceId(obj?.assigned_to),
    coerceId(obj?.assigned_to?.id),
    coerceId(obj?.assignedTo),
    coerceId(obj?.assignedTo?.id),
    coerceId(obj?.opportunity?.assignedTo),
    coerceId(obj?.opportunity?.assignedTo?.id),
    coerceId(obj?.opportunity?.assignedUserId),
    coerceId(obj?.data?.assignedUserId),
    coerceId(obj?.result?.assignedUserId),
  ].filter(Boolean) as string[];
  return cands.length ? cands[0] : null;
}

function pick(body: any, ...keys: string[]) {
  for (const k of keys) {
    const v = body?.[k];
    if (v != null) return v;
  }
  return null;
}

// ---------------------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const debug = String(req.headers['x-debug'] || '').trim() === '1';

  try {
    const body: any = req.body || {};
    const opp = body.opportunity ?? body.payload?.opportunity ?? body;

    // id de la oportunidad
    const opportunityId: string | undefined =
      coerceId(pick(body, 'opportunityId')) ?? coerceId(opp?.id) ?? undefined;

    if (!opportunityId) {
      const out = { ok: true, skip: 'NO_OPPORTUNITY_ID' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // 1) intentar sacar assignedUserId del payload (incluyendo si viene como objeto)
    let assignedUserId: string | null =
      coerceId(pick(body, 'assignedUserId')) ??
      coerceId(pick(body, 'userId')) ??
      extractAssignedUserId(opp);

    // indicadores de debug para la consulta HL
    let hlFetchTried = false;
    let hlFetchOk = false;
    let hlStatus: number | undefined = undefined;
    let hlTextStart: string | null | undefined = undefined;

    // 2) si no vino el assigned, consulta HL por la oportunidad
    if (!assignedUserId) {
      hlFetchTried = true;
      const r = await fetchOpportunityFromHL(opportunityId);
      hlStatus = r.status;
      hlTextStart = r.textStart;
      if (r.ok && r.json) {
        assignedUserId = extractAssignedUserId(r.json);
        hlFetchOk = Boolean(assignedUserId);
      }
    }

    // si aún no se pudo obtener, salir silenciosamente
    if (!assignedUserId) {
      const out = {
        ok: true,
        skip: 'NO_ASSIGNED_USER' as const,
        debug: debug ? {
          env: { hasToken: !!GHL_ACCESS_TOKEN, hasLocation: !!GHL_LOCATION_ID },
          hlFetchTried, hlFetchOk, hlStatus, hlTextStart,
        } : undefined,
      };
      return res.status(200).json(out);
    }

    // 3) buscar el prospecto por opportunity id (ahora también traemos etapa_actual)
    const { data: prospect, error: ePros } = await supabase
      .from('prospectos')
      .select('id, asesor_id, hl_opportunity_id, etapa_actual')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (ePros) {
      const out = { ok: true, skip: 'SELECT_ERROR' as const };
      return res.status(200).json(debug ? { ...out, ePros } : out);
    }
    if (!prospect) {
      const out = { ok: true, skip: 'PROSPECT_NOT_FOUND' as const, opportunityId };
      return res.status(200).json(out);
    }

    // 4) mapear HL user -> asesores.id
    const { data: asesor } = await supabase
      .from('asesores')
      .select('id')
      .eq('hl_user_id', String(assignedUserId))
      .maybeSingle();

    if (!asesor?.id) {
      const out = { ok: true, skip: 'ASESOR_NOT_FOUND' as const, assignedUserId };
      return res.status(200).json(out);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const currStage = prospect.etapa_actual ?? null;

    // 5) actualizar prospecto sólo si cambió el asesor
    let updatedProspect = false;
    if (asesor.id !== prospect.asesor_id) {
      const { error: upErr } = await supabase
        .from('prospectos')
        .update({ asesor_id: asesor.id, updated_at: nowIso })
        .eq('id', prospect.id);
      updatedProspect = !upErr;
    }

    // 6) registrar en historial (misma etapa) sólo si hubo cambio de asesor
    if (updatedProspect) {
      // dedupe simple: evita duplicar si el último registro es igual en ≤ 60s
      const { data: last } = await supabase
        .from('prospecto_stage_history')
        .select('from_stage,to_stage,changed_at,asesor_id')
        .eq('prospecto_id', prospect.id)
        .order('changed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let shouldInsert = true;
      if (last) {
        const same =
          (last.from_stage ?? null) === currStage &&
          (last.to_stage ?? null) === currStage &&
          (last.asesor_id ?? null) === asesor.id;
        const lastAt = last.changed_at ? new Date(last.changed_at).getTime() : 0;
        const within60s = lastAt > 0 && Math.abs(now.getTime() - lastAt) <= 60_000;
        if (same && within60s) shouldInsert = false;
      }

      if (shouldInsert) {
        await supabase.from('prospecto_stage_history').insert([{
          prospecto_id: prospect.id,
          hl_opportunity_id: opportunityId,
          from_stage: currStage,
          to_stage: currStage,
          changed_at: nowIso,
          asesor_id: asesor.id,
          source: 'ASSIGN', // o 'WEBHOOK_HL', como prefieras etiquetar
        }]);
      }
    }

    return res.status(200).json({
      ok: true,
      opportunityId,
      assignedUserId,
      asesorId: asesor.id,
      updatedProspect,
      insertedHistory: updatedProspect, // true si se intentó insertar historial
      foundBy: 'payload_or_hl',
    });
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}