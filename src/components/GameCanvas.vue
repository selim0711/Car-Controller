<template>
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
import { onMounted, onBeforeUnmount, ref, reactive, computed } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as CANNON from 'cannon-es'
import Stats from 'stats.js'
import Dog from '../world/dog.js'
import { preloader } from '../utils/preloader.js'
import CannonDebugger from 'cannon-es-debugger'

/* -------------------- Core refs -------------------- */
const canvas = ref(null)
let renderer, scene, camera, controls, world, stats, rafId
let dog

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
  const isLeaf    = !o.children || o.children.length === 0
  return looksLike && isLeaf
}

/* ------------- More-accurate occlusion fading -------------- */
const blockers = []
const OCC_TARGET = 0.12
const OCC_SPEED  = 0.18
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
  root.traverse((o) => {
    if (!o.isMesh) return
    if (o.userData?.noOcclude) return
    if (isColliderMarker(o)) return
    ensureUniqueMaterials(o)
    rememberOriginals(o)
    blockers.push(o)
  })
}
const rayOffsets = [
  new THREE.Vector2(0,0),
  new THREE.Vector2( 0.02,  0.02),
  new THREE.Vector2(-0.02,  0.02),
  new THREE.Vector2( 0.02, -0.02),
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

/* ------------------- Touch sticks ------------------- */
const isTouch = ref(false)
function updateIsTouch() {
  const coarse = window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches
  isTouch.value = !!coarse || 'ontouchstart' in window
}
const stickRadius = 40
const drive = reactive({ x:0, y:0, dx:0, dy:0, active:false })
const look  = reactive({ x:0, y:0, dx:0, dy:0, active:false })
const driveCenter = ref({x:0, y:0})
const lookCenter  = ref({x:0, y:0})
const driveStick = ref(null)
const lookStick = ref(null)
const driveStyle = computed(() => ({ transform:`translate(${drive.dx}px,${drive.dy}px)` }))
const lookStyle  = computed(() => ({ transform:`translate(${look.dx}px,${look.dy}px)` }))
function stickStart(which, e){
  const el = which==='drive'?driveStick.value:lookStick.value
  const r = el.getBoundingClientRect()
  const c = {x:r.left+r.width/2, y:r.top+r.height/2}
  if(which==='drive') driveCenter.value=c; else lookCenter.value=c
  stickMove(which, e)
  if(which==='drive') drive.active=true; else look.active=true
}
function stickMove(which, e){
  const t = e.touches[0]
  const c = which==='drive'?driveCenter.value:lookCenter.value
  const dx = t.clientX - c.x
  const dy = t.clientY - c.y
  const len = Math.hypot(dx,dy), k = len>stickRadius?stickRadius/len:1
  const ndx = dx*k, ndy = dy*k
  if(which==='drive'){
    drive.dx=ndx; drive.dy=ndy
    drive.x = THREE.MathUtils.clamp(ndx/stickRadius, -1, 1)
    drive.y = THREE.MathUtils.clamp(-ndy/stickRadius, -1, 1)
  } else {
    look.dx=ndx; look.dy=ndy
    look.x = THREE.MathUtils.clamp(ndx/stickRadius, -1, 1)
    look.y = THREE.MathUtils.clamp(-ndy/stickRadius, -1, 1)
  }
}
function stickEnd(which){
  if(which==='drive'){ drive.dx=drive.dy=0; drive.x=drive.y=0; drive.active=false }
  else { look.dx=look.dy=0; look.x=look.y=0; look.active=false }
}

/* ============ Welt-TRS Helpers ============ */
const _wPos = new THREE.Vector3()
const _wQuat = new THREE.Quaternion()
const _wScale = new THREE.Vector3()
function getWorldTRS(obj){
  obj.updateWorldMatrix(true, false)
  obj.getWorldPosition(_wPos)
  obj.getWorldQuaternion(_wQuat)
  obj.getWorldScale(_wScale)
  return { pos: _wPos.clone(), quat: _wQuat.clone(), scale: _wScale.clone() }
}

/* ============ Explode InstancedMesh (falls nötig) ============ */
function explodeInstances(instancedMesh) {
  const instances = []
  const geom = instancedMesh.geometry
  const mat  = instancedMesh.material
  const count = instancedMesh.count
  const baseName = instancedMesh.name || 'instance'
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    instancedMesh.getMatrixAt(i, m)
    m.decompose(p, q, s)
    const mesh = new THREE.Mesh(
      geom.clone(),
      Array.isArray(mat) ? mat.map(x=>x.clone()) : mat.clone()
    )
    mesh.name = `${baseName}_${i}`
    mesh.position.copy(p)
    mesh.quaternion.copy(q)
    mesh.scale.copy(s)
    mesh.updateMatrixWorld(true)
    mesh.userData.physics = instancedMesh.userData?.physics || 'dynamic'
    instancedMesh.parent.add(mesh)
    instances.push(mesh)
  }
  instancedMesh.parent?.remove(instancedMesh)
  return instances
}

