/* eslint-disable */
import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/router';

const PROYECTOS = [
  'NINGUNO',
  'BOSQUES DE CALANGO',
  'ASIA PACIFIC CONDOMINIO',
  'TOSCANA GARDEN',
  'PACHACAMAC LUXURY',
  'PARACAS REALTY BEACH',
  'BUONAVISTA',
  'ALTAVISTA'
];

// Debounce para evitar llamadas excesivas
const debounce = (fn: Function, ms = 400) => {
  let t: any;
  return (...args: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// API de pre-chequeo (ahora recibe el token para el header)
async function apiCheckDuplicate(celular?: string, dni?: string, token?: string | null) {
  const r = await fetch('/api/prospectos/check', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-opc-token': token || ''
    },
    body: JSON.stringify({ celular, dni }),
  });
  const j = await r.json();
  return (j ?? { exists: false, match_on: null }) as {
    exists: boolean;
    match_on: null | 'celular' | 'dni';
  };
}

export default function NuevoProspecto() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [lugarProspeccion, setLugarProspeccion] = useState('');
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [celular, setCelular] = useState('');
  const [dniCe, setDniCe] = useState('');
  const [email, setEmail] = useState('');
  const [proyecto, setProyecto] = useState(PROYECTOS[0]);
  const [comentario, setComentario] = useState('');

  const [utm, setUtm] = useState({ source: '', medium: '', campaign: '' });
  const [geo, setGeo] = useState<{ lat?: number; lon?: number }>({});
  const [web, setWeb] = useState(''); // honeypot

  // Token del OPC autorizado
  const [opcToken, setOpcToken] = useState<string | null>(null);

  // Estado de duplicado para UX
  const [dup, setDup] = useState<null | 'celular' | 'dni'>(null);

  // Lee token de la URL o de localStorage y guarda UTM/asesor si necesitas
  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query;

    // Token ?t= o ?token=
    const qsToken =
      (typeof q.t === 'string' && q.t) ||
      (typeof q.token === 'string' && q.token) ||
      null;

    if (qsToken) {
      localStorage.setItem('opc_token', qsToken);
      setOpcToken(qsToken);
    } else {
      const stored = typeof window !== 'undefined' ? localStorage.getItem('opc_token') : null;
      setOpcToken(stored);
    }

    setUtm({
      source: (q.utm_source as string) || '',
      medium: (q.utm_medium as string) || '',
      campaign: (q.utm_campaign as string) || ''
    });
  }, [router.isReady, router.query]);

  // Geolocalización (si no quieres pedir permiso, elimina este useEffect)
  useEffect(() => {
    if (!navigator?.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 4000 }
    );
  }, []);

  function normalizePhone(v: string) {
    return v.replace(/[^\d+()\s-]/g, '');
  }

  const debouncedPrecheck = useMemo(
    () =>
      debounce(async (c: string, d: string) => {
        const r = await apiCheckDuplicate(c || undefined, d || undefined, opcToken);
        setDup(r.exists ? (r.match_on as 'celular' | 'dni') : null);
      }, 450),
    // importante: volver a crear el debounce si cambia el token
    [opcToken]
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMsg(null);
    try {
      // Si no hay token: bloquear
      if (!opcToken) {
        throw new Error('No autorizado: solicita un enlace válido de captura.');
      }

      // Pre-chequeo rápido antes de enviar
      const pre = await apiCheckDuplicate(celular, dniCe, opcToken);
      if (pre.exists) {
        setDup(pre.match_on);
        setLoading(false);
        return;
      }

      const r = await fetch('/api/prospectos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-opc-token': opcToken || ''
        },
        body: JSON.stringify({
          lugar_prospeccion: lugarProspeccion,
          nombre,
          apellido,
          celular,
          dni_ce: dniCe,
          email,
          proyecto_interes: proyecto === 'NINGUNO' ? null : proyecto,
          comentario,
          // asesor_codigo se ignora en el backend; se toma del token
          utm_source: utm.source,
          utm_medium: utm.medium,
          utm_campaign: utm.campaign,
          lat: geo.lat,
          lon: geo.lon,
          web // honeypot
        })
      });

      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!j.ok) {
        if (
          j.error === 'DUPLICADO' ||
          /ux_prospectos_phone_e164|ux_prospectos_dni_norm|duplicate key value/i.test(j.error || '')
        ) {
          throw new Error('Ya existe un prospecto con el mismo celular o DNI.');
        }
        if (j.error === 'CHECK_VIOLATION') {
          throw new Error('Revisa el formato de celular o DNI.');
        }
        if (j.error === 'VALIDATION') {
          throw new Error('Revisa los campos obligatorios o formatos.');
        }
        if (j.error === 'NO_AUTORIZADO') {
          throw new Error('No autorizado: este enlace de captura no es válido o fue revocado.');
        }
        throw new Error('No se pudo registrar.');
      }

      setMsg('¡Registrado correctamente!');
      setLugarProspeccion(''); setNombre(''); setApellido('');
      setCelular(''); setDniCe(''); setEmail('');
      setProyecto(PROYECTOS[0]); setComentario('');
      setDup(null);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : 'No se pudo registrar';
      setMsg(m);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Registro de Prospecto</h1>

      {!opcToken && (
        <p className="text-sm text-red-600 mb-3">
          No autorizado: este enlace no es válido. Solicita un link de captura a tu administrador.
        </p>
      )}

      <form onSubmit={onSubmit} className="space-y-4">
        {/* honeypot */}
        <div style={{ display: 'none' }}>
          <label>Tu web
            <input value={web} onChange={(e) => setWeb(e.target.value)} />
          </label>
        </div>

        <div>
          <label className="block text-sm mb-1">Lugar de prospección</label>
          <input className="w-full border rounded p-2"
                 value={lugarProspeccion}
                 onChange={(e) => setLugarProspeccion(e.target.value)}
                 placeholder="Ej: Evento, Calle, Centro comercial" />
        </div>

        <div>
          <label className="block text-sm mb-1">Nombre <span className="text-red-600">*</span></label>
          <input className="w-full border rounded p-2" required
                 value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm mb-1">Apellido <span className="text-red-600">*</span></label>
          <input className="w-full border rounded p-2" required
                 value={apellido} onChange={(e) => setApellido(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm mb-1">Celular (Perú) <span className="text-red-600">*</span></label>
          <input className="w-full border rounded p-2"
                 inputMode="numeric" pattern="[0-9\s+()-]*" required
                 value={celular}
                 onChange={(e) => {
                   const v = normalizePhone(e.target.value);
                   setCelular(v);
                   debouncedPrecheck(v, dniCe);
                 }}
                 placeholder="9 dígitos" />
        </div>

        <div>
          <label className="block text-sm mb-1">DNI / CE</label>
          <input className="w-full border rounded p-2"
                 value={dniCe}
                 onChange={(e) => {
                   const v = e.target.value.toUpperCase();
                   setDniCe(v);
                   debouncedPrecheck(celular, v);
                 }}
                 placeholder="DNI: 8 dígitos / CE: 9-12 alfanum." />
        </div>

        <div>
          <label className="block text-sm mb-1">Correo</label>
          <input type="email" className="w-full border rounded p-2"
                 value={email} onChange={(e) => setEmail(e.target.value)}
                 placeholder="nombre@dominio.com" />
        </div>

        <div>
          <label className="block text-sm mb-1">Proyecto de interés</label>
          <select className="w-full border rounded p-2"
                  value={proyecto} onChange={(e) => setProyecto(e.target.value)}>
            {PROYECTOS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm mb-1">Comentario</label>
          <textarea className="w-full border rounded p-2" rows={3}
                    value={comentario} onChange={(e) => setComentario(e.target.value)}
                    placeholder="Notas, preferencias, etc." />
        </div>

        {dup && (
          <p className="text-sm text-red-600">
            Ya existe un prospecto con este {dup === 'celular' ? 'celular' : 'DNI'}.
          </p>
        )}

        {msg && <p className="text-sm mt-2">{msg}</p>}

        <button disabled={loading || !!dup || !opcToken} className="px-4 py-2 rounded bg-black text-white">
          {loading ? 'Enviando…' : 'Registrar'}
        </button>
      </form>
    </main>
  );
}