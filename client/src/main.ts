import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { initWire } from './logic/wire';
import './style.css';

const app = createApp(App);
app.use(createPinia());
initWire();
app.mount('#app');

// PWA：仅注册安装所需的 service worker（不缓存资源，保持零保存理念）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