/* ============ Dynamische Props (Monitore etc.) – OBB-Körper ============ */
function getLocalHalfExtentsScaled(mesh) {
  const geo = mesh.geometry
  if (!geo.boundingBox) geo.computeBoundingBox()
  const bb = geo.boundingBox
  const sizeLocal = new THREE.Vector3().subVectors(bb.max, bb.min)
  const centerLocal = new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5)
  const { scale } = getWorldTRS(mesh)
  sizeLocal.multiply(scale)
  centerLocal.multiply(scale)
  const half = sizeLocal.multiplyScalar(0.5)
  return { half, centerLocal }
}
function buildOBBBodyFromObject(root, {
  mass = 2,
  friction = 0.6,
  restitution = 0.05,
  linearDamping = 0.05,
  angularDamping = 0.12,
} = {}) {
  const { pos: rootPos, quat: rootQuat } = getWorldTRS(root)
  const body = new CANNON.Body({
    mass,
    material: new CANNON.Material({ friction, restitution }),
    linearDamping,
    angularDamping,
  })
  body.position.set(rootPos.x, rootPos.y, rootPos.z)
  body.quaternion.set(rootQuat.x, rootQuat.y, rootQuat.z, rootQuat.w)
  const bodyQuatInv = new THREE.Quaternion(
    body.quaternion.x,
    body.quaternion.y,
    body.quaternion.z,
    body.quaternion.w
  ).invert()
  const meshList = []
  root.traverse((o) => { if (o.isMesh && o.geometry) meshList.push(o) })
  for (const mesh of meshList) {
    const { pos: childPos, quat: childQuat } = getWorldTRS(mesh)
    const { half, centerLocal } = getLocalHalfExtentsScaled(mesh)
    const centerWorld = new THREE.Vector3().copy(centerLocal).applyQuaternion(childQuat).add(childPos)
    const offset = new CANNON.Vec3(
      centerWorld.x - body.position.x,
      centerWorld.y - body.position.y,
      centerWorld.z - body.position.z
    )
    const relQuat = childQuat.clone().multiply(bodyQuatInv)
    const shapeOrient = new CANNON.Quaternion(relQuat.x, relQuat.y, relQuat.z, relQuat.w)
    const shape = new CANNON.Box(new CANNON.Vec3(
      Math.max(0.001, half.x),
      Math.max(0.001, half.y),
      Math.max(0.001, half.z),
    ))
    body.addShape(shape, offset, shapeOrient)
  }
  body.allowSleep = true
  body.sleepSpeedLimit = 0.15
  body.sleepTimeLimit = 0.8
  return body
}
function createDynamicPropsFromGLB(
  root,
  {
    matchName = /^(monitor|screen|display)/i,
    mass = 2.5,
    friction = 0.6,
    restitution = 0.05,
    linearDamping = 0.05,
    angularDamping = 0.12,
    reparentToScene = true,
  } = {}
) {
  const result = []
  root.updateMatrixWorld(true)
  const instancedToExplode = []
  root.traverse((o) => {
    if (o.isInstancedMesh && (matchName.test(o.name) || o.userData?.physics === 'dynamic')) {
      instancedToExplode.push(o)
    }
  })
  for (const iMesh of instancedToExplode) explodeInstances(iMesh)
  const candidates = []
  root.traverse((o) => {
    const dyn = matchName.test(o.name) || o.userData?.physics === 'dynamic'
    if (!dyn) return
    if (o.isMesh || o.isGroup || (o.children?.length && !o.isMesh)) candidates.push(o)
  })
  for (const obj of candidates) {
    obj.updateWorldMatrix(true, false)
    const { pos: wPos, quat: wQuat, scale: wScale } = getWorldTRS(obj)
    if (reparentToScene && obj.parent !== scene) {
      obj.parent.remove(obj)
      scene.add(obj)
      obj.position.copy(wPos)
      obj.quaternion.copy(wQuat)
      obj.scale.copy(wScale)
      obj.updateMatrixWorld(true)
    }
    const body = buildOBBBodyFromObject(obj, {
      mass, friction, restitution, linearDamping, angularDamping,
    })
    world.addBody(body)
    obj.userData.physics = 'dynamic'
    obj.traverse(c => { if (c !== obj) c.userData._inDynamic = true })
    result.push({ object: obj, body })
  }
  return result
}

