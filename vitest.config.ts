import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The token tests read the stylesheets as text with Vite's `?raw`. Vitest
    // stubs anything matching *.css to an empty module unless CSS is enabled,
    // and that stub wins over the raw loader — so without this the sheets
    // arrive as empty strings and every assertion passes vacuously.
    css: true,
    include: ['tests/**/*.test.ts'],
  },
});
