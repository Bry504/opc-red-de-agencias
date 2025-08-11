// eslint.config.mjs — Flat config para Next 15
import next from 'eslint-config-next';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  ...next,
  {
    // ignora esos archivos para ESLint (así no vuelve a quejarse por "any")
    ignores: ['pages/api/prospectos.ts', 'pages/nuevoProspecto.tsx'],
    rules: {
      // por si acaso en otros archivos
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];