/* ============ Explizite *_col Collider → OBBs ============ */
function addExplicitColliderBoxes(root) {
  const tmpBox = new THREE.Box3()
  const tmpSize = new THREE.Vector3()
  const tmpCenter = new THREE.Vector3()
  const wPos = new THREE.Vector3()
  const wQuat = new THREE.Quaternion()
  const wScale = new THREE.Vector3()
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    if (!isColliderMarker(o)) return
    o.userData.noOcclude = true
    o.getWorldPosition(wPos)
    o.getWorldQuaternion(wQuat)
    o.getWorldScale(wScale)
    if (o.isMesh && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
      tmpBox.copy(o.geometry.boundingBox)
      tmpSize.subVectors(tmpBox.max, tmpBox.min).multiply(wScale)
      tmpCenter.addVectors(tmpBox.min, tmpBox.max).multiplyScalar(0.5).multiply(wScale)
    } else {
      tmpSize.set(Math.abs(wScale.x), Math.abs(wScale.y), Math.abs(wScale.z))
      tmpCenter.set(0,0,0)
    }
    const worldCenter = new THREE.Vector3().copy(tmpCenter).applyQuaternion(wQuat).add(wPos)
    const hx = Math.max(0.001, tmpSize.x * 0.5)
    const hy = Math.max(0.001, tmpSize.y * 0.5)
    const hz = Math.max(0.001, tmpSize.z * 0.5)
    const shape = new CANNON.Box(new CANNON.Vec3(hx, hy, hz))
    const body = new CANNON.Body({ mass: 0 })
    body.addShape(shape)
    body.position.set(worldCenter.x, worldCenter.y, worldCenter.z)
    body.quaternion.set(wQuat.x, wQuat.y, wQuat.z, wQuat.w)
    world.addBody(body)
    if (o.isMesh) o.visible = false
  })
}

