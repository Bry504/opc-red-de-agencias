/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Permite que el build pase aunque haya errores de ESLint
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;