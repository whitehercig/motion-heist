import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves this repository below /motion-heist/; local and
  // ordinary production builds stay rooted at /. 
  base: mode === 'github-pages' ? '/motion-heist/' : '/',
  plugins: [react()],
  server: { host: true },
}))
