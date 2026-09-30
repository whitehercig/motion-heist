import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: true },
  // The MediaPipe Tasks runtime alone is ~350 kB of the main chunk and is needed on the
  // first screen anyway (the camera starts right after a mode is picked), so splitting buys nothing.
  build: { chunkSizeWarningLimit: 700 },
})
