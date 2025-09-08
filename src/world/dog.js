import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { preloader } from '@/utils/preloader'

export default class Dog {
  constructor(scene, world) {
    this.scene = scene
    this.world = world

    this.model = null
    this.body = null
    this.mass = 20

    // Steuerungszustand
    this._input = { steer: 0, throttle: 0, brake: 0 }
    this.maxSpeed = 6
    this.accel = 2
    this.brakeAccel = 28
    this.turnRate = 2.2
    this.frictionLin = 0.12
    this.frictionAng = 0.7

    // Jump / Ground
    this.jumpSpeed = 5.5               // Ziel-Absprunggeschwindigkeit in m/s
    this._radius = 0.05                // sehr kleiner Collider
    this._groundOffset = 0.05

    // Boden-Logik (stabil)
    this._isGrounded = false
    this._rayResult = new CANNON.RaycastResult()
    this._rayDownExtra = 0.16          // wie weit unter den Fuß strahlen (darf etwas größer sein)
    this._slopeMaxCos  = Math.cos(55 * Math.PI / 180) // bis ca. 55° als Boden
    this._groundTol    = 0.03          // Toleranz nahe am Boden

    // Anti-Doppelsprung / Feel
    this._lastGroundTime = 0
    this._lastJumpTime   = 0
    this._coyoteMs       = 120         // so lange nach Bodenkontakt darf noch gesprungen werden
    this._jumpCooldownMs = 180         // so oft max. springen
    this._maxVyAfterJump = 7.0         // Sicherheitskappe für vertikale Geschwindigkeit
  }

  async init() {
    await this.loadModel()
    this.createBody()
    this.controls()
    this.syncTransform()
  }

  setDt(dt) { this._dt = dt }

  async loadModel() {
    const gltf = await preloader.loadGLTF('manni', 'Manni.gltf')
    this.model = gltf.scene.clone(true)
    this.model.scale.set(0.1, 0.1, 0.1)
    this.model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
    // this.model.rotation.y = Math.PI
    this.scene.add(this.model)
  }

  createBody() {
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

    // Aufrecht halten (nur Yaw)
    this.world.addEventListener('postStep', () => {
      const q = this.body.quaternion
      const e = new CANNON.Vec3()
      q.toEuler(e, 'YZX')
      const yaw = e.y
      this.body.quaternion.setFromEuler(0, yaw, 0, 'YZX')
    })

    // Groundcheck + Fahr-Logik vor jedem Step
    this.world.addEventListener('preStep', () => {
      this._checkGrounded()
      this._drive()
    })
  }

  /** Stabiler Ground-Check via kurzen Ray nach unten; akzeptiert jedes Objekt (Tische etc.) */
  _checkGrounded() {
    if (!this.body || !this.world) {
      this._isGrounded = false
      return false
    }

    const now = performance.now()

    // Ray: leicht über dem Schwerpunkt starten, bis unter die "Pfote" gehen
    const startY = this.body.position.y + this._radius * 0.2
    const endY   = this.body.position.y - (this._radius + this._groundOffset + this._rayDownExtra)

    const from = new CANNON.Vec3(this.body.position.x, startY, this.body.position.z)
    const to   = new CANNON.Vec3(this.body.position.x, endY,   this.body.position.z)

    this._rayResult.reset()
    this.world.raycastClosest(
      from,
      to,
      { skipBackfaces: true, collisionFilterMask: -1, checkCollisionResponse: true },
      this._rayResult
    )

    if (!this._rayResult.hasHit) {
      this._isGrounded = false
      return false
    }

    // Normale muss "genug nach oben" zeigen (verhindert Seitenwände)
    const upDot = this._rayResult.hitNormalWorld.y
    const okSlope = upDot >= this._slopeMaxCos

    // wirklich nah am Boden (nicht schräg weit weg)
    const rayLen = startY - endY
    const closeEnough = this._rayResult.distance <= (rayLen - this._groundTol)

    this._isGrounded = okSlope && closeEnough
    if (this._isGrounded) this._lastGroundTime = now
    return this._isGrounded
  }

  get grounded() {
    return this._isGrounded
  }

  /** „Normaler“ Jump: vertikale Geschwindigkeit gezielt setzen + Coyote-Time + Cooldown */
  jump() {
    if (!this.body) return

    const now = performance.now()

    // Cooldown schützt vor zu schnellen Folgesprüngen
    if (now - this._lastJumpTime < this._jumpCooldownMs) return

    // Coyote-Time: kurz nach Verlassen des Bodens darf man noch springen
    const canCoyote = (now - this._lastGroundTime) <= this._coyoteMs

    if (this.grounded || canCoyote) {
      // kleine Fallgeschwindigkeit neutralisieren
      if (this.body.velocity.y < 0) this.body.velocity.y = 0
      // ziel-vY setzen (keine Impulse → stabil bei kleinen Collidern)
      this.body.velocity.y = Math.min(this._maxVyAfterJump, this.jumpSpeed)
      this._lastJumpTime = now
    }
  }

  _drive() {
    if (!this.body) return

    let dt = 1 / 60
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

    const want = targetSpeed - vForward
    const accel = (Math.sign(want) === Math.sign(throttle)) ? this.accel : this.brakeAccel
    const dv = Math.max(-accel * dt, Math.min(accel * dt, want))

    // Nur X/Z beschleunigen
    vel.x += forward.x * dv
    vel.z += forward.z * dv

    // Bremsen (Shift gedrückt -> brake=1)
    const brake = this._input.brake || 0
    if (brake > 0) {
      const drag = Math.min(0.98, 6 * dt * brake)
      vel.x *= (1 - drag)
      vel.z *= (1 - drag)
    }

    // Seitenschlupf dämpfen
    const newVForward = vel.x * forward.x + vel.z * forward.z
    const tanX = vel.x - forward.x * newVForward
    const tanZ = vel.z - forward.z * newVForward
    const lateralDamp = Math.min(1, 6 * dt)
    vel.x -= tanX * lateralDamp
    vel.z -= tanZ * lateralDamp
  }

  applyInputs(p = {}) {
    const s = Math.max(-1, Math.min(1, p.steer    ?? 0))
    const t = Math.max(-1, Math.min(1, p.throttle ?? 0))
    const b = Math.max( 0, Math.min(1, p.brake    ?? 0))
    this._input = { steer: s, throttle: t, brake: b }
  }

  controls() {
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

      // Shift = Bremsen; Space = Jump (onKeyDown)
      const brake = (keys.includes('shift')) ? 1 : 0
      this.applyInputs({ steer, throttle, brake })
    }

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase()
      if (!keys.includes(k)) keys.push(k)
      if (k === ' ') this.jump() // Space -> springen
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
