import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  const allowedHosts = ['.onrender.com', '.render.com', 'localhost', '127.0.0.1'];
  if (process.env.RENDER_EXTERNAL_URL) {
    try {
      allowedHosts.push(new URL(process.env.RENDER_EXTERNAL_URL).hostname);
    } catch (e) {}
  }
  if (process.env.APP_URL) {
    try {
      allowedHosts.push(new URL(process.env.APP_URL).hostname);
    } catch (e) {}
  }

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      allowedHosts,
    },
    preview: {
      allowedHosts,
    },
  };
});
