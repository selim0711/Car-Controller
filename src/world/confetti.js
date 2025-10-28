import * as THREE from 'three'

export class ConfettiSystem {
  constructor(scene, {
    gravity = 9.82 * 0.6,
    planeSize = { w: 0.06, h: 0.1 },
    baseOpacity = 1,
    colorHSL = { s: 0.8, l: 0.6 },
  } = {}) {
    if (!scene) throw new Error('ConfettiSystem: scene ist erforderlich.')
    this.scene = scene
    this.gravity = gravity
    this.baseOpacity = baseOpacity
    this.colorHSL = colorHSL

    // Shared Geometry + Pool
    this.geo = new THREE.PlaneGeometry(planeSize.w, planeSize.h)
    this.pool = []
    this.particles = []

    // kleine Temp-Vektoren
    this._tmp = {
      pos: new THREE.Vector3(),
    }
  }

  _acquireMesh() {
    let mesh = this.pool.pop()
    if (!mesh) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: this.baseOpacity,
        depthWrite: false,
      })
      mesh = new THREE.Mesh(this.geo, mat)
    }
    mesh.visible = true
    return mesh
  }

  _releaseMesh(mesh) {
    if (!mesh) return
    mesh.visible = false
    // nicht sofort dispose’n, wir recyceln (Pool)
    this.pool.push(mesh)
  }

  /**
   * Erzeuge eine Konfetti-Explosion.
   * @param {THREE.Vector3} pos
   * @param {object} opt
   *   - count, speed, spread, life
   */
  spawnAt(pos, {
    count = 100,
    speed = 4,
    spread = 1.2,
    life = 1.6,
  } = {}) {
    for (let i = 0; i < count; i++) {
      const mesh = this._acquireMesh()

      // Farbe: zufälliger Hue
      const hue = Math.random()
      mesh.material.color.setHSL(hue, this.colorHSL.s, this.colorHSL.l)
      mesh.material.opacity = this.baseOpacity

      // Start-TRS
      mesh.position.copy(pos)
      mesh.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      )

      // Velocity
      const dir = new THREE.Vector3(
        (Math.random() - 0.5) * spread,
        Math.random() * spread + 0.6,
        (Math.random() - 0.5) * spread
      ).normalize()
      const vel = dir.multiplyScalar(speed * (0.4 + Math.random() * 0.8))

      // Angular Velocity
      const angVel = new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6
      )

      // An Szene hängen und registrieren
      this.scene.add(mesh)
      this.particles.push({
        mesh,
        vel,
        angVel,
        age: 0,
        life,
      })
    }
  }

  /**
   * Pro Frame updaten
   * @param {number} dt Sekunden
   */
  update(dt) {
    const g = this.gravity
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      // Gravity
      p.vel.y -= g * dt
      // Integrate
      p.mesh.position.addScaledVector(p.vel, dt)
      p.mesh.rotation.x += p.angVel.x * dt
      p.mesh.rotation.y += p.angVel.y * dt
      p.mesh.rotation.z += p.angVel.z * dt
      // Lifetime / Fade
      p.age += dt
      const t = Math.min(1, p.age / p.life)
      p.mesh.material.opacity = this.baseOpacity * (1 - t)

      if (p.age >= p.life) {
        this.scene.remove(p.mesh)
        this._releaseMesh(p.mesh)
        this.particles.splice(i, 1)
      }
    }
  }

  /**
   * Aufräumen (z. B. beim Routenwechsel)
   */
  dispose() {
    // aktive Partikel entfernen
    for (const p of this.particles) {
      this.scene.remove(p.mesh)
      // Materialien bewusst NICHT disposen, da sie im Pool liegen könnten
      this._releaseMesh(p.mesh)
    }
    this.particles.length = 0

    // Pool-Materialien/Geometrie entsorgen
    for (const m of this.pool) {
      m.geometry?.dispose?.()
      m.material?.dispose?.()
    }
    this.pool.length = 0
    this.geo?.dispose?.()
  }
}