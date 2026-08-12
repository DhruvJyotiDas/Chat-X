import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  // Lets a throwaway dev server point at a throwaway backend (see PORT in
  // server/main.go) so meeting/signaling changes can be exercised end-to-end
  // without restarting the one that real calls are running on.
  const backendPort = process.env.BACKEND_PORT ?? '8080';
  const httpBackend = `http://localhost:${backendPort}`;
  const wsBackend = `ws://localhost:${backendPort}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api': {
          target: httpBackend,
          changeOrigin: true,
        },
        '/chat-ws': {
          target: wsBackend,
          ws: true,
          changeOrigin: true,
        },
        '/ws': {
          target: wsBackend,
          ws: true,
          changeOrigin: true,
        },
        '/asr': {
          target: 'ws://localhost:8765',
          ws: true,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/asr/, ''),
        },
      },
    },
  };
});
