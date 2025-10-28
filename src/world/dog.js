// src/world/dog.js
// Hauptklasse für den Spieler-Charakter (Dog / Manni).
// Verknüpft 3D-Modell (THREE) mit Physik (CANNON) und steuert Bewegung + Animation.

import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { preloader } from '@/utils/preloader'

export default class Dog {
  constructor(scene, world) {
    this.scene = scene
    this.world = world

    this.model = null               // Visueller Pivot (THREE.Group), folgt der Physik 1:1
    this.body = null                // CANNON-Body für Kollision/Bewegung
    this.mass = 20

    // Jump-Playback: ab ca. 60% der Jump-Clipzeit langsamer → sanftere Landung/„Hangtime“
    this._jumpSlowStart = 0.6
    this._jumpSlowFactor = 0.1      // auf ~10% der normalen Abspielgeschwindigkeit

    // Steuerung/Physik
    this._input = { steer: 0, throttle: 0, brake: 0 } // wird von controls()/applyInputs() gesetzt
    this.maxSpeed = 6               // Top-Speed (m/s)
    this.accel = 2                  // Vortrieb
    this.brakeAccel = 28            // Gegenmoment beim Umpolen / Reversen
    this.turnRate = 2.2             // Yaw-Rotation pro Sekunde (wird mit dt skaliert)
    this.frictionLin = 0.12         // lineare Dämpfung (Ausrollen)
    this.frictionAng = 0.7          // Drehdämpfung (Yaw-Jitter)

    // Jump/Ground
    this.jumpSpeed = 5.5            // initiale vertikale Geschwindigkeit beim Sprung
    this._radius = 0.05             // Sphärenradius des Bodys
    this._groundOffset = 0.05       // optischer Offset Pivot→Boden (Füße nicht im Boden)

    // Groundcheck (Raycast nach unten)
    this._isGrounded = false
    this._rayResult = new CANNON.RaycastResult()
    this._rayDownExtra = 0.16       // extra Ray-Länge für Kanten/Stufen
    this._slopeMaxCos  = Math.cos(55 * Math.PI / 180) // max. Steigung ~55°
    this._groundTol    = 0.03       // Toleranz für „nah genug“ am Boden

    // Jump-Zeitfenster (Coyote + Cooldown)
    this._lastGroundTime = 0
    this._lastJumpTime   = 0
    this._coyoteMs       = 120      // nach Verlassen der Kante darf noch kurz gesprungen werden
    this._jumpCooldownMs = 180      // verhindert Jump-Spam
    this._maxVyAfterJump = 7.0      // Cap, falls externe Kräfte Y hochschieben

    // Animation
    this.mixer = null
    this._a = { idle: null, walk: null, jump: null } // AnimationActions (werden in loadModel gesetzt)
    this._jumpActive = false          // true, solange Jump-OneShot dominiert
    this._wasGrounded = false         // für Landed-Detection (Flanke)

    // Locomotion-Blend Tuning
    this._walkThreshold = 0.04                 // erste Fassung (unten wird überschrieben)
    this._walkMaxSpeedFor1 = this.maxSpeed * 0.6 // bei ~60% Top-Speed ist Walk voll eingeblendet

    // Achtung: das überschreibt den Wert oben (Intent: höherer Einstieg ins Walk)
    this._walkThreshold = 0.10
    this._walkEase = 14                // aktuell nicht genutzt – Hook für künftiges Easing
  }

  async init() {
    // Lebenszyklus: Modell/Clips laden → Physik anlegen → Input binden → Transform koppeln
    await this.loadModel()
    this.createBody()
    this.controls()
    this.syncTransform()
  }

  setDt(dt) { this._dt = dt } // optionaler dt von außen (z.B. zentraler Timestep)

  // WICHTIG: im Renderloop aufrufen (damit der Mixer tickt)
  update(dt = 1/60) {
  if (this.mixer) {
    // Clamp gegen große Frame-Gaps → verhindert Sprünge in der Anim
    const safeDt = Math.min(dt, 1/30)  // kein Animationsschritt größer als ~33 ms
    this.mixer.update(safeDt)
  }
  this._updateAnimLogic(dt)            // Blend/Zeitskalen/Jumplogik
}

