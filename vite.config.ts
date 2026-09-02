import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * Vite marks emitted `<script>` and `<link>` tags `crossorigin` because that is
 * what a web deployment needs. On a `chrome-extension://` page the browser
 * reads that as a cross-world resource mismatch, discards the preload and logs
 * a warning — so the attribute costs us the preload it was meant to enable.
 */
function stripCrossorigin(): Plugin {
  return {
    name: 'bunnylol:strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(=["'][^"']*["'])?/g, '');
    },
  };
}

// Paths are relative to `root` so the config typechecks without @types/node.
export default defineConfig({
  plugins: [stripCrossorigin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: true,
    // Every chunk is a local file the browser already has, so preloading buys
    // nothing and the polyfill chunk is dead weight in an extension.
    modulePreload: false,
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
