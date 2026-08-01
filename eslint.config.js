// Flat config for ESLint 9 (vscode-eslint 3.x uses this file by default).
// Covers TS extension sources and JS/MJS tests. No type-aware rules, so no
// tsconfig is required.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'tests/.work/', '.pi/'],
  },
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