  // ----------------------------------------
  // Load model + setup animations
  // ----------------------------------------
  async loadModel() {
    // Lädt GLTF + Animationsclips über den projektweiten Preloader (Cache etc.)
    const gltf = await preloader.loadGLTF('manni', 'Manni.gltf')

    // Pivot folgt später der Physik (Position/Rotation). Visual hängt darunter.
    const pivot = new THREE.Group()
    pivot.name = 'PLAYER_MANNI'
    pivot.scale.set(1, 1, 1)

    // Visual (GLTF scene) → 180° Flip NUR am Visual (nicht am Pivot!)
    // Grund: Modell-Forward ≠ Welt-Forward; so stimmt die Blickrichtung.
    const visual = gltf.scene
    visual.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false }
    })
    visual.rotation.y = Math.PI
    pivot.add(visual)

    this.model = pivot
    this.scene.add(this.model)

    // Animationen: Idle/Walk laufen permanent; wir steuern nur die Gewichte
    this.mixer = new THREE.AnimationMixer(this.model)

    const clips = gltf.animations || []
    const pick = (hints) => {
      const L = hints.map(s => s.toLowerCase())
      return clips.find(c => L.some(h => (c.name || '').toLowerCase().includes(h))) || null
    }

    const walkClip = pick(['walk','walking'])
    const idleClip = pick(['idle','stand'])
    const jumpClip = pick(['jump','jumping'])

    if (idleClip) this._a.idle = this.mixer.clipAction(idleClip)
    if (walkClip) this._a.walk = this.mixer.clipAction(walkClip)
    if (jumpClip) this._a.jump = this.mixer.clipAction(jumpClip)

    // Locomotion immer laufen lassen – Gewichte steuern wir per speed
    if (this._a.idle) {
      this._a.idle.setLoop(THREE.LoopRepeat, Infinity)
      this._a.idle.reset().play()
      this._a.idle.enabled = true
      this._a.idle.weight = 1 // Start: nur Idle sichtbar
    }
    if (this._a.walk) {
      this._a.walk.setLoop(THREE.LoopRepeat, Infinity)
      this._a.walk.reset().play()
      this._a.walk.enabled = true
      this._a.walk.weight = 0 // Start: Walk unsichtbar
    }

    // Jump läuft als OneShot „drüber“ (Gewicht 0 bis aktiv)
    if (this._a.jump) {
      this._a.jump.setLoop(THREE.LoopOnce, 1)
      this._a.jump.clampWhenFinished = true
      this._a.jump.reset().play()
      this._a.jump.enabled = true
      this._a.jump.weight = 0
    }

    this._jumpActive = false

    // Sync: Walk-Phase an Idle → saubere Übergänge bei Start/Stop
    if (this._a.idle && this._a.walk) {
  this._a.walk.syncWith(this._a.idle)
}
  }

  _updateAnimLogic() {
    if (!this.body || !this._a) return

    const grounded = this.grounded
    const v = this.body.velocity
    const speed = Math.hypot(v.x, v.z)

    // Walk-Tempo an reale Geschwindigkeit koppeln (fühlt sich natürlicher an)
    if (this._a.walk) {
  // relative Geschwindigkeit ~0..2, dann gedeckelt
  const rel = THREE.MathUtils.clamp(this.body ? Math.hypot(this.body.velocity.x, this.body.velocity.z) / (this.maxSpeed * 0.6) : 0, 0, 2)
  const t = THREE.MathUtils.clamp(1.3 + rel * 1.2, 1.3, 3.0) // höheres Basistempo
  this._a.walk.setEffectiveTimeScale(t)  // glättet besser als .timeScale

    }

    // Locomotion-Blend (Idle ↔ Walk), solange kein aktiver Jump
    if (!this._jumpActive) {
      const k = THREE.MathUtils.clamp(
        (speed - this._walkThreshold) /
        Math.max(0.0001, (this._walkMaxSpeedFor1 - this._walkThreshold)),
        0, 1
      )
      if (this._a.walk) this._a.walk.weight = k
      if (this._a.idle) this._a.idle.weight = 1 - k
    }

if (this._jumpActive && this._a.jump) {
  const J = this._a.jump
  const dur = J.getClip()?.duration ?? 0
  const t   = J.time

  // Gegen Ende verlangsamen (siehe _jumpSlowStart/_jumpSlowFactor)
  if (dur > 0) {
    const frac = t / dur
    if (frac >= this._jumpSlowStart) {
      J.timeScale = this._jumpSlowFactor
    } else {
      J.timeScale = 1.0
    }
  }

  const nearEnd = t >= Math.max(0, dur - 0.05) // Ende-Puffer
  const landed  = this.grounded && !this._wasGrounded // Landung erkannt (Flanke)

  if (landed || nearEnd) {
    J.weight = 0
    this._jumpActive = false
  } else {
    // Solange Jump aktiv ist, Idle/Walk ausblenden
    if (this._a.walk) this._a.walk.weight = 0
    if (this._a.idle) this._a.idle.weight = 0
    J.weight = 1
  }
}


    this._wasGrounded = grounded
  }

  // ----------------------------------------
  // Physics
  // ----------------------------------------
  createBody() {
    // Einfache Kugel-Kollision: robust gegen Kanten/Stufen, wenig Hängenbleiben
    const shape = new CANNON.Sphere(this._radius)
    this.body = new CANNON.Body({
      mass: this.mass,
      shape,
      material: new CANNON.Material({ friction: 0.6, restitution: 0 }),
      linearDamping: this.frictionLin,
      angularDamping: this.frictionAng,
    })
    this.body.position.set(1.5, this._radius + this._groundOffset, 0)
    this.world.addBody(this.body)

    // Aufrecht halten (nur Yaw zulassen) → verhindert Umkippen
    this.world.addEventListener('postStep', () => {
      const q = this.body.quaternion
      const e = new CANNON.Vec3()
      q.toEuler(e, 'YZX')
      const yaw = e.y
      this.body.quaternion.setFromEuler(0, yaw, 0, 'YZX')
    })

    // Groundcheck + Fahr-Logik (vor der Integration)
    this.world.addEventListener('preStep', () => {
      this._checkGrounded()
      this._drive()
    })
  }

  _checkGrounded() {
    // Ray von leicht über Mittelpunkt zu etwas unterhalb des erwarteten Bodens
    if (!this.body || !this.world) { this._isGrounded = false; return false }
    const now = performance.now()
    const startY = this.body.position.y + this._radius * 0.2
    const endY   = this.body.position.y - (this._radius + this._groundOffset + this._rayDownExtra)

    const from = new CANNON.Vec3(this.body.position.x, startY, this.body.position.z)
    const to   = new CANNON.Vec3(this.body.position.x, endY,   this.body.position.z)

    this._rayResult.reset()
    this.world.raycastClosest(from, to,
      { skipBackfaces: true, collisionFilterMask: -1, checkCollisionResponse: true },
      this._rayResult
    )

    if (!this._rayResult.hasHit) { this._isGrounded = false; return false }

    const upDot = this._rayResult.hitNormalWorld.y     // y-Anteil der Flächennormalen
    const okSlope = upDot >= this._slopeMaxCos         // Steigung im erlaubten Bereich?
    const rayLen = startY - endY
    const closeEnough = this._rayResult.distance <= (rayLen - this._groundTol)

    this._isGrounded = okSlope && closeEnough
    if (this._isGrounded) this._lastGroundTime = now    // für Coyote-Zeit
    return this._isGrounded
  }

  get grounded() { return this._isGrounded }

