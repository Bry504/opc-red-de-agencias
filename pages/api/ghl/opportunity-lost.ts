/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type Body = {
  source: 'no_interesado' | 'no_contactable';
  fecha_cambio?: string;
  prospecto_id: string; // uuid
  opc_id: string;       // uuid
  asesor_id: string;    // uuid
  hl_opportunity_id?: string;
  hl_pipeline?: string;
  hl_stage?: string;
  razon_no_interesado?: string | null;
  razon_no_contactable?: string | null;
  raw?: any;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || '')) {
      res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    const body = (req.body || {}) as Body;

    // Validaciones mínimas de negocio
    if (!body?.source || !['no_interesado', 'no_contactable'].includes(body.source)) {
      return res.status(200).json({ ok: true, skip: 'INVALID_SOURCE' });
    }
    if (!body?.prospecto_id || !body?.opc_id || !body?.asesor_id) {
      return res.status(200).json({ ok: true, skip: 'MISSING_FOREIGN_KEYS' });
    }
    if (body.source === 'no_interesado' && !body.razon_no_interesado) {
      return res.status(200).json({ ok: true, skip: 'MISSING_RAZON_NO_INTERESADO' });
    }
    if (body.source === 'no_contactable' && !body.razon_no_contactable) {
      return res.status(200).json({ ok: true, skip: 'MISSING_RAZON_NO_CONTACTABLE' });
    }

    const fecha_cambio = body.fecha_cambio
      ? new Date(body.fecha_cambio).toISOString()
      : new Date().toISOString();

    const { error } = await supabase.from('oportunidades_perdidas').insert({
      prospecto_id: body.prospecto_id,
      opc_id: body.opc_id,
      asesor_id: body.asesor_id,
      hl_opportunity_id: body.hl_opportunity_id ?? null,
      hl_pipeline: body.hl_pipeline ?? null,
      hl_stage: body.hl_stage ?? null,
      fuente: body.source,
      razon_no_interesado: body.razon_no_interesado ?? null,
      razon_no_contactable: body.razon_no_contactable ?? null,
      fecha_cambio,
      raw: body.raw ?? body,
    });

    if (error) return res.status(200).json({ ok: true, saved: false, error: error.message });

    return res.status(200).json({ ok: true, saved: true });
  } catch (e: any) {
    return res.status(200).json({ ok: true, saved: false, error: e?.message || String(e) });
  }
}