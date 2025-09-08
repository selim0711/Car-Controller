// vite.config.mjs
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const buildBanner = () => ({
  name: 'threejs-banner',
  buildStart() {
    process.stdout.write('Building for production...\n')
  },
  buildEnd() {
    const line = '---------------------------------------------------------'
    const msg = '🚗 Three.js + Vue build complete!'
    process.stdout.write(`${line}\n${msg}\n${line}\n✨ Done ✨\n`)
  }
})

export default defineConfig({
  // hier deinen Zielpfad eintragen
  base: '/fileadmin/user_upload/Mannis-Studio-Tour/',
  plugins: [vue(), buildBanner()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  logLevel: 'warning',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2018',
    // esbuild genügt; willst du 'terser', installiere 'terser' als Dev-Dep
    minify: 'esbuild',
    sourcemap: false,
  },
})
