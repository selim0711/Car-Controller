// src/composables/useVirtualSticks.js
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'

export function useVirtualSticks(stickRadius = 40) {
  const isTouch = ref(false)

  function updateIsTouch() {
    const coarse = window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches
    isTouch.value = !!coarse || 'ontouchstart' in window
  }

  // State
  const drive = reactive({ x:0, y:0, dx:0, dy:0, active:false })
  const look  = reactive({ x:0, y:0, dx:0, dy:0, active:false })

  const driveCenter = ref({x:0, y:0})
  const lookCenter  = ref({x:0, y:0})

  const driveStick = ref(null)
  const lookStick  = ref(null)

  const driveStyle = computed(() => ({ transform:`translate(${drive.dx}px,${drive.dy}px)` }))
  const lookStyle  = computed(() => ({ transform:`translate(${look.dx}px,${look.dy}px)` }))

  function stickStart(which, e){
    const el = which==='drive' ? driveStick.value : lookStick.value
    const r = el.getBoundingClientRect()
    const c = {x:r.left + r.width/2, y:r.top + r.height/2}
    if(which==='drive') driveCenter.value=c; else lookCenter.value=c
    stickMove(which, e)
    if(which==='drive') drive.active=true; else look.active=true
  }

  function stickMove(which, e){
    const t = e.touches[0]
    const c = which==='drive' ? driveCenter.value : lookCenter.value
    const dx = t.clientX - c.x
    const dy = t.clientY - c.y
    const len = Math.hypot(dx,dy), k = len>stickRadius ? stickRadius/len : 1
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

  // Touch-Mode verfolgen
  let mq
  onMounted(() => {
    updateIsTouch()
    mq = window.matchMedia?.('(hover: none) and (pointer: coarse)')
    mq?.addEventListener?.('change', updateIsTouch)
  })
  onBeforeUnmount(() => {
    mq?.removeEventListener?.('change', updateIsTouch)
  })

  return {
    // state
    isTouch, drive, look,
    driveStick, lookStick,
    driveStyle, lookStyle,
    // handlers
    stickStart, stickMove, stickEnd,
    // util
    updateIsTouch,
  }
}