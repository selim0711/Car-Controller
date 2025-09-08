// src/utils/assets.js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'

// BASE_URL kommt von Vite (respektiert vite.config base)
// VITE_APP_ASSET_PATH kommt aus deiner .env (z.B. assets/)
const BASE = import.meta.env.BASE_URL || '/'
const ASSETS_DIR = (import.meta.env.VITE_APP_ASSET_PATH || 'assets/')
  .replace(/^\/+/, '')
  .replace(/\/?$/, '/') // trailing slash sicherstellen

export const assetBase = `${BASE}${ASSETS_DIR}`

// Wenn du mal nur eine URL brauchst (ohne Loader):
export const assetUrl = (rel) =>
  `${assetBase}${String(rel).replace(/^\/+/, '')}`

// GLTFLoader vorkonfigurieren; optional mit Unterordner
export function makeGLTFLoader(subdir = '') {
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  draco.setDecoderConfig({ type: 'js' })
  draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')
  loader.setDRACOLoader(draco)

  const base = subdir
    ? assetUrl(subdir.replace(/\/?$/, '/'))
    : assetBase

  loader.setPath(base)

  // Debug: finalen Request-URL sehen
  // loader.manager.setURLModifier(u => { console.log('[GLTF URL]', u); return u })

  return loader
}
