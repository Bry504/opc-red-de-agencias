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

  for (const u of urls) {
    const r = await fetchHL(u, withLocation);
    if (r.ok) return r;
    last = r;
  }
  for (const u of urls) {
    const r = await fetchHL(u, baseHeaders);
    if (r.ok) return r;
    last = r;
  }
  return last;
}

/* ------------- utils ------------- */
function normEmail(v?: string | null) {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, '') || null;
}
function phone9(v?: string | null) {
  const s = (v ?? '').replace(/\D/g, '');
  if (!s) return null;
  return s.slice(-9) || null;
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
/* ---------------------------------- */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (['GET','HEAD','OPTIONS'].includes(req.method || '')) {
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

    const opportunityId: string | undefined =
      coerceId(pick(body, 'opportunityId')) ?? coerceId(opp?.id) ?? undefined;

    if (!opportunityId) {
      const out = { ok: true, skip: 'NO_OPPORTUNITY_ID' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // 1) intentar obtener assignedUserId del payload (maneja id u objeto)
    let assignedUserId: string | null =
      coerceId(pick(body, 'assignedUserId', 'userId')) ?? extractAssignedUserId(opp);

    let hlFetchTried = false;
    let hlFetchOk = false;
    let hlStatus: number | undefined = undefined;
    let hlTextStart: string | null | undefined = undefined;

    // 2) si no vino, consulta HL
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

    /* 3) Buscar prospecto
          a) por hl_opportunity_id
          b) Fallback por teléfono/email del payload estándar (evita la carrera al crear) */
    let prospect:
      | { id: number; asesor_id: string | null; hl_opportunity_id: string | null; etapa_actual: string | null }
      | null = null;

    const byOpp = await supabase
      .from('prospectos')
      .select('id, asesor_id, hl_opportunity_id, etapa_actual')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();
    if (!byOpp.error && byOpp.data) prospect = byOpp.data;

    if (!prospect) {
      const rawPhone = (pick(body, 'phone', 'contact.phone', 'payload.phone', 'customData.phone') ?? pick(opp, 'phone')) as string | null;
      const rawEmail = (pick(body, 'email', 'contact.email', 'payload.email', 'customData.email') ?? pick(opp, 'email')) as string | null;
      const cel = phone9(rawPhone);
      const ema = normEmail(rawEmail);

      if (cel) {
        const r = await supabase
          .from('prospectos')
          .select('id, asesor_id, hl_opportunity_id, etapa_actual')
          .eq('celular', cel)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!r.error && r.data) prospect = r.data;
      }
      if (!prospect && ema) {
        const r = await supabase
          .from('prospectos')
          .select('id, asesor_id, hl_opportunity_id, etapa_actual')
          .eq('email', ema)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!r.error && r.data) prospect = r.data;
      }
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

    const nowIso = new Date().toISOString();
    const currStage = prospect.etapa_actual ?? null;

    // 5) actualizar prospecto si cambió el asesor
    let updatedProspect = false;
    if (asesor.id !== prospect.asesor_id) {
      const { error: upErr } = await supabase
        .from('prospectos')
        .update({ asesor_id: asesor.id, updated_at: nowIso })
        .eq('id', prospect.id);
      updatedProspect = !upErr;
    }

    // 6) Completar asesor_id en la PRIMERA fila del historial (SYSTEM) si está NULL.
    let historyAction: 'updated_first' | 'inserted_first' | 'noop' = 'noop';

    const { data: firstHist } = await supabase
      .from('prospecto_stage_history')
      .select('id, asesor_id, source')
      .eq('prospecto_id', prospect.id)
      .order('changed_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (firstHist) {
      if (!firstHist.asesor_id) {
        const { error: upHistErr } = await supabase
          .from('prospecto_stage_history')
          .update({ asesor_id: asesor.id })
          .eq('id', firstHist.id);
        historyAction = upHistErr ? 'noop' : 'updated_first';
      }
    } else {
      // caso extremo: crear la primera fila SYSTEM una sola vez
      const { error: insErr } = await supabase.from('prospecto_stage_history').insert([{
        prospecto_id: prospect.id,
        hl_opportunity_id: opportunityId,
        from_stage: null,
        to_stage: currStage,
        changed_at: nowIso,
        asesor_id: asesor.id,
        source: 'SYSTEM',
      }]);
      historyAction = insErr ? 'noop' : 'inserted_first';
    }

    // Nada de filas "ASSIGN": sin duplicación.
    return res.status(200).json({
      ok: true,
      opportunityId,
      assignedUserId,
      asesorId: asesor.id,
      updatedProspect,
      historyAction,
    });
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}