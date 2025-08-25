/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

type PushResult = {
  ok: boolean;
  contactId?: string;
  opportunityId?: string;
  pipelineId?: string;
  assignedUserId?: string;
  skipped?: boolean;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== HighLevel / LeadConnector env =====
const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN ?? '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';
const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID ?? '';
const GHL_STAGE_ID_PROSPECCION = process.env.GHL_STAGE_ID_PROSPECCION ?? '';
const GHL_CF_DNI_ID = process.env.GHL_CF_DNI_ID ?? ''; // ID del custom field DNI/CE en HL

// --- utils ---
function cleanPhone(v: string) { return v?.replace(/\D/g, '').slice(-9); }
function isValidDniCe(v?: string) {
  if (!v) return true;
  const s = v.trim().toUpperCase();
  if (/^\d{8}$/.test(s)) return true;       // DNI
  return /^[A-Z0-9]{9,12}$/.test(s);        // CE
}
function isValidEmail(v?: string) {
  if (!v) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms)); // <<<

// --- Envío a HighLevel (contacto + tags + oportunidad + nota) ---
async function pushToHighLevel({
  nombre,
  apellido,
  celular9,
  email,
  proyecto,
  opcCodigo,
  lugarProspeccion,
  dniCe,
  comentario,
}: {
  nombre: string;
  apellido: string;
  celular9: string;
  email?: string | null;
  proyecto: string | null;
  opcCodigo: string;
  lugarProspeccion?: string | null;
  dniCe?: string | null;
  comentario?: string | null;
}): Promise<PushResult> {
  if (!GHL_TOKEN || !GHL_LOCATION_ID) {
    console.warn('GHL: faltan envs GHL_ACCESS_TOKEN o GHL_LOCATION_ID');
    return { ok: false, skipped: true };
  }

  const phoneE164 = celular9 ? `+51${celular9}` : undefined;

  const baseHeaders = {
    Authorization: `Bearer ${GHL_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Version: '2021-07-28',
    'Location-Id': GHL_LOCATION_ID,
  } as const;

  async function fetchOppById(id: string): Promise<any | null> {
    const urls = [
      `https://services.leadconnectorhq.com/opportunities/${encodeURIComponent(id)}`,
      `https://api.leadconnectorhq.com/opportunities/${encodeURIComponent(id)}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: baseHeaders });
        if (r.ok) return await r.json().catch(() => ({}));
      } catch (_) {/* try next */ }
    }
    return null;
  }

  // ---------- 1) Upsert contact ----------
  const upsertBody: any = {
    locationId: GHL_LOCATION_ID,
    firstName: nombre,
    lastName: apellido,
    email: email || undefined,
    phone: phoneE164,
    source: 'OPC',
  };
  if (GHL_CF_DNI_ID && dniCe && dniCe.trim()) {
    upsertBody.customFields = [{ id: GHL_CF_DNI_ID, value: dniCe.trim() }];
  }

  const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify(upsertBody),
  });
  if (!upsertRes.ok) {
    console.warn('GHL upsert failed', upsertRes.status, await upsertRes.text().catch(()=>'')); 
    return { ok: false };
  }
  const upsertJson: any = await upsertRes.json().catch(() => ({}));
  let contactId: string | undefined = upsertJson?.id || upsertJson?.contact?.id;

  // fallback por teléfono
  if (!contactId && phoneE164) {
    try {
      const s = await fetch(
        `https://services.leadconnectorhq.com/contacts/search?locationId=${encodeURIComponent(GHL_LOCATION_ID)}&query=${encodeURIComponent(phoneE164)}`,
        { headers: baseHeaders }
      );
      const sj: any = await s.json().catch(() => ({}));
      contactId = sj?.contacts?.[0]?.id;
    } catch (e) {
      console.warn('GHL search contact error', e);
    }
  }
  if (!contactId) return { ok: false };

  // ---------- 2) Tags ----------
  try {
    const tags = [opcCodigo, proyecto || '', lugarProspeccion || ''].filter(Boolean);
    if (tags.length) {
      const t = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ tags }),
      });
      if (!t.ok) console.warn('GHL add-tags failed', t.status, await t.text().catch(()=>'')); 
    }
  } catch (e) {
    console.warn('GHL add-tags error', e);
  }

  // ---------- 3) Crear oportunidad ----------
  if (!GHL_PIPELINE_ID || !GHL_STAGE_ID_PROSPECCION) {
    console.warn('GHL: faltan GHL_PIPELINE_ID o GHL_STAGE_ID_PROSPECCION');
    return { ok: true, contactId };
  }

  const oppPayload = {
    locationId: GHL_LOCATION_ID,
    contactId,
    pipelineId: GHL_PIPELINE_ID,
    pipelineStageId: GHL_STAGE_ID_PROSPECCION,
    status: 'open',
    source: 'OPC',
    name: `${nombre} ${apellido}`,
  };

  async function postOpp(url: string) {
    return fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(oppPayload) });
  }

  let oppRes = await postOpp('https://services.leadconnectorhq.com/opportunities/');
  if (oppRes.status === 404) oppRes = await postOpp('https://api.leadconnectorhq.com/opportunities/');
  if (!oppRes.ok) {
    console.warn('GHL opportunity failed', oppRes.status, await oppRes.text().catch(()=>'')); 
    return { ok: true, contactId };
  }

  const oppJson: any = await oppRes.json().catch(() => ({}));
  let opportunityId: string | undefined =
    oppJson?.id || oppJson?.opportunity?.id || oppJson?.data?.id || oppJson?.result?.id;

  // Detalle para conocer pipeline/assigned
  let pipelineId: string | undefined = oppPayload.pipelineId;
  let assignedUserId: string | undefined;

  if (opportunityId) {
    const detail = await fetchOppById(opportunityId);
    if (detail) {
      pipelineId =
        detail?.pipelineId ||
        detail?.opportunity?.pipelineId ||
        detail?.data?.pipelineId ||
        pipelineId;

      assignedUserId =
        detail?.assignedUserId ||
        detail?.assignedTo?.id ||
        detail?.userId ||
        detail?.opportunity?.assignedTo?.id ||
        detail?.data?.assignedUserId ||
        assignedUserId;
    }

    // <<< reintentos cortos por si la asignación tarda unos segundos
    if (!assignedUserId) {
      for (const delay of [400, 800]) {
        await sleep(delay);
        const d = await fetchOppById(opportunityId);
        const userId =
          d?.assignedUserId ||
          d?.assignedTo?.id ||
          d?.userId ||
          d?.opportunity?.assignedTo?.id ||
          d?.data?.assignedUserId;
        if (userId) { assignedUserId = String(userId); break; }
      }
    }
    // >>>
  }

  // ---------- 4) Nota opcional ----------
  if ((comentario && comentario.trim()) || lugarProspeccion || proyecto || dniCe) {
    try {
      const note =
        `Comentario OPC:\n${(comentario || '').trim()}\n\n` +
        `Meta:\n- Código: ${opcCodigo || ''}\n- Proyecto: ${proyecto || ''}\n` +
        `- Lugar prospección: ${lugarProspeccion || ''}\n- DNI/CE: ${dniCe || ''}`;
      const noteResp = await fetch(
        `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
        { method: 'POST', headers: baseHeaders, body: JSON.stringify({ body: note }) }
      );
      if (!noteResp.ok) console.warn('Nota no creada:', await noteResp.text().catch(()=>'')); 
    } catch (e) {
      console.warn('Error creando nota:', e);
    }
  }

  return { ok: true, contactId, opportunityId, pipelineId, assignedUserId };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // --- auth ---
    const tokenHeader = req.headers['x-opc-token'];
    const opcToken = typeof tokenHeader === 'string' ? tokenHeader : '';
    if (!opcToken) return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });

    const { data: opc, error: opcErr } = await supabase
      .from('opcs')
      .select('id,codigo,estado')
      .eq('capture_token', opcToken)
      .single();
    if (opcErr || !opc || !opc.estado) {
      return res.status(200).json({ ok: false, error: 'NO_AUTORIZADO' });
    }

    // --- campos ---
    const lugar_prospeccion = (body['lugar_prospeccion'] as string) ?? null;
    const nombre            = (body['nombre'] as string) ?? '';
    const apellido          = (body['apellido'] as string) ?? '';
    const celularRaw        = (body['celular'] as string) ?? '';
    const dni_ce            = (body['dni_ce'] as string) ?? '';
    const emailRaw          = (body['email'] as string) ?? '';
    const proyectoRaw       = (body['proyecto_interes'] as string) ?? null;
    const proyecto_interes  = proyectoRaw === 'NINGUNO' ? null : proyectoRaw;
    const comentario        = (body['comentario'] as string) ?? null;
    const lat               = (body['lat'] as number | undefined) ?? null;
    const longVal           = (body['lon'] as number | undefined) ?? null;

    // --- validaciones mínimas ---
    if (!nombre.trim() || !apellido.trim()) return res.status(200).json({ ok: false, error: 'VALIDATION' });
    const celular = cleanPhone(celularRaw || '');
    if (!celular || celular.length !== 9) return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidDniCe(dni_ce))            return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidEmail(emailRaw))          return res.status(200).json({ ok: false, error: 'VALIDATION' });

    // --- precheck RPC duplicados ---
    const celN   = celular.replace(/^51/, '').replace(/^0+/, '');
    const dniN   = (dni_ce ?? '').trim();
    const emailN = (emailRaw ?? '').trim().toLowerCase().replace(/\s+/g, '');
    const { data: dup, error: rpcErr } = await supabase.rpc('prospecto_existe', {
      p_celular: celN || null,
      p_dni: dniN || null,
      p_email: emailN || null,
    });
    if (!rpcErr && dup && (dup as any).exists) {
      const where = (dup as any).match_on as 'celular'|'dni'|'email'|null;
      if (where === 'email')   return res.status(200).json({ ok: false, error: 'DUPLICADO_EMAIL' });
      if (where === 'celular') return res.status(200).json({ ok: false, error: 'DUPLICADO_CEL' });
      if (where === 'dni')     return res.status(200).json({ ok: false, error: 'DUPLICADO_DNI' });
      return res.status(200).json({ ok: false, error: 'DUPLICADO' });
    }

    // --- insert local ---
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = (typeof ipHeader === 'string' && ipHeader)
      ? ipHeader.split(',')[0].trim()
      : req.socket.remoteAddress || null;

    const { data, error } = await supabase
      .from('prospectos')
      .insert([{
        lugar_prospeccion,
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        celular,                             // 9 dígitos
        dni_ce: dniN || null,
        email: emailN || null,               // normalizado al guardar
        proyecto_interes,
        comentario,
        lat,
        long: longVal,                       // columna se llama "long"
        opc_id: opc.id,                      // FK al captador
        etapa_actual: 'PROSPECCION',
        stage_changed_at: new Date().toISOString(),
        ip_insercion: ip
      }])
      .select('id')
      .single();

    if (error) {
      // @ts-ignore
      if (error.code === '23505') {
        const m = String((error as any).message || '');
        if (/ux_prospectos_email_norm2/i.test(m)) return res.status(200).json({ ok: false, error: 'DUPLICADO_EMAIL' });
        return res.status(200).json({ ok: false, error: 'DUPLICADO' });
      }
      // @ts-ignore
      if (error.code === '23514') return res.status(200).json({ ok: false, error: 'CHECK_VIOLATION' });
      return res.status(200).json({ ok: false, error: 'ERROR_DESCONOCIDO' });
    }

    // ======= Enviar a HighLevel (NO bloqueante) =======
    try {
      const r = await pushToHighLevel({
        nombre,
        apellido,
        celular9: celular,
        email: emailN || null,
        proyecto: proyecto_interes,
        opcCodigo: opc.codigo,
        lugarProspeccion: lugar_prospeccion,
        dniCe: dniN || null,
        comentario,
      });

      // patch con lo que venga de HL (ids)
      const patch: any = {};
      if (r?.opportunityId) patch.hl_opportunity_id = r.opportunityId;
      if (r?.pipelineId)    patch.hl_pipeline_id   = String(r.pipelineId);

      // mapear asesor por hl_user_id (si vino)
      if (r?.assignedUserId) {
        const { data: a } = await supabase
          .from('asesores')
          .select('id')
          .eq('hl_user_id', String(r.assignedUserId))
          .maybeSingle();
        if (a?.id) patch.asesor_id = a.id;
      }

      if (Object.keys(patch).length) {
        await supabase.from('prospectos').update(patch).eq('id', data.id);
      }

      // --------- HISTORIAL INICIAL: NULL -> PROSPECCION ----------
      await supabase.from('prospecto_stage_history').insert({
        prospecto_id: data.id,
        hl_opportunity_id: r?.opportunityId ?? null,
        from_stage: null,
        to_stage: 'PROSPECCION',
        changed_at: new Date().toISOString(),
        asesor_id: patch.asesor_id ?? null,
        source: 'SYSTEM',
      });
      // -----------------------------------------------------------

      // <<< Completar por si ya tenemos asesor_id y la fila quedó sin él
      if (patch.asesor_id) {
        const { data: latestSystem } = await supabase
          .from('prospecto_stage_history')
          .select('id, asesor_id')
          .eq('prospecto_id', data.id)
          .eq('to_stage', 'PROSPECCION')
          .eq('source', 'SYSTEM')
          .order('changed_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestSystem?.id && !latestSystem.asesor_id) {
          await supabase
            .from('prospecto_stage_history')
            .update({ asesor_id: patch.asesor_id })
            .eq('id', latestSystem.id);
        }
      }
      // >>>

    } catch (e) {
      console.warn('pushToHighLevel error:', e);
    }

    return res.status(200).json({ ok: true, id: data.id });
  } catch {
    return res.status(200).json({ ok: false, error: 'ERROR_DESCONOCIDO' });
  }
}