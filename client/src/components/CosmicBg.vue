<template>
  <div class="cosmic">
    <div class="nebula n1" />
    <div class="nebula n2" />
    <div class="nebula n3" />
    <div class="tilt">
      <div class="spin">
        <div class="disc" />
        <div class="arm arm1" />
        <div class="arm arm2" />
        <div class="arm arm3" />
        <div v-for="i in 28" :key="i" class="dust" :style="dustStyle(i)" />
        <div class="gcore" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 在倾斜的星系盘平面内确定性散布尘埃星点（每颗随盘旋转、闪烁） */
function dustStyle(i: number) {
  const rand = (n: number) => {
    const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const a = rand(1) * Math.PI * 2;
  const d = 0.22 + rand(2) * 0.66;
  const size = 0.8 + rand(3) * 1.4;
  return {
    left: `${50 + Math.cos(a) * d * 50}%`,
    top: `${50 + Math.sin(a) * d * 50}%`,
    width: `${size}px`,
    height: `${size}px`,
    opacity: 0.1 + rand(4) * 0.25,
    animationDelay: `${rand(5) * 4}s`,
    animationDuration: `${2.5 + rand(6) * 3}s`,
  };
}
</script>
