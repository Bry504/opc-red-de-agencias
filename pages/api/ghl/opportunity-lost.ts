/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function deep(obj: any, key: string): any {
  if (!obj || typeof obj !== "object") return null;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const v = deep(obj[k], key);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (["GET","HEAD","OPTIONS"].includes(req.method || "")) {
    res.setHeader("Allow", "POST,GET,HEAD,OPTIONS");
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST,GET,HEAD,OPTIONS");
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const rawBody: any = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const body = rawBody.customData ? rawBody.customData : rawBody;

    const source = (body.source || "").trim(); // no_interesado | no_contactable
    const hl_opportunity_id = body.hl_opportunity_id || deep(rawBody, "opportunity.id") || body.id || null;
    const hl_pipeline = body.hl_pipeline || null;
    const hl_stage = body.hl_stage || null;
    const razon_no_interesado = body.razon_no_interesado || null;
    const razon_no_contactable = body.razon_no_contactable || null;

    if (!["no_interesado","no_contactable"].includes(source)) {
      return res.status(200).json({ ok: true, skip: "INVALID_SOURCE", received: body });
    }
    if (!hl_opportunity_id) {
      return res.status(200).json({ ok: true, skip: "MISSING_HL_OPPORTUNITY_ID", received: body });
    }

    // === Resolve prospecto/opc/asesor desde tu BD (igual a stage-change.ts) ===
    // 1) Busca el prospecto por opportunity_id
    let prospecto: { id: string; opc_id: string | null; asesor_id: string | null } | null = null;
    {
      const { data } = await supabase
        .from("prospectos")
        .select("id, opc_id, asesor_id")
        .eq("hl_opportunity_id", hl_opportunity_id)
        .maybeSingle();
      if (data) prospecto = data as any;
    }

    if (!prospecto) {
      // Si no encontramos por opportunity, no frenamos: insertamos con nulos (puedes luego actualizar por job)
      // También podrías intentar resolver por email/phone si HL lo envía en payload estándar (rawBody).
    }

    // 2) Si no hay asesor_id, intenta mapear por user.id de HL contra asesores.hl_user_id
    let asesor_id = prospecto?.asesor_id ?? null;
    if (!asesor_id) {
      const hl_user_id =
        deep(rawBody, "assignedUserId") || deep(rawBody, "user.id") || deep(rawBody, "owner.id") || null;
      if (hl_user_id) {
        const { data: a } = await supabase
          .from("asesores")
          .select("id")
          .eq("hl_user_id", String(hl_user_id))
          .maybeSingle();
        if (a?.id) asesor_id = a.id;
      }
    }

    const row = {
      prospecto_id: prospecto?.id ?? null,
      opc_id: prospecto?.opc_id ?? null,
      asesor_id: asesor_id ?? null,
      hl_opportunity_id,
      hl_pipeline,
      hl_stage,
      fuente: source,
      razon_no_interesado,
      razon_no_contactable,
      fecha_cambio: new Date().toISOString(),
      raw: rawBody,
    };

    // Inserta aunque haya nulos (para no perder eventos); si luego quieres, añade NOT NULL cuando ya tengas IDs.
    const { error } = await supabase.from("oportunidades_perdidas").insert(row);
    if (error) return res.status(200).json({ ok: true, saved: false, error: error.message });

    return res.status(200).json({ ok: true, saved: true });
  } catch (e: any) {
    return res.status(200).json({ ok: true, saved: false, error: e?.message || String(e) });
  }
}