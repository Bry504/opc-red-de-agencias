/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

/**
 * /api/ghl/owner-change
 * Webhook de HighLevel para cambio de dueño de una oportunidad.
 * - Requiere opportunityId y assignedUserId (id HL del nuevo dueño).
 * - Actualiza prospectos.asesor_id + updated_at
 * - Propaga asesor_id a TODAS las filas de prospecto_stage_history de ese prospecto.
 */

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// opcional: validar que el webhook venga de tu Location
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';

/* ---------------- helpers ---------------- */

function pick(obj: any, ...keys: string[]) {
  for (const k of keys) {
    if (!obj) break;
    if (k.includes('.')) {
      const parts = k.split('.');
      let cur: any = obj;
      let ok = true;
      for (const p of parts) {
        if (cur && p in cur) cur = cur[p];
        else {
          ok = false;
          break;
        }
      }
      if (ok && cur != null) return cur;
    } else if (obj?.[k] != null) {
      return obj[k];
    }
  }
  return null;
}

function coerceId(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && v.id != null) return String(v.id);
  return null;
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

    // (opcional) validar Location-Id
    const locationId =
      pick(body, 'locationId', 'Location-Id', 'customData.locationId') ??
      pick(req.headers, 'location-id') ??
      null;
    const locOk = GHL_LOCATION_ID ? (locationId || '') === GHL_LOCATION_ID : true;

    // opportunityId puede venir arriba, en opportunity, o en customData
    const opportunityId: string | undefined =
      coerceId(pick(body, 'opportunityId', 'customData.opportunityId')) ??
      coerceId(pick(opp, 'id')) ??
      undefined;

    if (!opportunityId) {
      const out = { ok: true, skip: 'NO_OPPORTUNITY_ID' as const };
      return res.status(200).json(debug ? { ...out, body } : out);
    }

    // assignedUserId puede venir como user.id, opportunity.assignedTo.id, etc.
    const assignedUserId: string | null =
      coerceId(
        pick(
          body,
          'assignedUserId',
          'userId',
          'user.id',
          'customData.assignedUserId',
          'assigned_to',
          'assigned_to.id',
          'assignedTo',
          'assignedTo.id'
        )
      ) ??
      coerceId(
        pick(
          opp,
          'assignedUserId',
          'userId',
          'user.id',
          'assigned_to',
          'assigned_to.id',
          'assignedTo',
          'assignedTo.id'
        )
      );

    if (!assignedUserId) {
      const out = { ok: true, skip: 'NO_ASSIGNED_USER' as const, opportunityId, locOk };
      return res.status(200).json(debug ? out : { ok: true, skip: 'NO_ASSIGNED_USER' });
    }

    // Buscar prospecto por oportunidad HL
    const { data: p, error: eP } = await supabase
      .from('prospectos')
      .select('id, asesor_id')
      .eq('hl_opportunity_id', opportunityId)
      .maybeSingle();

    if (eP) {
      const out = { ok: true, skip: 'SELECT_ERROR' as const, opportunityId };
      return res.status(200).json(debug ? { ...out, eP } : out);
    }
    if (!p) {
      const out = { ok: true, skip: 'PROSPECT_NOT_FOUND' as const, opportunityId };
      return res.status(200).json(out);
    }

    // Mapear HL user -> asesores.id
    const { data: a } = await supabase
      .from('asesores')
      .select('id')
      .eq('hl_user_id', String(assignedUserId))
      .maybeSingle();

    if (!a?.id) {
      const out = { ok: true, skip: 'ASESOR_NOT_FOUND' as const, assignedUserId };
      return res.status(200).json(out);
    }

    const now = new Date().toISOString();
    const newAsesorId = a.id;

    // Actualizar prospectos (si ya es el mismo, igual refrescamos updated_at)
    await supabase
      .from('prospectos')
      .update({ asesor_id: newAsesorId, updated_at: now })
      .eq('id', p.id);

    // Propagar a TODO el historial de ese prospecto
    await supabase
      .from('prospecto_stage_history')
      .update({ asesor_id: newAsesorId })
      .eq('prospecto_id', p.id);

    return res.status(200).json(
      debug
        ? {
            ok: true,
            opportunityId,
            newAsesorId,
            locOk,
            patchedProspect: true,
            patchedHistory: true,
          }
        : { ok: true }
    );
  } catch (e: any) {
    return res.status(200).json({ ok: true, handled: false, error: e?.message || String(e) });
  }
}