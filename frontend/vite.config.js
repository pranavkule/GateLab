import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-server port and backend URLs are configurable so two EdgeGate copies
// can run side by side (see .env / frontend/.env).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');
  return {
    plugins: [react()],
    server: { port: Number(env.VITE_PORT) || 5174, host: 'localhost', strictPort: true },
  };
});
