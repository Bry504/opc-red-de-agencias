/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body: any =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // HighLevel mete todo dentro de customData
    const data = body.customData ?? body ?? {};

    const source = data.source?.trim();
    const prospecto_id = data.prospecto_id || null;
    const opc_id = data.opc_id || null;
    const asesor_id = data.asesor_id || null;
    const hl_opportunity_id = data.hl_opportunity_id || null;
    const hl_pipeline = data.hl_pipeline || null;
    const hl_stage = data.hl_stage || null;
    const razon_no_interesado = data.razon_no_interesado || null;
    const razon_no_contactable = data.razon_no_contactable || null;

    // Validación mínima
    if (!["no_interesado", "no_contactable"].includes(source || "")) {
      return res
        .status(200)
        .json({ ok: true, skip: "INVALID_SOURCE", received: data });
    }

    // ⚠️ Evita error de FK en pruebas
    if (!prospecto_id || !opc_id || !asesor_id) {
      return res.status(200).json({
        ok: true,
        skip: "MISSING_FOREIGN_KEYS",
        received: data,
      });
    }

    const fecha_cambio = new Date().toISOString();

    const { error } = await supabase.from("oportunidades_perdidas").insert([
      {
        prospecto_id,
        opc_id,
        asesor_id,
        hl_opportunity_id,
        hl_pipeline,
        hl_stage,
        fuente: source,
        razon_no_interesado,
        razon_no_contactable,
        fecha_cambio,
        raw: body,
      },
    ]);

    if (error)
      return res
        .status(200)
        .json({ ok: true, saved: false, error: error.message });

    return res.status(200).json({ ok: true, saved: true });
  } catch (e: any) {
    return res
      .status(200)
      .json({ ok: true, saved: false, error: e.message || String(e) });
  }
}
