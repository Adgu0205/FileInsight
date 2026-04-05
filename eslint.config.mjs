import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    rules: {
      'curly': 'off',
      'no-unused-vars': 'warn',
    },
    languageOptions: {
      globals: {
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
      }
    }
  }
];