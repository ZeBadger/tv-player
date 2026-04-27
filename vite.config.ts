import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: '0.0.0.0', // bind to all interfaces so the container is reachable
    proxy: {
      // Proxy HDHomeRun API calls to avoid any CORS issues in dev
      '/hdhomerun': {
        target: 'http://192.168.0.49',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hdhomerun/, ''),
      },
      // Proxy HDHomeRun MPEG-TS stream calls to device stream port
      '/hdhomerun-stream': {
        target: 'http://192.168.0.49:5004',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hdhomerun-stream/, ''),
      },
    },
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
  },
});
