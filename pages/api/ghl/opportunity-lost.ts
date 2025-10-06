/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// helper recursivo que busca una key en cualquier parte del objeto
function deepFind(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return null;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = deepFind(obj[k], key);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    const body: any = req.body || {};
    const echo = req.query.debug === '1';

    // buscar campos sin importar dónde estén
    const source              = deepFind(body, 'source');
    const prospecto_id        = deepFind(body, 'prospecto_id');
    const opc_id              = deepFind(body, 'opc_id');
    const asesor_id           = deepFind(body, 'asesor_id');
    const hl_opportunity_id   = deepFind(body, 'hl_opportunity_id');
    const hl_pipeline         = deepFind(body, 'hl_pipeline');
    const hl_stage            = deepFind(body, 'hl_stage');
    const razon_no_interesado = deepFind(body, 'razon_no_interesado');
    const razon_no_contactable= deepFind(body, 'razon_no_contactable');
    const fecha_raw           = deepFind(body, 'fecha_cambio');

    if (!source || !['no_interesado', 'no_contactable'].includes(String(source))) {
      return res.status(200).json({ ok: true, skip: 'INVALID_SOURCE', received: echo ? body : undefined });
    }
    if (!prospecto_id || !opc_id || !asesor_id) {
      return res.status(200).json({ ok: true, skip: 'MISSING_FOREIGN_KEYS', received: echo ? body : undefined });
    }

    const fecha_cambio = fecha_raw ? new Date(String(fecha_raw)).toISOString() : new Date().toISOString();

    const { error } = await supabase.from('oportunidades_perdidas').insert({
      prospecto_id,
      opc_id,
      asesor_id,
      hl_opportunity_id: hl_opportunity_id ?? null,
      hl_pipeline: hl_pipeline ?? null,
      hl_stage: hl_stage ?? null,
      fuente: String(source),
      razon_no_interesado: razon_no_interesado ?? null,
      razon_no_contactable: razon_no_contactable ?? null,
      fecha_cambio,
      raw: body,
    });

    if (error) return res.status(200).json({ ok: true, saved: false, error: error.message, received: echo ? body : undefined });
    return res.status(200).json({ ok: true, saved: true, received: echo ? body : undefined });
  } catch (e: any) {
    return res.status(200).json({ ok: true, saved: false, error: e.message || String(e) });
  }
}