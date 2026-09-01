import { defineConfig } from 'vite';

// Paths are relative to `root` so the config typechecks without @types/node.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        go: 'go.html',
        options: 'options.html',
        popup: 'popup.html',
        background: 'src/background.ts',
      },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
