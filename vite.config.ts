import { build, defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * Vite marks emitted `<script>` and `<link>` tags `crossorigin` because that is
 * what a web deployment needs. On a `chrome-extension://` page the browser
 * reads that as a cross-world resource mismatch, discards the preload and logs
 * a warning, so the attribute costs us the preload it was meant to enable.
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

/**
 * Manifest content scripts are classic scripts, not ES modules, so the Amazon
 * Goodreads entry cannot share the main build's `format: 'es'`. A second Vite
 * build in `closeBundle` emits one IIFE next to the rest of `dist/`.
 */
function contentScripts(): Plugin {
  return {
    name: 'bunnylol:content-scripts',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        publicDir: false,
        logLevel: 'warn',
        build: {
          emptyOutDir: false,
          outDir: 'dist',
          target: 'es2022',
          minify: false,
          sourcemap: true,
          rollupOptions: {
            input: 'src/content/amazon-goodreads.ts',
            output: {
              format: 'iife',
              name: 'bunnylolAmazonGoodreads',
              entryFileNames: 'amazon-goodreads.js',
              inlineDynamicImports: true,
            },
          },
        },
      });
    },
  };
}

// Paths are relative to `root` so the config typechecks without @types/node.
export default defineConfig({
  plugins: [stripCrossorigin(), contentScripts()],
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
