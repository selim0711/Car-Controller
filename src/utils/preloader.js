// src/utils/preloader.js
import { makeGLTFLoader } from './assets'

export class Preloader {
  constructor(subdir = '') {
    // zeigt standardmäßig auf public/assets/ (+ optional subdir)
    this.loader = makeGLTFLoader(subdir)
    this.cache = new Map() // key -> Promise<{gltf}>
  }

  // Lädt (oder gibt aus Cache zurück) und liefert das GLTF-Objekt
  // key: Name im Cache (z.B. 'chassis'), file: Dateiname (z.B. 'chassis.gltf')
  loadGLTF(key, file) {
    if (this.cache.has(key)) return this.cache.get(key)

    const p = new Promise((resolve, reject) => {
      this.loader.load(
        file,
        (gltf) => resolve(gltf),
        undefined,
        (err) => reject(err)
      )
    })

    this.cache.set(key, p)
    return p
  }
}

// Singleton für assets/ (kein Unterordner)
export const preloader = new Preloader('')
