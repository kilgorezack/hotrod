import { defineConfig, loadEnv } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [cloudflare()],
    define: {
      __MAPKIT_TOKEN__: JSON.stringify(env.MAPKIT_TOKEN || ''),
      // h3-js bundles Emscripten/WASM glue that references __dirname as a CJS
      // global. Cloudflare Workers (ES module runtime) doesn't provide it, so
      // define a safe fallback so the WASM can still load via the inlined bundle.
      __dirname: JSON.stringify('/'),
    },
    build: {
      outDir: 'dist',
    },
  };
});
