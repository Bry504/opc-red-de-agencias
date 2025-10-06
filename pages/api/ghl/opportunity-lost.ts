/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// helper para leer rutas anidadas tipo "customData.source"
function pick(obj: any, ...paths: string[]) {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p.split('.')) {
      if (cur && k in cur) cur = cur[k];
      else { ok = false; break; }
    }
    if (ok && cur != null) return cur;
  }
  return null;
}

type Src = 'no_interesado' | 'no_contactable';

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

    const body: any = req.body || {};
    const echo = String(req.query.debug ?? '').trim() === '1'; // prueba: ?debug=1

    // Lee desde nivel raíz o desde customData.*
    const source = (pick(body, 'source', 'customData.source') ?? '') as string;
    const prospecto_id = pick(body, 'prospecto_id', 'customData.prospecto_id');
    const opc_id       = pick(body, 'opc_id', 'customData.opc_id');
    const asesor_id    = pick(body, 'asesor_id', 'customData.asesor_id');
    const hl_opportunity_id = pick(body, 'hl_opportunity_id', 'customData.hl_opportunity_id');
    const hl_pipeline  = pick(body, 'hl_pipeline', 'customData.hl_pipeline');
    const hl_stage     = pick(body, 'hl_stage', 'customData.hl_stage');

    const razon_no_interesado  = pick(body, 'razon_no_interesado', 'customData.razon_no_interesado');
    const razon_no_contactable = pick(body, 'razon_no_contactable', 'customData.razon_no_contactable');
    const fecha_raw            = pick(body, 'fecha_cambio', 'customData.fecha_cambio');

    // Validaciones mínimas de negocio
    if (!source || !['no_interesado', 'no_contactable'].includes(source)) {
      return res.status(200).json({ ok: true, skip: 'INVALID_SOURCE', received: echo ? body : undefined });
    }
    if (!prospecto_id || !opc_id || !asesor_id) {
      return res.status(200).json({ ok: true, skip: 'MISSING_FOREIGN_KEYS', received: echo ? body : undefined });
    }
    if (source === 'no_interesado' && !razon_no_interesado) {
      return res.status(200).json({ ok: true, skip: 'MISSING_RAZON_NO_INTERESADO', received: echo ? body : undefined });
    }
    if (source === 'no_contactable' && !razon_no_contactable) {
      return res.status(200).json({ ok: true, skip: 'MISSING_RAZON_NO_CONTACTABLE', received: echo ? body : undefined });
    }

    const fecha_cambio = fecha_raw ? new Date(String(fecha_raw)).toISOString() : new Date().toISOString();

    const { error } = await supabase.from('oportunidades_perdidas').insert({
      prospecto_id,
      opc_id,
      asesor_id,
      hl_opportunity_id: hl_opportunity_id ?? null,
      hl_pipeline: hl_pipeline ?? null,
      hl_stage: hl_stage ?? null,
      fuente: source as Src,
      razon_no_interesado: razon_no_interesado ?? null,
      razon_no_contactable: razon_no_contactable ?? null,
      fecha_cambio,
      raw: body, // guarda todo el payload para auditoría
    });

    if (error) return res.status(200).json({ ok: true, saved: false, error: error.message, received: echo ? body : undefined });

    return res.status(200).json({ ok: true, saved: true, received: echo ? body : undefined });
  } catch (e: any) {
    return res.status(200).json({ ok: true, saved: false, error: e?.message || String(e) });
  }
}