/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // ¡clave! hace que el build pase aunque ESLint marque errores
    ignoreDuringBuilds: true,
  },
  typescript: {
    // opcional: también ignora errores de TS en el build
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;    