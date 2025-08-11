import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

const PROYECTOS = [
  'BOSQUES DE CALANGO',
  'ASIA PACIFIC CONDOMINIO',
  'TOSCANA GARDEN',
  'PACHACAMAC LUXURY',
  'PARACAS REALTY BEACH',
  'BUONAVISTA',
  'ALTAVISTA'
];

export default function NuevoProspecto() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Campos
  const [lugarProspeccion, setLugarProspeccion] = useState('');
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [celular, setCelular] = useState('');
  const [dniCe, setDniCe] = useState('');
  const [email, setEmail] = useState('');
  const [proyecto, setProyecto] = useState(PROYECTOS[0]);
  const [comentario, setComentario] = useState('');

  // Atribución opcional
  const [asesorCodigo, setAsesorCodigo] = useState('');
  const [utm, setUtm] = useState({ source: '', medium: '', campaign: '' });
  const [geo, setGeo] = useState<{lat?: number; lon?: number}>({});
  const [web, setWeb] = useState(''); // honeypot

  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query;
    if (typeof q.asesor === 'string') setAsesorCodigo(q.asesor);
    setUtm({
      source: (q.utm_source as string) || '',
      medium: (q.utm_medium as string) || '',
      campaign: (q.utm_campaign as string) || ''
    });
  }, [router.isReady, router.query]);

  useEffect(() => {
    if (!navigator?.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 4000 }
    );
  }, []);

  function normalizePhone(v: string) {
    return v.replace(/[^\d+()\s-]/g, '');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMsg(null);
    try {
      const r = await fetch('/api/prospectos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lugar_prospeccion: lugarProspeccion,
          nombre, apellido,
          celular,
          dni_ce: dniCe,
          email,
          proyecto_interes: proyecto,
          comentario,
          asesor_codigo: asesorCodigo,
          utm_source: utm.source,
          utm_medium: utm.medium,
          utm_campaign: utm.campaign,
          lat: geo.lat, lon: geo.lon,
          web // honeypot
        })
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Error');
      setMsg('¡Registrado correctamente!');

      // limpiar
      setLugarProspeccion(''); setNombre(''); setApellido('');
      setCelular(''); setDniCe(''); setEmail('');
      setProyecto(PROYECTOS[0]); setComentario('');
    } catch (err: any) {
      setMsg(err.message || 'No se pudo registrar');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Registro de Prospecto</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        {/* honeypot */}
        <div style={{ display: 'none' }}>
          <label>Tu web
            <input value={web} onChange={(e)=>setWeb(e.target.value)} />
          </label>
        </div>

        <div>
          <label className="block text-sm mb-1">Lugar de prospección</label>
          <input className="w-full border rounded p-2"
                 value={lugarProspeccion}
                 onChange={e=>setLugarProspeccion(e.target.value)}
                 placeholder="Ej: Evento, Calle, Centro comercial" />
        </div>

        <div>
          <label className="block text-sm mb-1">Nombre <span className="text-red-600">*</span></label>
          <input className="w-full border rounded p-2" required
                 value={nombre} onChange={e=>setNombre(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm mb-1">Apellido <span className="text-red-600">*</span></label>
          <input className="w-full border rounded p-2" required
                 value={apellido} onChange={e=>setApellido(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm mb-1">Celular (Perú) <span className="text-red-600">*</span></label>
          <input className="w-full border rounded p-2"
                 inputMode="numeric" pattern="[0-9\s+()-]*" required
                 value={celular} onChange={e=>setCelular(normalizePhone(e.target.value))}
                 placeholder="9 dígitos" />
        </div>

        <div>
          <label className="block text-sm mb-1">DNI / CE</label>
          <input className="w-full border rounded p-2"
                 value={dniCe} onChange={e=>setDniCe(e.target.value.toUpperCase())}
                 placeholder="DNI: 8 dígitos / CE: 9-12 alfanum." />
        </div>

        <div>
          <label className="block text-sm mb-1">Correo</label>
          <input type="email" className="w-full border rounded p-2"
                 value={email} onChange={e=>setEmail(e.target.value)}
                 placeholder="nombre@dominio.com" />
        </div>

        <div>
          <label className="block text-sm mb-1">Proyecto de interés</label>
          <select className="w-full border rounded p-2"
                  value={proyecto} onChange={e=>setProyecto(e.target.value)}>
            {PROYECTOS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm mb-1">Comentario</label>
          <textarea className="w-full border rounded p-2" rows={3}
                    value={comentario} onChange={e=>setComentario(e.target.value)}
                    placeholder="Notas, preferencias, etc." />
        </div>

        {/* oculto para atribución por URL */}
        <input type="hidden" value={asesorCodigo} readOnly />

        <button disabled={loading} className="px-4 py-2 rounded bg-black text-white">
          {loading ? 'Enviando…' : 'Registrar'}
        </button>

        {msg && <p className="text-sm mt-2">{msg}</p>}
      </form>
    </main>
  );
}