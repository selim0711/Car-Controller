<template>
  <!--
STAGE: Behälter für WebGL-Canvas und optionale Mobile-Controls.
Die Canvas wird von Three.js als Renderziel verwendet.
-->
  <div class="stage">
    <canvas ref="canvas" class="webgl"></canvas>

    <!-- Mobile-Controls: nur auf Touch -->
    <div v-if="isTouch" class="mobile-controls">
      <div
        ref="driveStick"
        class="stick left"
        @touchstart.prevent="stickStart('drive', $event)"
        @touchmove.prevent="stickMove('drive', $event)"
        @touchend.prevent="stickEnd('drive')"
      >
        <div class="stick-bg"></div>
        <div class="stick-knob" :style="driveStyle"></div>
      </div>

      <!-- Sprung-Button -->
      <button class="jump-btn" @touchstart.prevent="jump()">⤒</button>

      <div
        ref="lookStick"
        class="stick right"
        @touchstart.prevent="stickStart('look', $event)"
        @touchmove.prevent="stickMove('look', $event)"
        @touchend.prevent="stickEnd('look')"
      >
        <div class="stick-bg"></div>
        <div class="stick-knob" :style="lookStyle"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useVirtualSticks } from '../composables/useVirtualSticks.js'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as CANNON from 'cannon-es'
import {
  addTrimeshCollider,
  addExplicitColliderBoxes,
  addStaticMeshColliders,
  addTriggerFromMesh,
  applyUserDataColliders,
  createDynamicPropsFromGLB,
} from '../world/physics.js'
import { ConfettiSystem } from '../world/confetti.js'
import Stats from 'stats.js'
import Dog from '../world/dog.js'
import { preloader } from '../utils/preloader.js'
import CannonDebugger from 'cannon-es-debugger'

/* -------------------- Core refs -------------------- */
const canvas = ref(null)
let renderer, scene, camera, controls, world, stats, rafId
let dog
let confetti

const sizes = { width: window.innerWidth, height: window.innerHeight }
const targetPos = new THREE.Vector3()
const raycaster = new THREE.Raycaster()

/* ---------------- Cannon Debugger Toggle (P) ---------------- */
let cannonDebugger
let debugGroup
let showDebug = false
function onKeyToggleDebug(e) {
  if (e.key && e.key.toLowerCase() === 'p') {
    showDebug = !showDebug
    if (debugGroup) debugGroup.visible = showDebug
  }
}

/* ---------------- Collider-Marker Helper ---------------- */
function isColliderMarker(o) {
  const looksLike = /_col$/i.test(o.name) || o.userData?.collider === true
  const isLeaf = !o.children || o.children.length === 0
  return looksLike && isLeaf
}

/* ------------- Occlusion fading -------------- */
const blockers = []
const OCC_TARGET = 0.12
const OCC_SPEED = 0.18
const originals = new WeakMap()
let hitMeshes = new WeakSet()

function ensureUniqueMaterials(mesh) {
  if (!mesh.material) return
  if (Array.isArray(mesh.material)) {
    mesh.material = mesh.material.map(m => (m?.isMaterial ? m.clone() : m))
  } else if (mesh.material.isMaterial) {
    mesh.material = mesh.material.clone()
  }
}
function rememberOriginals(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const m of mats) {
    if (!m) continue
    if (!originals.has(m)) originals.set(m, { transparent: !!m.transparent, opacity: m.opacity ?? 1 })
  }
}
function fadeTo(mesh, target) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const m of mats) {
    if (!m) continue
    rememberOriginals(mesh)
    const curr = m.opacity ?? 1
    m.opacity = curr + (target - curr) * OCC_SPEED
    m.transparent = true
  }
}
function restoreTowardsOriginal(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const m of mats) {
    if (!m) continue
    const org = originals.get(m)
    const target = org?.opacity ?? 1
    const curr = m.opacity ?? 1
    const next = curr + (target - curr) * OCC_SPEED
    m.opacity = next
    if (Math.abs(next - target) < 0.01) {
      m.opacity = target
      m.transparent = org?.transparent ?? false
    } else {
      m.transparent = true
    }
  }
}
function registerBlockers(root) {
  root.traverse(o => {
    if (!o.isMesh) return
    if (o.userData?.noOcclude) return
    if (isColliderMarker(o)) return
    ensureUniqueMaterials(o)
    rememberOriginals(o)
    blockers.push(o)
  })
}
const rayOffsets = [
  new THREE.Vector2(0, 0),
  new THREE.Vector2(0.02, 0.02),
  new THREE.Vector2(-0.02, 0.02),
  new THREE.Vector2(0.02, -0.02),
  new THREE.Vector2(-0.02, -0.02),
]
const camDir = new THREE.Vector3()
function updateOcclusion(dogPos) {
  hitMeshes = new WeakSet()
  const dogNDC = dogPos.clone().project(camera)
  const distDog = camera.position.distanceTo(dogPos)
  for (const off of rayOffsets) {
    const ndc = new THREE.Vector3(
      THREE.MathUtils.clamp(dogNDC.x + off.x, -1, 1),
      THREE.MathUtils.clamp(dogNDC.y + off.y, -1, 1),
      dogNDC.z
    )
    const origin = camera.position.clone()
    const worldPoint = ndc.unproject(camera)
    camDir.copy(worldPoint).sub(origin).normalize()
    raycaster.set(origin, camDir)
    const hits = raycaster.intersectObjects(blockers, true)
    for (const h of hits) {
      if (h.distance >= distDog - 0.05) continue
      let mesh = h.object
      while (mesh && !mesh.isMesh) mesh = mesh.parent
      if (!mesh || mesh.userData?.noOcclude) continue
      fadeTo(mesh, OCC_TARGET)
      hitMeshes.add(mesh)
    }
  }
  for (const mesh of blockers) {
    if (!hitMeshes.has(mesh)) restoreTowardsOriginal(mesh)
  }
}