/** Statische Collider (Fallback, AABB) */
function addStaticMeshColliders(root) {
  const box3 = new THREE.Box3()
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return
    if (o.userData?.physics === 'none' || o.userData?.collider === 'none' || o.userData?.collideer === 'none') return
    if (o.userData?.physics === 'dynamic' || o.userData?._inDynamic) return
    if (isColliderMarker(o)) return
    box3.setFromObject(o)
    if (!isFinite(box3.min.x) || !isFinite(box3.max.x)) return
    box3.getSize(size)
    box3.getCenter(center)
    if (size.x < 0.02 && size.y < 0.02 && size.z < 0.02) return
    const half = new CANNON.Vec3(size.x/2, size.y/2, size.z/2)
    const shape = new CANNON.Box(half)
    const body = new CANNON.Body({ mass: 0 })
    body.addShape(shape)
    body.position.set(center.x, center.y, center.z)
    world.addBody(body)
  })
}

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
  const w = Math.ceil(ctx.measureText(text).width) + pad*2
  const h = fontPx + pad*2
  canvas.width = w
  canvas.height = h
  ctx.font = `${fontPx}px Inter, system-ui, sans-serif`
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  ctx.fillRect(0,0,w,h)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, h/2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
   const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
   mat.depthTest = false;
   mat.depthWrite = false;
  const sprite = new THREE.Sprite(mat)
  const scale = 0.005
  sprite.scale.set(w*scale, h*scale, 1)
  return sprite
}
function createInfoPanel(text, url) {
  const group = new THREE.Group()
  const sprite = createTextSprite(text)
  const padX = 0.06, padY = 0.04
  const bgGeo = new THREE.PlaneGeometry(sprite.scale.x + padX, sprite.scale.y + padY)
  const bgMat  = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.85 })
  bgMat.depthTest = false;
  bgMat.depthWrite = false;
  const bg = new THREE.Mesh(bgGeo, bgMat)
  bg.position.set(0, 0, -0.001)
  group.add(bg)
  group.add(sprite)
  group.renderOrder = 10000;
  group.userData.url = url
  group.visible = false
  scene.add(group)
  return group
}
function openInfoFor(mesh) {
  const info = mesh.userData?.info || {}
  const txt  = info.text || 'Mehr Infos'
  const url  = info.url  || 'https://example.com'
  if (!openPanel) openPanel = { group: createInfoPanel(txt, url), targetMesh: mesh, url }
  openPanel.group.userData.url = url
  openPanel.targetMesh = mesh
  const box = new THREE.Box3().setFromObject(mesh)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size); box.getCenter(center)
  openPanel.group.position.copy(center).add(new THREE.Vector3(0, size.y*0.6, 0))
  openPanel.group.visible = true
}
function closeInfo() { if (openPanel) openPanel.group.visible = false }
function billboardPanelToCamera() {
  if (openPanel?.group?.visible) {
    openPanel.group.lookAt(camera.position)
  }
}