jump() {
  // Public: wird von Space im controls() oder extern aufgerufen
  if (!this.body) return

  const now = performance.now()
  if (now - this._lastJumpTime < this._jumpCooldownMs) return

  const canCoyote = (now - this._lastGroundTime) <= this._coyoteMs
  if (this.grounded || canCoyote) {
    // Physik: nach unten fallende Vy kappen, dann Jump-Vy setzen
    if (this.body.velocity.y < 0) this.body.velocity.y = 0
    this.body.velocity.y = Math.min(this._maxVyAfterJump, this.jumpSpeed)
    this._lastJumpTime = now

    // Animation: sofort starten (kein 1-Frame-Delay)
    if (this._a?.jump) {
      const J = this._a.jump
      J.enabled = true
      J.paused = false
      J.reset()            // von vorn
      J.time = 0           // garantiert am Clipstart
      J.weight = 1         // sichtbar

      // Locomotion sofort ausblenden
      if (this._a.walk) this._a.walk.weight = 0
      if (this._a.idle) this._a.idle.weight = 0

      this._jumpActive = true

      // Mixer direkt evaluieren → visuell keine Verzögerung
      if (this.mixer) this.mixer.update(0)
    }
  }
}

  _drive() {
    // Simpler „Fahr“-Charakter: Yaw drehen, Vortrieb entlang Forward, Dämpfung quer
    if (!this.body) return

    // dt clampen, damit die Kräfte stabil bleiben
    let dt = 1/60
    if (this._dt && Number.isFinite(this._dt)) dt = Math.max(1/120, Math.min(1/20, this._dt))

    // Lenkung (nur yaw) – invertiert, damit A=links, D=rechts
    const steer = this._input.steer || 0
    const yawDelta = -steer * this.turnRate * dt
    if (Math.abs(yawDelta) > 1e-6) {
      const q = new CANNON.Quaternion()
      q.setFromEuler(0, yawDelta, 0, 'YZX')
      this.body.quaternion = this.body.quaternion.mult(q)
    }

    // Vorwärtsrichtung aus Quaternion (THREE), auf X/Z
    const tq = new THREE.Quaternion(
      this.body.quaternion.x,
      this.body.quaternion.y,
      this.body.quaternion.z,
      this.body.quaternion.w
    )
    const f3 = new THREE.Vector3(0, 0, -1).applyQuaternion(tq).setY(0).normalize()
    const forward = { x: f3.x, z: f3.z }

    const vel = this.body.velocity
    const vForward = vel.x * forward.x + vel.z * forward.z

    const throttle = this._input.throttle || 0
    const targetSpeed = this.maxSpeed * throttle

    // Wunschgeschwindigkeit entlang Forward → begrenzte Beschleunigungsänderung dv
    const want = targetSpeed - vForward
    const accel = (Math.sign(want) === Math.sign(throttle)) ? this.accel : this.brakeAccel
    const dv = Math.max(-accel * dt, Math.min(accel * dt, want))

    // Nur X/Z beschleunigen
    vel.x += forward.x * dv
    vel.z += forward.z * dv

    // Bremsen (Shift) → isotrope Dämpfung in X/Z
    const brake = this._input.brake || 0
    if (brake > 0) {
      const drag = Math.min(0.98, 6 * dt * brake)
      vel.x *= (1 - drag)
      vel.z *= (1 - drag)
    }

    // Seitenschlupf dämpfen → weniger „Schlittern“
    const newVForward = vel.x * forward.x + vel.z * forward.z
    const tanX = vel.x - forward.x * newVForward
    const tanZ = vel.z - forward.z * newVForward
    const lateralDamp = Math.min(1, 6 * dt)
    vel.x -= tanX * lateralDamp
    vel.z -= tanZ * lateralDamp
  }

  applyInputs(p = {}) {
    // Externer Input-Einstieg (z.B. Gamepad, anderes Inputsystem)
    const s = Math.max(-1, Math.min(1, p.steer    ?? 0))
    const t = Math.max(-1, Math.min(1, p.throttle ?? 0))
    const b = Math.max( 0, Math.min(1, p.brake    ?? 0))
    this._input = { steer: s, throttle: t, brake: b }
  }

  controls() {
    // Minimaler integrierter Keyboard-Handler (WASD/Arrows, Shift=Brake, Space=Jump, R=Reset)
    const keys = []

    const reset = () => {
      const r = this._radius
      this.body.position.set(1.5, r + this._groundOffset, 0)
      this.body.velocity.set(0, 0, 0)
      this.body.angularVelocity.set(0, 0, 0)
      this.body.quaternion.setFromEuler(0, 0, 0, 'YZX')
    }

    const apply = () => {
      if (keys.includes('r')) reset()

      let steer = 0
      if (keys.includes('a') || keys.includes('arrowleft'))  steer += -1
      if (keys.includes('d') || keys.includes('arrowright')) steer += +1

      let throttle = 0
      if (keys.includes('w') || keys.includes('arrowup'))    throttle += +1
      if (keys.includes('s') || keys.includes('arrowdown'))  throttle += -1

      const brake = (keys.includes('shift')) ? 1 : 0
      this.applyInputs({ steer, throttle, brake })
    }

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase()
      if (!keys.includes(k)) keys.push(k)
      if (k === ' ') this.jump()  // Space → Jump
      apply()
    })
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase()
      const i = keys.indexOf(k)
      if (i >= 0) keys.splice(i, 1)
      apply()
    })
  }

  syncTransform() {
    // Kopplung: Visual folgt Body (Position leicht nach unten versetzt um den Radius)
    const update = () => {
      if (!this.model || !this.body) return
      this.model.position.set(
        this.body.position.x,
        this.body.position.y - this._radius,
        this.body.position.z
      )
      this.model.quaternion.set(
        this.body.quaternion.x,
        this.body.quaternion.y,
        this.body.quaternion.z,
        this.body.quaternion.w
      )
    }
    this.world.addEventListener('postStep', update)
  }
}