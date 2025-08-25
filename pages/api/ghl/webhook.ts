/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// HL envs
const GHL_LOCATION_ID  = process.env.GHL_LOCATION_ID ?? '';
const GHL_ACCESS_TOKEN = process.env.GHL_ACCESS_TOKEN ?? process.env.GHL_TOKEN ?? '';

// -------- helpers HL ----------
async function fetchOpportunityFromHL(opportunityId: string) {
  if (!GHL_ACCESS_TOKEN || !GHL_LOCATION_ID) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${GHL_ACCESS_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Version: '2021-07-28',
    'Location-Id': GHL_LOCATION_ID,
  };

  const urls = [
    `https://services.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
    `https://api.leadconnectorhq.com/opportunities/${encodeURIComponent(opportunityId)}`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j) return j;
      }
    } catch (e) {
      // try next url
    }
  }
  return null;
}

function extractAssignedUserId(obj: any): string | null {
  // Intenta todas las variantes conocidas
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

function pick(body: any, ...keys: string[]) {
  for (const k of keys) {
    const v = body?.[k];
    if (v != null) return v;
  }
  return null;
}

// -------------------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // health
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

    // 1) OpportunityId
    const opportunityId: string | undefined =
      pick(body, 'opportunityId') ??
      opp?.id ??
      undefined;

    if (!opportunityId) {
      const out = { ok: true, skip: 'NO_OPPORTUNITY_ID' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // 2) AssignedUserId (payload primero)
    let assignedUserId =
      pick(body, 'assignedUserId', 'userId') ??
      extractAssignedUserId(opp);

    // 3) Si no vino, intenta leer desde HL con token+location
    let hlFetchTried = false;
    let hlFetchOk = false;
    let hlRaw: any = null;
    if (!assignedUserId && GHL_ACCESS_TOKEN && GHL_LOCATION_ID) {
      hlFetchTried = true;
      hlRaw = await fetchOpportunityFromHL(opportunityId);
      if (hlRaw) {
        assignedUserId = extractAssignedUserId(hlRaw);
        hlFetchOk = Boolean(assignedUserId);
      }
    }

    if (!assignedUserId) {
      const out = {
        ok: true,
        skip: 'NO_ASSIGNED_USER' as const,
        debug: debug ? {
          env: { hasToken: !!GHL_ACCESS_TOKEN, hasLocation: !!GHL_LOCATION_ID },
          hlFetchTried, hlFetchOk, hlSample: hlRaw?.opportunity ? 'opportunity-present' : (hlRaw ? 'some-json' : 'null'),
        } : undefined,
      };
      return res.status(200).json(out);
    }

    // 4) Busca el prospecto por hl_opportunity_id
    const { data: prospect, error: eProspect } = await supabase
      .from('prospectos')
      .select('id, asesor_id, hl_opportunity_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (eProspect) {
      const out = { ok: true, skip: 'SELECT_ERROR' as const };
      return res.status(200).json(debug ? { ...out, eProspect } : out);
    }
    if (!prospect) {
      const out = { ok: true, skip: 'PROSPECT_NOT_FOUND' as const, opportunityId };
      return res.status(200).json(out);
    }

    // 5) Mapea HL user -> asesores.id
    const { data: asesor } = await supabase
      .from('asesores')
      .select('id')
      .eq('hl_user_id', String(assignedUserId))
      .maybeSingle();

    if (!asesor?.id) {
      const out = { ok: true, skip: 'ASESOR_NOT_FOUND' as const, assignedUserId };
      return res.status(200).json(out);
    }

    // 6) Actualiza prospecto si cambió
    let updatedProspect = false;
    if (asesor.id !== prospect.asesor_id) {
      const { error: upErr } = await supabase
        .from('prospectos')
        .update({ asesor_id: asesor.id, updated_at: new Date().toISOString() })
        .eq('id', prospect.id);
      updatedProspect = !upErr;
    }

    const out = {
      ok: true,
      opportunityId,
      assignedUserId,
      asesorId: asesor.id,
      updatedProspect,
      foundBy: 'opportunity',
    };
    return res.status(200).json(out);
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}