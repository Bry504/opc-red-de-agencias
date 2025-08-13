/* eslint-disable */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ===== HighLevel / LeadConnector env =====
const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN ?? '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';
const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID ?? '';
const GHL_STAGE_ID_PROSPECCION = process.env.GHL_STAGE_ID_PROSPECCION ?? '';

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

// --- Envío a HighLevel (contacto + tags + oportunidad en PROSPECCIÓN) ---
async function pushToHighLevel({
  nombre,
  apellido,
  celular9,
  email,
  proyecto,           // p.ej. "BUONAVISTA"
  opcCodigo,          // p.ej. "OPC001"
  lugarProspeccion,   // p.ej. "Mall del Sur"
  dniCe,              // p.ej. "12345678"
  comentario,         // texto largo
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
}) {
  if (!GHL_TOKEN || !GHL_LOCATION_ID) {
    console.warn('GHL: faltan envs GHL_ACCESS_TOKEN o GHL_LOCATION_ID');
    return { ok: false, skipped: true };
  }

  const phoneE164 = celular9 ? `+51${celular9}` : undefined;

  // 1) Upsert Contact
  const upsertRes = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Version: '2021-07-28',
      'Location-Id': GHL_LOCATION_ID,
    },
    body: JSON.stringify({
      locationId: GHL_LOCATION_ID,
      firstName: nombre,
      lastName: apellido,
      email: email || undefined,
      phone: phoneE164,
      source: 'OPC',
    }),
  });

  if (!upsertRes.ok) {
    const t = await upsertRes.text().catch(() => '');
    console.warn('GHL upsert failed', upsertRes.status, t);
    return { ok: false };
  }

  const upsertJson: any = await upsertRes.json().catch(() => ({}));
  let contactId: string | undefined = upsertJson?.id || upsertJson?.contact?.id;

  // Fallback: buscar por teléfono si no devuelve id
  if (!contactId && phoneE164) {
    try {
      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/search?locationId=${encodeURIComponent(GHL_LOCATION_ID)}&query=${encodeURIComponent(phoneE164)}`,
        {
          headers: {
            Authorization: `Bearer ${GHL_TOKEN}`,
            Accept: 'application/json',
            Version: '2021-07-28',
            'Location-Id': GHL_LOCATION_ID,
          },
        }
      );
      const sjson: any = await searchRes.json().catch(() => ({}));
      contactId = sjson?.contacts?.[0]?.id;
      if (contactId) console.info('GHL search contactId', contactId);
    } catch (e) {
      console.warn('GHL search by phone failed', e);
    }
  }

  if (!contactId) {
    console.warn('GHL: no contactId after upsert/search', upsertJson);
    return { ok: false };
  }
  console.info('GHL upsert OK', contactId);

  // 2) Tags EXACTOS en el contacto (sin "OPC" extra)
  try {
    // Construye el array exacto en el orden que pediste, filtrando vacíos:
    const tags = [
      (opcCodigo || '').trim(),
      (proyecto || '').trim(),
      (lugarProspeccion || '').trim(),
      (dniCe || '').trim(),
    ].filter(Boolean);

    if (tags.length) {
      const tagRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GHL_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Version: '2021-07-28',
        },
        body: JSON.stringify({ tags }),
      });
      if (!tagRes.ok) {
        const tj = await tagRes.text().catch(() => '');
        console.warn('GHL add-tags failed', tagRes.status, tj);
      } else {
        console.info('GHL tags OK', tags);
      }
    }
  } catch (e) {
    console.warn('GHL add-tags error', e);
  }

  // 3) Crear Oportunidad con el nombre EXACTO requerido
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
    // ← nombre como lo pediste: "Nombre Apellido - OPC"
    name: `${nombre} ${apellido} - OPC`,
  };
  console.warn('GHL opp payload', oppPayload);

  async function postOpp(url: string) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Version: '2021-07-28',
        'Location-Id': GHL_LOCATION_ID,
      },
      body: JSON.stringify(oppPayload),
    });
    return res;
  }

  // Intento 1
  let oppRes = await postOpp('https://services.leadconnectorhq.com/opportunities/');
  // Fallback a api.* si 404
  if (oppRes.status === 404) {
    console.warn('GHL opportunities 404 en services; reintentando en api.leadconnectorhq.com');
    oppRes = await postOpp('https://api.leadconnectorhq.com/opportunities/');
  }

  if (!oppRes.ok) {
    const ot = await oppRes.text().catch(() => '');
    console.warn('GHL opportunity failed', oppRes.status, ot);
    return { ok: true, contactId };
  }

  const oppJson: any = await oppRes.json().catch(() => ({}));
  const opportunityId = oppJson?.id;
  console.warn('GHL opportunity OK', opportunityId);

  // 4) Guardar comentario largo como NOTE (mucho mejor que tag)
  if ((comentario && comentario.trim()) || lugarProspeccion || proyecto || dniCe) {
    try {
      const noteBody =
        `Comentario OPC:\n${(comentario || '').trim()}\n\n` +
        `Meta:\n- Código: ${opcCodigo || ''}\n- Proyecto: ${proyecto || ''}\n` +
        `- Lugar prospección: ${lugarProspeccion || ''}\n- DNI/CE: ${dniCe || ''}`;

      const noteResp = await fetch('https://services.leadconnectorhq.com/notes/', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GHL_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Version: '2021-07-28',
          'Location-Id': GHL_LOCATION_ID,
        },
        body: JSON.stringify({ contactId, body: noteBody }),
      });

      if (!noteResp.ok) {
        const noteErr = await noteResp.text().catch(() => '');
        console.warn('Nota no creada:', noteErr);
      }
    } catch (e) {
      console.warn('Error creando nota:', e);
    }
  }

  return { ok: true, contactId, opportunityId };
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
      .from('asesores')
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
    const utm_source        = (body['utm_source'] as string) ?? null;
    const utm_medium        = (body['utm_medium'] as string) ?? null;
    const utm_campaign      = (body['utm_campaign'] as string) ?? null;
    const lat               = (body['lat'] as number | undefined) ?? null;
    const lon               = (body['lon'] as number | undefined) ?? null;

    // --- validaciones mínimas ---
    if (!nombre.trim() || !apellido.trim()) return res.status(200).json({ ok: false, error: 'VALIDATION' });
    const celular = cleanPhone(celularRaw || '');
    if (!celular || celular.length !== 9) return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidDniCe(dni_ce))            return res.status(200).json({ ok: false, error: 'VALIDATION' });
    if (!isValidEmail(emailRaw))          return res.status(200).json({ ok: false, error: 'VALIDATION' });

    // --- precheck server-side (RPC) para duplicados ---
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

    // --- insert ---
    const ipHeader = req.headers['x-forwarded-for'];
    const ip = (typeof ipHeader === 'string' && ipHeader)
      ? ipHeader.split(',')[0].trim()
      : req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

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
        asesor_codigo: opc.codigo,
        utm_source, utm_medium, utm_campaign,
        lat, lon,
        user_agent: ua,
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
      await pushToHighLevel({
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
    } catch (e) {
      console.warn('pushToHighLevel error:', e);
    }

    return res.status(200).json({ ok: true, id: data.id });
  } catch {
    return res.status(200).json({ ok: false, error: 'ERROR_DESCONOCIDO' });
  }
}