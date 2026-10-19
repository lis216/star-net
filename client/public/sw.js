/**
 * 星网 PWA Service Worker（最小实现）
 * 仅用于满足"添加到主屏幕/安装"条件，不做资源缓存——
 * 与产品"零保存、刷新即焚"的理念一致，页面内容永远走网络实时获取。
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', () => {
  // 故意不 respondWith：所有请求按默认行为走网络
});