/* ---------------- Mobile-Controls via Composable ---------------- */
const {
  isTouch, drive, look,
  driveStick, lookStick,
  driveStyle, lookStyle,
  stickStart, stickMove, stickEnd,
  updateIsTouch,
} = useVirtualSticks()

/* ===================== Interactables (Outline + 3D Panel) ===================== */
const hovered = { mesh: null }
const outlineMap = new WeakMap()
let openPanel = null  // { group, targetMesh, url }

function makeOutline(mesh, color = 0x44ccff) {
  if (outlineMap.has(mesh)) return outlineMap.get(mesh)
  const g = mesh.geometry.clone()
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide
  })
  const outline = new THREE.Mesh(g, m)
  outline.renderOrder = 999
  outline.visible = false
  const O = 1.03
  outline.scale.set(O, O, O)
  mesh.add(outline)
  outlineMap.set(mesh, outline)
  return outline
}
function showOutline(mesh, on) { makeOutline(mesh).visible = !!on }

function createTextSprite(text) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const pad = 24
  const fontPx = 48
  ctx.font = `${fontPx}px Inter, system-ui, sans-serif`
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2
  const h = fontPx + pad * 2
  canvas.width = w
  canvas.height = h
  ctx.font = `${fontPx}px Inter, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, h / 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true })
  mat.depthTest = false
  mat.depthWrite = false
  const sprite = new THREE.Sprite(mat)
  const scale = 0.005
  sprite.scale.set(w * scale, h * scale, 1)
  return sprite
}
function createInfoPanel(text, url) {
  const group = new THREE.Group()
  const sprite = createTextSprite(text)
  const padX = 0.06, padY = 0.04
  const bgGeo = new THREE.PlaneGeometry(sprite.scale.x + padX, sprite.scale.y + padY)
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.85 })
  bgMat.depthTest = false
  bgMat.depthWrite = false
  const bg = new THREE.Mesh(bgGeo, bgMat)
  bg.position.set(0, 0, -0.001)
  group.add(bg)
  group.add(sprite)
  group.renderOrder = 10000
  group.userData.url = url
  group.visible = false
  scene.add(group)
  return group
}
function openInfoFor(mesh) {
  const info = mesh.userData?.info || {}
  const txt = info.text || 'Mehr Infos'
  const url = info.url || 'https://example.com'
  if (!openPanel) openPanel = { group: createInfoPanel(txt, url), targetMesh: mesh, url }
  openPanel.group.userData.url = url
  openPanel.targetMesh = mesh
  const box = new THREE.Box3().setFromObject(mesh)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size); box.getCenter(center)
  openPanel.group.position.copy(center).add(new THREE.Vector3(0, size.y * 0.6, 0))
  openPanel.group.visible = true
}
function closeInfo() { if (openPanel) openPanel.group.visible = false }
function billboardPanelToCamera() {
  if (openPanel?.group?.visible) {
    openPanel.group.lookAt(camera.position)
  }
}

function worldRayFromEvent(e) {
  const rect = canvas.value.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera({ x, y }, camera)
}
function isDescendantOf(obj, root) {
  let o = obj
  while (o) { if (o === root) return true; o = o.parent }
  return false
}
function isBlockingMesh(o) {
  if (!o?.isMesh) return false
  if (!o.visible) return false
  if (o.userData?.noOcclude) return false
  if (isColliderMarker(o)) return false
  if (openPanel?.group && isDescendantOf(o, openPanel.group)) return false
  return true
}
/** Nur anklickbar, wenn es frontal getroffen wird. */
function pickInteractableVisible() {
  const hits = raycaster.intersectObjects(scene.children, true)
  for (const h of hits) {
    if (openPanel?.group && isDescendantOf(h.object, openPanel.group)) continue
    let o = h.object
    while (o && !o.userData?.interactable) o = o.parent
    if (o?.userData?.interactable) return o
    if (isBlockingMesh(h.object)) return null
  }
  return null
}
function onPointerMove(e) {
  worldRayFromEvent(e)
  const hit = pickInteractableVisible()
  if (hovered.mesh !== hit) {
    if (hovered.mesh) showOutline(hovered.mesh, false)
    hovered.mesh = hit
    if (hovered.mesh) showOutline(hovered.mesh, true)
    if (canvas.value) canvas.value.style.cursor = hit ? 'pointer' : 'default'
  }
}
function onClick(e) {
  worldRayFromEvent(e)
  if (openPanel?.group?.visible) {
    const hits = raycaster.intersectObject(openPanel.group, true)
    if (hits.length) {
      const url = openPanel.group.userData.url
      if (url) window.open(url, '_blank')
      return
    }
  }
  const hit = pickInteractableVisible()
  if (hit) openInfoFor(hit)
  else closeInfo()
}
function bindCanvasEvents() {
  const dom = canvas.value
  dom?.addEventListener('pointermove', onPointerMove)
  dom?.addEventListener('click', onClick)
}
function unbindCanvasEvents() {
  const dom = canvas.value
  dom?.removeEventListener('pointermove', onPointerMove)
  dom?.removeEventListener('click', onClick)
}

/* =================== INIT =================== */
async function init() {
  stats = new Stats(); stats.showPanel(0); document.body.appendChild(stats.dom)

  // Scene
  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x87CEEB, 30, 100)
  scene.background = new THREE.Color(0x87CEEB)
  confetti = new ConfettiSystem(scene)

  // Physics
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
  world.solver.iterations = 20
  world.solver.tolerance = 0.001
  world.defaultContactMaterial.friction = 0.6
  world.defaultContactMaterial.restitution = 0.0
  world.defaultContactMaterial.contactEquationStiffness = 1e7
  world.defaultContactMaterial.contactEquationRelaxation = 3
  world.broadphase = new CANNON.SAPBroadphase(world)
  const bodyMaterial = new CANNON.Material()
  const envMaterial = new CANNON.Material()
  world.addContactMaterial(new CANNON.ContactMaterial(bodyMaterial, envMaterial, { friction: 0.7, restitution: 0.0 }))

  // Renderer
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true })
  renderer.setSize(sizes.width, sizes.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0

  // Camera + Controls
  camera = new THREE.PerspectiveCamera(50, sizes.width / sizes.height, 0.1, 10000)
  camera.position.set(0, 3.0, 6.0)
  scene.add(camera)

  controls = new OrbitControls(camera, canvas.value)
  controls.enableDamping = true
  controls.enablePan = false
  controls.minDistance = 2
  controls.maxDistance = 25

  updateIsTouch()
  controls.enableZoom = !isTouch.value
  watch(isTouch, v => { controls.enableZoom = !v })

  // Lights
  const dirLight = new THREE.DirectionalLight(0xFFF5E1, 1)
  dirLight.position.set(-60, 100, -10)
  dirLight.castShadow = true
  dirLight.shadow.bias = -0.0001
  dirLight.shadow.normalBias = 0.02
  dirLight.shadow.mapSize.set(4096, 4096)
  scene.add(dirLight)
  scene.add(new THREE.AmbientLight(0xFFF8E7, 0.4))

  // Load GLB level
  let dynamicPairs = []
  try {
    const gltf = await preloader.loadGLTF('level', 'scene.glb')
    const level = gltf.scene.clone(true)

    level.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
      if (isColliderMarker(o)) {
        if (o.isMesh) o.visible = false
        o.userData.noOcclude = true
      }
    })
    scene.add(level)

    // Goal-Trigger
    level.traverse(o => {
      if (o.isMesh && o.userData?.trigger === 'goal') {
        o.visible = false
        addTriggerFromMesh(world, o, {
          onEnter: (_ballBody, _triggerBody, goalCenter) => {
            confetti?.spawnAt(goalCenter, { count: 140, speed: 5, spread: 1.4, life: 1.8 })
          }
        })
        o.userData._hasCollider = true
      }
    })

    // Auto-Wände
    level.traverse(o => {
      if (o.isMesh && /wand/i.test(o.name)) {
        addTrimeshCollider(world, o)
        o.userData._hasCollider = true
        o.userData.collider = 'none'
      }
    })

    // UserData-Collider (inkl. Ball)
    applyUserDataColliders(scene, world, level, dynamicPairs)

    // Interactables Default-Info
    level.traverse(o => {
      if (o.isMesh && o.userData?.interactable) {
        o.userData.info ??= { text: 'Kurzer Info-Text', url: 'https://www.studiomerkas.com/de/projekte/muddinis-adventure' }
      }
    })

    // Dynamische Props
    const morePairs = createDynamicPropsFromGLB(scene, world, level, {
      matchName: /^(monitor|screen|display)/i,
      mass: 2.5,
      friction: 0.6,
      restitution: 0.05,
      linearDamping: 0.05,
      angularDamping: 0.12,
      reparentToScene: true,
    })
    dynamicPairs.push(...morePairs)

    // Rest statische Umgebung
    addStaticMeshColliders(world, level, isColliderMarker)
    addExplicitColliderBoxes(world, level, isColliderMarker)

    // Occlusion blockers
    registerBlockers(level)
  } catch (err) {
    console.error('SCENE load error', err)
  }

  // Dog
  dog = new Dog(scene, world)
  await dog.init()
  dog.controls()
  dog?.model?.traverse(o => { if (o.isMesh) o.userData.noOcclude = true })

  if (dog?.body) {
    const p = dog.body.position
    controls.target.set(p.x, p.y + 0.5, p.z)
  }

  // Debugger
  debugGroup = new THREE.Group()
  debugGroup.visible = showDebug
  scene.add(debugGroup)
  cannonDebugger = CannonDebugger(debugGroup, world, { color: 0xff0000 })

  // Sync dyn meshes ⇄ bodies
  world.addEventListener('postStep', () => {
    for (const { object, body } of dynamicPairs) {
      object.position.set(body.position.x, body.position.y, body.position.z)
      object.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w)
    }
  })

  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onKeyToggleDebug)
}

/* ------------------- Resize & Loop ------------------- */
function onResize() {
  sizes.width = window.innerWidth
  const hud = document.querySelector('.hud')
  sizes.height = window.innerHeight - (hud?.offsetHeight ?? 0)
  camera.aspect = sizes.width / sizes.height
  camera.updateProjectionMatrix()
  renderer.setSize(sizes.width, sizes.height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
}

const timeStep = 1 / 60
let lastCallTime

function tick() {
  stats.begin()

  const t = performance.now() / 1000
  let dt = timeStep
  if (lastCallTime) dt = t - lastCallTime
  if (dog?.setDt) dog.setDt(Math.max(1/120, Math.min(1/20, dt)))

  if (dog) dog.update(dt)
  confetti?.update(dt)

  if (!lastCallTime) world.step(timeStep)
  else world.step(timeStep, t - lastCallTime)
  lastCallTime = t

  if (dog?.body) {
    const p = dog.body.position
    targetPos.set(p.x, p.y + 0.5, p.z)
    controls.target.copy(targetPos)
    const dogPos = new THREE.Vector3(p.x, p.y + 0.5, p.z)
    updateOcclusion(dogPos)
  }

  billboardPanelToCamera()

  if (showDebug && cannonDebugger) cannonDebugger.update()
  controls.update()
  renderer.render(scene, camera)
  stats.end()
  rafId = requestAnimationFrame(tick)
}

/* ------------------- Misc ------------------- */
function jump(){ dog?.jump() }

onMounted(async () => {
  updateIsTouch()
  await init()
  bindCanvasEvents()
  tick()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKeyToggleDebug)
  unbindCanvasEvents()
  controls?.dispose()
  renderer?.dispose()
  confetti?.dispose()
  if (stats?.dom?.parentNode) stats.dom.parentNode.removeChild(stats.dom)
})
</script>

<style scoped src="./GameCanvas.css"></style>