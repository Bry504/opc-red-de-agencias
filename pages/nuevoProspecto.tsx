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

// Debounce helper
const debounce = (fn: Function, ms = 400) => {
  let t: any;
  return (...args: any[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// --- Pre-check con token (incluye email)
async function apiCheckDuplicate(
  celular?: string,
  dni?: string,
  email?: string,
  token?: string | null
) {
  const r = await fetch('/api/prospectos/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-opc-token': token || '' },
    body: JSON.stringify({ celular, dni, email }),
  });
  const j = await r.json();
  return (j ?? { exists: false, match_on: null }) as {
    exists: boolean;
    match_on: null | 'celular' | 'dni' | 'email';
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

  const [geo, setGeo] = useState<{ lat?: number; lon?: number }>({});
  const [web, setWeb] = useState(''); // honeypot

  const [opcToken, setOpcToken] = useState<string | null>(null);

  // dup contempla 'email' | 'celular' | 'dni'
  const [dup, setDup] = useState<null | 'celular' | 'dni' | 'email'>(null);

  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query;

    const qsToken =
      (typeof q.t === 'string' && q.t) ||
      (typeof q.token === 'string' && q.token) ||
      null;

    if (qsToken) {
      localStorage.setItem('opc_token', qsToken);
      setOpcToken(qsToken);
    } else {
      const stored =
        typeof window !== 'undefined' ? localStorage.getItem('opc_token') : null;
      setOpcToken(stored);
    }
  }, [router.isReady, router.query]);

  // Geo (si no quieres permiso, elimina esto)
  useEffect(() => {
    if (!navigator?.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 4000 }
    );
  }, []);

  function normalizePhoneInput(v: string) {
    return v.replace(/[^\d+()\s-]/g, '');
  }

  // --- Debounce del pre‑chequeo
  const debouncedPrecheck = useMemo(
    () =>
      debounce(async (c: string, d: string, e: string) => {
        const r = await apiCheckDuplicate(
          c || undefined,
          d || undefined,
          e || undefined,
          opcToken
        );
        setDup(r.exists ? (r.match_on as 'celular' | 'dni' | 'email') : null);
      }, 450),
    [opcToken]
  );

  // --- Chequeo inmediato (onBlur o cuando quieras forzar)
  const runPre = async (c?: string, d?: string, e?: string) => {
    const r = await apiCheckDuplicate(
      (c ?? celular) || undefined,
      (d ?? dniCe) || undefined,
      (e ?? email) || undefined,
      opcToken
    );
    setDup(r.exists ? (r.match_on as 'celular' | 'dni' | 'email') : null);
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMsg(null);
    try {
      if (!opcToken) throw new Error('No autorizado: solicita un enlace válido.');

      // Pre‑chequeo inmediato antes de enviar
      const pre = await apiCheckDuplicate(celular, dniCe, email, opcToken);
      if (pre.exists) { setDup(pre.match_on); setLoading(false); return; }

      const r = await fetch('/api/prospectos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-opc-token': opcToken || '' },
        body: JSON.stringify({
          lugar_prospeccion: lugarProspeccion,
          nombre, apellido,
          celular,                       // lo mismo que ves en el input
          dni_ce: dniCe,
          email,                         // normalizado en el backend también
          proyecto_interes: proyecto === 'NINGUNO' ? null : proyecto,
          comentario,
          lat: geo.lat, lon: geo.lon,
          web
        })
      });

      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!j.ok) {
        if (j.error === 'DUPLICADO_EMAIL') {
          setDup('email');
          throw new Error('Ya existe un prospecto con este email.');
        }
        if (j.error === 'DUPLICADO_CEL') {
          setDup('celular');
          throw new Error('Ya existe un prospecto con este celular.');
        }
        if (j.error === 'DUPLICADO_DNI') {
          setDup('dni');
          throw new Error('Ya existe un prospecto con este DNI.');
        }
        if (j.error === 'DUPLICADO') {
          throw new Error('Ya existe un prospecto con datos duplicados.');
        }
        if (j.error === 'CHECK_VIOLATION') throw new Error('Revisa el formato de email, celular o DNI.');
        if (j.error === 'VALIDATION') throw new Error('Revisa los campos obligatorios o formatos.');
        if (j.error === 'NO_AUTORIZADO') throw new Error('No autorizado: enlace inválido o revocado.');
        throw new Error('No se pudo registrar.');
      }

      setMsg('¡Registrado correctamente!');
      setLugarProspeccion(''); setNombre(''); setApellido('');
      setCelular(''); setDniCe(''); setEmail('');
      setProyecto(PROYECTOS[0]); setComentario('');
      setDup(null);
    } catch (err: any) {
      setMsg(err?.message || 'No se pudo registrar');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="capture">
      <header className="heading">
        <div className="brand">REALTY GRUPO INMOBILIARIO</div>
        <div className="subtitle">Registro de Prospectos</div>
      </header>

      <section className="card">
        {!opcToken && (
          <p className="alert">No autorizado: este enlace no es válido. Solicita un link de captura a tu administrador.</p>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          {/* honeypot */}
          <div style={{ display: 'none' }}>
            <label>Tu web
              <input value={web} onChange={(e) => setWeb(e.target.value)} />
            </label>
          </div>

          <div>
            <label className="label">Lugar de prospección</label>
            <input
              className="input"
              value={lugarProspeccion}
              onChange={(e) => setLugarProspeccion(e.target.value)}
              placeholder="Ej: Jockey Plaza, Mercado Unicachi, Centro de Lima, etc."
            />
          </div>

          <div>
            <label className="label">Nombre <span className="required">*</span></label>
            <input
              className="input"
              required
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Apellido <span className="required">*</span></label>
            <input
              className="input"
              required
              value={apellido}
              onChange={(e) => setApellido(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Celular (Perú) <span className="required">*</span></label>
            <input
              className="input"
              inputMode="numeric"
              pattern="[0-9\s+()-]*"
              required
              value={celular}
              onChange={(e) => {
                const v = normalizePhoneInput(e.target.value);
                setCelular(v);
                debouncedPrecheck(v, dniCe, email);
              }}
              onBlur={(e) => {
                const v = normalizePhoneInput(e.target.value);
                runPre(v, dniCe, email);
              }}
              placeholder="9 dígitos"
            />
          </div>

          <div>
            <label className="label">DNI / CE</label>
            <input
              className="input"
              value={dniCe}
              onChange={(e) => {
                const v = e.target.value.toUpperCase();
                setDniCe(v);
                debouncedPrecheck(celular, v, email);
              }}
              onBlur={(e) => {
                const v = e.target.value.toUpperCase();
                runPre(celular, v, email);
              }}
              placeholder="DNI: 8 dígitos / CE: 9-12 dígitos"
            />
          </div>

          <div>
            <label className="label">Correo</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => {
                const v = e.target.value.trim().toLowerCase().replace(/\s+/g, '');
                setEmail(v);
                debouncedPrecheck(celular, dniCe, v);
              }}
              onBlur={(e) => {
                const v = e.target.value.trim().toLowerCase().replace(/\s+/g, '');
                runPre(celular, dniCe, v);
              }}
              placeholder="nombre_del_correo@dominio.com"
            />
          </div>

          <div>
            <label className="label">Proyecto de interés</label>
            <select
              className="select"
              value={proyecto}
              onChange={(e) => setProyecto(e.target.value)}
            >
              {PROYECTOS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <div className="help">Si no aplica, deja “NINGUNO”.</div>
          </div>

          <div>
            <label className="label">Comentario</label>
            <textarea
              className="textarea"
              rows={3}
              value={comentario}
              onChange={(e) => setComentario(e.target.value)}
              placeholder="Horarios de llamada, preferencia de comunicación, etc."
            />
          </div>

          {dup && (
            <p className="alert">
              Ya existe un prospecto con este {dup === 'celular' ? 'celular' : dup === 'dni' ? 'DNI' : 'email'}.
            </p>
          )}
          {msg && (
            <p className={msg.startsWith('¡Registrado') ? 'success' : 'alert'}>{msg}</p>
          )}

          <button disabled={loading || !!dup || !opcToken} className="button">
            {loading ? 'Enviando…' : 'Registrar'}
          </button>
        </form>
      </section>
    </main>
  );
}