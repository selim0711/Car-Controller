<template>
  <div class="app">
    <header class="hud">
      <h1>Three.js + Vue Game</h1>
      <p>WASD bewegen · Maus: Orbit · R zum Reset</p>
    </header>

    <GameCanvas class="canvas"/>
  </div>
</template>

<script setup>
import GameCanvas from './components/GameCanvas.vue'
</script>

<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body, #app, .app { height: 100%; margin: 0; }
.app { display: grid; grid-template-rows: auto 1fr; }
.hud {
  padding: 10px 12px; backdrop-filter: blur(6px);
  background: rgba(0,0,0,.3); border-bottom: 1px solid rgba(255,255,255,.08);
}
.canvas { width: 100%; height: 100%; display: block; }
h1 { font-size: 16px; margin: 0 0 6px; }
p { margin: 0; opacity: .8; }
</style>