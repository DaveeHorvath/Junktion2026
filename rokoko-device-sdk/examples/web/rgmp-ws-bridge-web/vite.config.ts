import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // One above the rcsp-ws-bridge-web app (5180) so both can run together.
    port: 5181,
  },
  build: {
    rollupOptions: {
      output: {
        // The 3D stack dwarfs the app code; keep it in its own cacheable chunk.
        manualChunks: {
          "vendor-3d": ["three", "@react-three/fiber", "@react-three/drei"],
        },
      },
    },
  },
});