function worldRayFromEvent(e){
  const rect = canvas.value.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera({x, y}, camera)
}
function pickInteractable() {
  const hits = raycaster.intersectObjects(scene.children, true)
  for (const h of hits) {
    let o = h.object
    while (o && !o.userData?.interactable && o.parent) o = o.parent
    if (o?.userData?.interactable) return o
  }
  return null
}
function onPointerMove(e){
  worldRayFromEvent(e)
  const hit = pickInteractable()
  if (hovered.mesh !== hit) {
    if (hovered.mesh) showOutline(hovered.mesh, false)
    hovered.mesh = hit
    if (hovered.mesh) showOutline(hovered.mesh, true)
    if (canvas.value) canvas.value.style.cursor = hit ? 'pointer' : 'default'
  }
}
function onClick(e){
  worldRayFromEvent(e)
  if (openPanel?.group?.visible) {
    const hits = raycaster.intersectObject(openPanel.group, true)
    if (hits.length) {
      const url = openPanel.group.userData.url
      if (url) window.open(url, '_blank')
      return
    }
  }
  const hit = pickInteractable()
  if (hit) openInfoFor(hit)
  else closeInfo()
}
function bindCanvasEvents(){
  const dom = canvas.value
  dom?.addEventListener('pointermove', onPointerMove)
  dom?.addEventListener('click', onClick)
}
function unbindCanvasEvents(){
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

  // Physics
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
  world.solver.iterations = 20
  world.solver.tolerance  = 0.001
  world.defaultContactMaterial.friction = 0.6
  world.defaultContactMaterial.restitution = 0.0
  world.defaultContactMaterial.contactEquationStiffness = 1e7
  world.defaultContactMaterial.contactEquationRelaxation = 3
  world.broadphase = new CANNON.SAPBroadphase(world)
  const bodyMaterial = new CANNON.Material()
  const envMaterial  = new CANNON.Material()
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
  const mq = window.matchMedia('(hover: none) and (pointer: coarse)')
  mq.addEventListener?.('change', () => {
    updateIsTouch()
    controls.enableZoom = !isTouch.value
  })
  if (isTouch.value) controls.enableZoom = false

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
      // Collider-Marker überall konsistent behandeln
      if (isColliderMarker(o)) {
        if (o.isMesh) o.visible = false
        o.userData.noOcclude = true
      }
    })
    scene.add(level)

    // Interactable per Name/Flag (Beispiel):
    level.traverse(o=>{
      if (o.isMesh && o.userData?.interactable) {
        // optional: defaults wenn nicht gesetzt
        o.userData.info ??= { text: 'Kurzer Info-Text', url: 'https://www.studiomerkas.com/de/projekte/muddinis-adventure' }
      }
    })

    // Dynamische Props (Monitore etc.)
    dynamicPairs = createDynamicPropsFromGLB(level, {
      matchName: /^(monitor|screen|display)/i,
      mass: 2.5,
      friction: 0.6,
      restitution: 0.05,
      linearDamping: 0.05,
      angularDamping: 0.12,
      reparentToScene: true,
    })

    // Restliche statische Umgebung
    addStaticMeshColliders(level)
    // Explizite *_col Marker → orientierte Boxen
    addExplicitColliderBoxes(level)

    // Occlusion blockers (Collider-Marker werden automatisch übersprungen)
    registerBlockers(level)
  } catch (err) {
    console.error('SCENE load error', err)
  }

  // Dog
  dog = new Dog(scene, world)
  await dog.init()
  dog.controls()
  dog?.model?.traverse((o) => { if (o.isMesh) o.userData.noOcclude = true })

  if (dog?.body) {
    const p = dog.body.position
    controls.target.set(p.x, p.y + 0.5, p.z)
  }

  // Debugger in eigener Gruppe
  debugGroup = new THREE.Group()
  debugGroup.visible = showDebug
  scene.add(debugGroup)
  cannonDebugger = CannonDebugger(debugGroup, world, { color: 0xff0000 })

  // Sync dyn meshes ⇄ bodies (nach Physik)
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

  // Interactables: Panel richtet sich zur Kamera aus
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
  if (stats?.dom?.parentNode) stats.dom.parentNode.removeChild(stats.dom)
})
</script>


<style scoped>
.stage, canvas.webgl {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

/* standardmäßig versteckt – erscheint nur auf Touch via Media Query */
.mobile-controls { display: none; }

@media (hover: none) and (pointer: coarse) {
  .mobile-controls {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    padding: 16px;
    pointer-events: none;
    gap: 12px;
  }
  .stick {
    pointer-events: auto;
    position: relative;
    width: 140px;
    height: 140px;
    touch-action: none;
  }
  .stick.left  { margin-left: 4px; }
  .stick.right { margin-right: 4px; }
  .stick-bg {
    position: absolute; inset: 0;
    border-radius: 9999px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.2);
    backdrop-filter: blur(4px);
  }
  .stick-knob {
    position: absolute; left: calc(50% - 28px); top: calc(50% - 28px);
    width: 56px; height: 56px; border-radius: 9999px;
    background: rgba(255,255,255,.25);
    border: 1px solid rgba(255,255,255,.35);
    box-shadow: 0 6px 20px rgba(0,0,0,.2) inset, 0 4px 12px rgba(0,0,0,.15);
  }

  .jump-btn {
    pointer-events: auto;
    align-self: center;
    width: 84px;
    height: 84px;
    border-radius: 9999px;
    border: 1px solid rgba(255,255,255,.35);
    background: rgba(255,255,255,.25);
    font-size: 28px;
    font-weight: 700;
    backdrop-filter: blur(6px);
  }
}
</style>
