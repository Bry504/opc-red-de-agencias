/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Convierte array de pares a objeto plano */
function kvArrayToObject(arr: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    const k = item?.key ?? item?.name ?? item?.Key ?? item?.Name;
    const v = item?.value ?? item?.Value ?? item?.val ?? item?.Val;
    if (k != null) out[String(k)] = v;
  }
  return out;
}

/** Busca una key recursivamente; si encuentra customData como array lo normaliza */
function deepFind(obj: any, key: string): any {
  if (obj == null) return null;
  if (typeof obj !== 'object') return null;
  if (key in obj) return obj[key];

  // normaliza customData si es array de pares
  if ('customData' in obj && Array.isArray(obj.customData)) {
    try {
      const normalized = kvArrayToObject(obj.customData);
      if (key in normalized) return normalized[key];
      // por si hay anidaciones, sigue buscando
      const val = deepFind(normalized, key);
      if (val != null) return val;
    } catch {}
  }

  for (const k of Object.keys(obj)) {
    const child = obj[k];
    const found = deepFind(child, key);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

/** Si el body es string (urlencoded/RAW), intenta JSON.parse */
function ensureObjectBody(req: NextApiRequest): any {
  const b: any = req.body ?? {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return { raw: b }; }
  }
  return b;
}

type Src = 'no_interesado' | 'no_contactable';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (['GET','HEAD','OPTIONS'].includes(req.method || '')) {
      res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST,GET,HEAD,OPTIONS');
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    const echo = String(req.query.debug ?? '') === '1';
    const body = ensureObjectBody(req);

    // 1) Saca datos sin importar cómo vengan
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

    // 2) Validaciones de negocio
    if (!source || !['no_interesado','no_contactable'].includes(String(source))) {
      return res.status(200).json({ ok: true, skip: 'INVALID_SOURCE', received: echo ? body : undefined });
    }
    if (!prospecto_id || !opc_id || !asesor_id) {
      return res.status(200).json({ ok: true, skip: 'MISSING_FOREIGN_KEYS', received: echo ? body : undefined });
    }
    if (String(source) === 'no_interesado' && !razon_no_interesado) {
      return res.status(200).json({ ok: true, skip: 'MISSING_RAZON_NO_INTERESADO', received: echo ? body : undefined });
    }
    if (String(source) === 'no_contactable' && !razon_no_contactable) {
      return res.status(200).json({ ok: true, skip: 'MISSING_RAZON_NO_CONTACTABLE', received: echo ? body : undefined });
    }

    const fecha_cambio = fecha_raw ? new Date(String(fecha_raw)).toISOString() : new Date().toISOString();

    // 3) Inserta
    const { error } = await supabase.from('oportunidades_perdidas').insert({
      prospecto_id,
      opc_id,
      asesor_id,
      hl_opportunity_id: hl_opportunity_id ?? null,
      hl_pipeline: hl_pipeline ?? null,
      hl_stage: hl_stage ?? null,
      fuente: String(source) as Src,
      razon_no_interesado: razon_no_interesado ?? null,
      razon_no_contactable: razon_no_contactable ?? null,
      fecha_cambio,
      raw: body,
    });

    if (error) return res.status(200).json({ ok: true, saved: false, error: error.message, received: echo ? body : undefined });
    return res.status(200).json({ ok: true, saved: true, received: echo ? body : undefined });
  } catch (e: any) {
    return res.status(200).json({ ok: true, saved: false, error: e?.message || String(e) });
  }
}