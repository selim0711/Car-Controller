// Physik-/Collider-Utilities für cannon-es + three
import * as THREE from 'three'
import * as CANNON from 'cannon-es'

/* ===== Allgemeine Helpers ===== */
export function getWorldTRS(obj) {
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  obj.updateWorldMatrix(true, false)
  obj.getWorldPosition(pos)
  obj.getWorldQuaternion(quat)
  obj.getWorldScale(scale)
  return { pos, quat, scale }
}

export function explodeInstances(instancedMesh) {
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

/* ===== Collider/Shapes ===== */
export function addTrimeshCollider(world, mesh) {
  if (!mesh.geometry) return
  const g = mesh.geometry.clone()
  mesh.updateWorldMatrix(true, false)
  g.applyMatrix4(mesh.matrixWorld)

  const posAttr = g.getAttribute('position')
  if (!posAttr) return
  const vertices = posAttr.array

  let indices
  if (g.index) {
    indices = g.index.array
  } else {
    const count = posAttr.count
    const Arr = count > 65535 ? Uint32Array : Uint16Array
    indices = new Arr(count)
    for (let i = 0; i < count; i++) indices[i] = i
  }

  const shape = new CANNON.Trimesh(vertices, indices)
  const body = new CANNON.Body({ mass: 0 })
  body.addShape(shape)
  world.addBody(body)
}

export function addExplicitColliderBoxes(world, root, isColliderMarker) {
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
      const bb = o.geometry.boundingBox
      tmpSize.subVectors(bb.max, bb.min).multiply(wScale)
      tmpCenter.addVectors(bb.min, bb.max).multiplyScalar(0.5).multiply(wScale)
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

export function addStaticMeshColliders(world, root, isColliderMarker) {
  const box3 = new THREE.Box3()
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return
    if (o.userData?._hasCollider) return
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

/* ===== Dynamik: Kugeln & OBB-Körper ===== */
export function addDynamicSphereFromMesh(world, mesh, {
  mass = 1,
  friction = 0.4,
  restitution = 0.5,
  linearDamping = 0.01,
  angularDamping = 0.01,
  scaleFactor = 0.50,
} = {}) {
  const g = mesh.geometry
  if (!g.boundingSphere) g.computeBoundingSphere()

  mesh.updateWorldMatrix(true, false)
  const wScale = new THREE.Vector3()
  mesh.getWorldScale(wScale)

  const rLocal = g.boundingSphere.radius
  let rWorld = Math.max(0.001, rLocal * Math.max(wScale.x, wScale.y, wScale.z))
  if (typeof mesh.userData?.radius === 'number') {
    rWorld = Math.max(0.001, mesh.userData.radius)
  } else {
    rWorld *= scaleFactor
  }

  const wPos = new THREE.Vector3()
  const wQuat = new THREE.Quaternion()
  mesh.getWorldPosition(wPos)
  mesh.getWorldQuaternion(wQuat)

  const shape = new CANNON.Sphere(rWorld)
  const body = new CANNON.Body({
    mass,
    material: new CANNON.Material({ friction, restitution }),
    linearDamping,
    angularDamping,
  })
  body.addShape(shape)
  body.position.set(wPos.x, wPos.y, wPos.z)
  body.quaternion.set(wQuat.x, wQuat.y, wQuat.z, wQuat.w)
  body.userData = { tag: 'ball' }
  world.addBody(body)
  return body
}

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

export function buildOBBBodyFromObject(root, {
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
    const orient = new CANNON.Quaternion(relQuat.x, relQuat.y, relQuat.z, relQuat.w)
    const shape = new CANNON.Box(new CANNON.Vec3(
      Math.max(0.001, half.x),
      Math.max(0.001, half.y),
      Math.max(0.001, half.z),
    ))
    body.addShape(shape, offset, orient)
  }

  body.allowSleep = true
  body.sleepSpeedLimit = 0.15
  body.sleepTimeLimit = 0.8
  return body
}

export function createDynamicPropsFromGLB(scene, world, root, {
  matchName = /^(monitor|screen|display)/i,
  mass = 2.5,
  friction = 0.6,
  restitution = 0.05,
  linearDamping = 0.05,
  angularDamping = 0.12,
  reparentToScene = true,
} = {}) {
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

export function addTriggerFromMesh(world, mesh, { onEnter } = {}) {
  const box = new THREE.Box3().setFromObject(mesh)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  const quat = new THREE.Quaternion()
  mesh.getWorldQuaternion(quat)

  const half = new CANNON.Vec3(
    Math.max(0.001, size.x/2),
    Math.max(0.001, size.y/2),
    Math.max(0.001, size.z/2)
  )
  const shape = new CANNON.Box(half)
  const body = new CANNON.Body({
    mass: 0,
    collisionResponse: false,
  })
  body.addShape(shape)
  body.position.set(center.x, center.y, center.z)
  body.quaternion.set(quat.x, quat.y, quat.z, quat.w)

  body.addEventListener('collide', (e) => {
    if (e.body?.userData?.tag === 'ball') onEnter?.(e.body, body, center.clone())
  })

  world.addBody(body)
  return body
}

/* ===== High-level Helper für GLB: userData-gestützte Collider ===== */
export function applyUserDataColliders(scene, world, root, dynamicPairs) {
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return
    if (o.userData?._hasCollider) return

    if (o.userData?.collider === 'trimesh') {
      addTrimeshCollider(world, o)
      o.userData._hasCollider = true
      return
    }

    if (o.userData?.collider === 'sphere' && o.userData?.physics === 'dynamic') {
      const body = addDynamicSphereFromMesh(world, o, {
        mass: o.userData.mass ?? 1,
        restitution: o.userData.restitution ?? 0.5,
      })

      const { pos, quat, scale } = getWorldTRS(o)
      if (o.parent !== scene) {
        o.parent.remove(o)
        scene.add(o)
        o.position.copy(pos)
        o.quaternion.copy(quat)
        o.scale.copy(scale)
        o.updateMatrixWorld(true)
      }

      dynamicPairs.push({ object: o, body })
      o.userData._hasCollider = true
      o.userData.physics = 'dynamic'
      return
    }

    if (o.userData?.collider === 'none') return
  })
}