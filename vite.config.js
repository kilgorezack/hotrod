import { defineConfig, loadEnv } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [cloudflare()],
    define: {
      __MAPKIT_TOKEN__: JSON.stringify(env.MAPKIT_TOKEN || ''),
    },
    build: {
      outDir: 'dist',
    },
  };
});
