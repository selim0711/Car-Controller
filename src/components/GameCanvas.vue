<template>
  <canvas ref="canvas" class="webgl"></canvas>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as CANNON from 'cannon-es'
import Stats from 'stats.js'
import Car from '../world/car.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const canvas = ref(null)
let renderer, scene, camera, controls, world, stats, rafId
const sizes = { width: window.innerWidth, height: window.innerHeight }

function init() {
  stats = new Stats(); stats.showPanel(0); document.body.appendChild(stats.dom)

  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0xFF6000, 10, 50)
  scene.background = new THREE.Color(0xFF6000)

  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
  world.broadphase = new CANNON.SAPBroadphase(world)

  const bodyMaterial = new CANNON.Material()
  const groundMaterial = new CANNON.Material()
  world.addContactMaterial(new CANNON.ContactMaterial(bodyMaterial, groundMaterial, { friction: 0.1, restitution: 0.3 }))

  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true })
  renderer.setSize(sizes.width, sizes.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true

  camera = new THREE.PerspectiveCamera(50, sizes.width / sizes.height, 0.1, 10000)
  camera.position.set(0, 4, 6)
  scene.add(camera)

  controls = new OrbitControls(camera, canvas.value)
  controls.enableDamping = true

  const dirLight = new THREE.DirectionalLight(0xF0997D, 0.8)
  dirLight.position.set(-60, 100, -10)
  dirLight.castShadow = true
  dirLight.shadow.mapSize.set(4096, 4096)
  scene.add(dirLight)

  const floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshToonMaterial({ color: 0x454545 })
  )
  floorMesh.rotation.x = -Math.PI * 0.5
  floorMesh.receiveShadow = true
  scene.add(floorMesh)

  const floorS = new CANNON.Plane()
  const floorB = new CANNON.Body({ mass: 0, material: groundMaterial })
  floorB.addShape(floorS)
  floorB.quaternion.setFromAxisAngle(new CANNON.Vec3(-1, 0, 0), Math.PI * 0.5)
  world.addBody(floorB)

  const car = new Car(scene, world)
  car.init()

  const gltfLoader = new GLTFLoader()
  gltfLoader.load('/Items/untitled.gltf', (gltf) => {
    const obj = gltf.scene
    const pos = car.car?.chassisBody?.position ?? { x: 0, y: 0, z: 0 }
    obj.position.set(pos.x + 3, pos.y, pos.z)
    obj.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
    scene.add(obj)
  }, undefined, (err) => console.error('Konnte /Items/untitled.gltf nicht laden:', err))

  window.addEventListener('resize', onResize)
  tick()
}

function onResize() {
  sizes.width = window.innerWidth
  sizes.height = window.innerHeight
  camera.aspect = sizes.width / sizes.height
  camera.updateProjectionMatrix()
  renderer.setSize(sizes.width, sizes.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
}

const timeStep = 1 / 60
let lastCallTime
function tick() {
  stats.begin()
  controls.update()
  const t = performance.now() / 1000
  if (!lastCallTime) world.step(timeStep)
  else world.step(timeStep, t - lastCallTime)
  lastCallTime = t
  renderer.render(scene, camera)
  stats.end()
  rafId = requestAnimationFrame(tick)
}

onMounted(init)
onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  window.removeEventListener('resize', onResize)
  controls?.dispose()
  renderer?.dispose()
  if (stats?.dom?.parentNode) stats.dom.parentNode.removeChild(stats.dom)
})
</script>

<style scoped>
:host, canvas { display:block; width:100%; height:100%; }
</style>
