// src/world/car.js
import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { preloader } from '@/utils/preloader' // ⬅️ lädt aus public/assets/, cached

export default class Car {
  constructor(scene, world) {
    this.scene = scene
    this.world = world

    this.car = {}
    this.chassis = {}
    this.wheels = []

    this.chassisDimension = { x: 1.96, y: 1, z: 4.3 }
    this.chassisModelPos   = { x: 0,    y: -0.63, z: 0 }
    this.wheelScale        = { frontWheel: 1.1, hindWheel: 1.1 }
    this.mass = 250

    // Input-Buffer (für applyInputs)
    this._input = { steer: 0, throttle: 0, brake: 0 }
  }

  // WICHTIG: async – wir warten auf das Laden der GLTFs
  async init() {
    await this.loadModels()
    this.setChassis()
    this.setWheels()
    this.controls()
    this.update()
  }

  async loadModels() {
    // CHASSIS – Datei liegt direkt in public/assets/chassis.gltf
    const chassisGLTF = await preloader.loadGLTF('chassis', 'chassis.gltf')
    this.chassis = chassisGLTF.scene.clone(true)
    this.chassis.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
        o.material = new THREE.MeshToonMaterial({ color: 0xFF55BB })
      }
    })
    this.scene.add(this.chassis)

    // WHEELS – Datei: public/assets/wheel.gltf
    this.wheels = []
    const wheelGLTF = await preloader.loadGLTF('wheel', 'wheel.gltf')
    for (let i = 0; i < 4; i++) {
      const model = wheelGLTF.scene.clone(true)
      this.wheels[i] = model
      if (i === 1 || i === 3)
        model.scale.set(-1 * this.wheelScale.frontWheel, 1 * this.wheelScale.frontWheel, -1 * this.wheelScale.frontWheel)
      else
        model.scale.set( 1 * this.wheelScale.frontWheel, 1 * this.wheelScale.frontWheel,  1 * this.wheelScale.frontWheel)

      model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
      this.scene.add(model)
    }
  }

  setChassis() {
    const shape = new CANNON.Box(new CANNON.Vec3(
      this.chassisDimension.x * 0.5,
      this.chassisDimension.y * 0.5,
      this.chassisDimension.z * 0.5
    ))
    const chassisBody = new CANNON.Body({
      mass: this.mass,
      material: new CANNON.Material({ friction: 0 })
    })
    chassisBody.addShape(shape)

    this.car = new CANNON.RaycastVehicle({
      chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2
    })
    this.car.addToWorld(this.world)
  }

  setWheels() {
    this.car.wheelInfos = []

    const add = (cfg) => this.car.addWheel({
      radius: 0.35,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 55,
      suspensionRestLength: 0.5,
      frictionSlip: 30,
      dampingRelaxation: 2.3,
      dampingCompression: 4.3,
      maxSuspensionForce: 10000,
      rollInfluence: 0.01,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      maxSuspensionTravel: 1,
      customSlidingRotationalSpeed: 30,
      ...cfg
    })

    add({ chassisConnectionPointLocal: new CANNON.Vec3( 0.75, 0.1, -1.32) })
    add({ chassisConnectionPointLocal: new CANNON.Vec3(-0.78, 0.1, -1.32) })
    add({ chassisConnectionPointLocal: new CANNON.Vec3( 0.75, 0.1,  1.25) })
    add({ chassisConnectionPointLocal: new CANNON.Vec3(-0.78, 0.1,  1.25) })
  }

  controls() {
    const maxSteerVal  = 0.5
    const maxForce     = 750
    const brakeForce   = 36
    const slowDownCar  = 19.6
    const keys = []

    const reset = () => {
      this.car.chassisBody.position.set(0, 4, 0)
      this.car.chassisBody.quaternion.set(0, 0, 0, 1)
      this.car.chassisBody.angularVelocity.set(0, 0, 0)
      this.car.chassisBody.velocity.set(0, 0, 0)
    }

    const applyKeyboard = () => {
      if (keys.includes('r')) reset()

      if (!keys.includes(' ')) {
        for (let i = 0; i < 4; i++) this.car.setBrake(0, i)

        if (keys.includes('a') || keys.includes('arrowleft')) {
          this.car.setSteeringValue(+maxSteerVal, 2)
          this.car.setSteeringValue(+maxSteerVal, 3)
        } else if (keys.includes('d') || keys.includes('arrowright')) {
          this.car.setSteeringValue(-maxSteerVal, 2)
          this.car.setSteeringValue(-maxSteerVal, 3)
        } else {
          this.car.setSteeringValue(0, 2)
          this.car.setSteeringValue(0, 3)
        }

        if (keys.includes('w') || keys.includes('arrowup')) {
          for (let i = 0; i < 4; i++) this.car.applyEngineForce(-maxForce, i)
        } else if (keys.includes('s') || keys.includes('arrowdown')) {
          for (let i = 0; i < 4; i++) this.car.applyEngineForce(+maxForce, i)
        } else {
          for (let i = 0; i < 4; i++) this.car.setBrake(slowDownCar, i)
        }
      } else {
        for (let i = 0; i < 4; i++) this.car.setBrake(brakeForce, i)
      }
    }

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase()
      if (!keys.includes(k)) keys.push(k)
      applyKeyboard()
    })
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase()
      const i = keys.indexOf(k)
      if (i >= 0) keys.splice(i, 1)
      applyKeyboard()
    })
  }

  /**
   * Optional: Touch/Joystick-Inputs setzen
   * @param {{steer:number, throttle:number, brake:number}} p
   *   steer    ∈ [-1..1]  (negativ = links, positiv = rechts)
   *   throttle ∈ [-1..1]  (positiv = vorwärts, negativ = rückwärts)
   *   brake    ∈ [0..1]
   */
  applyInputs(p = {}) {
    const s = Math.max(-1, Math.min(1, p.steer    ?? 0))
    const t = Math.max(-1, Math.min(1, p.throttle ?? 0))
    const b = Math.max( 0, Math.min(1, p.brake    ?? 0))
    this._input = { steer: s, throttle: t, brake: b }

    const maxSteerVal = 0.5
    const maxForce    = 750
    const brakeForce  = 36

    // Bremsen
    const brakeAmt = b * brakeForce
    for (let i = 0; i < 4; i++) this.car.setBrake(brakeAmt, i)

    // Lenken (nur Vorderachse in diesem Setup: Indizes 2 & 3)
    this.car.setSteeringValue(maxSteerVal * s, 2)
    this.car.setSteeringValue(maxSteerVal * s, 3)

    // Motor (alle Räder)
    const engine = -maxForce * t // t>0 = vorwärts → negative EngineForce
    for (let i = 0; i < 4; i++) this.car.applyEngineForce(engine, i)
  }

  update() {
    const updateWorld = () => {
      if (this.car.wheelInfos && this.chassis?.position && this.wheels[0]?.position) {
        this.chassis.position.set(
          this.car.chassisBody.position.x + this.chassisModelPos.x,
          this.car.chassisBody.position.y + this.chassisModelPos.y,
          this.car.chassisBody.position.z + this.chassisModelPos.z
        )
        this.chassis.quaternion.copy(this.car.chassisBody.quaternion)
        for (let i = 0; i < 4; i++) {
          if (this.car.wheelInfos[i] && this.wheels[i]) {
            this.car.updateWheelTransform(i)
            this.wheels[i].position.copy(this.car.wheelInfos[i].worldTransform.position)
            this.wheels[i].quaternion.copy(this.car.wheelInfos[i].worldTransform.quaternion)
          }
        }
      }
    }
    this.world.addEventListener('postStep', updateWorld)
  }
}
