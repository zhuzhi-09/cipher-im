/* 极简离线外壳：静态资源走缓存优先，接口与 WebSocket 一律走网络；另外负责接收 Web Push 弹通知 */
// 缓存名由 scripts/build.sh 按构建内容替换：前端一变，缓存名就变，老设备才会换成新版
const CACHE = 'cipher-im-__BUILD__';
const ASSETS = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload' 绕过浏览器 HTTP 缓存，确保装进来的是服务器上的新文件
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.pathname === '/' }).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
            return res;
          })
          .catch(() => caches.match('/index.html')),
    ),
  );
});

/* ---------------- Web Push ---------------- */

// 推送里只有会话 id，没有发送者和内容（推送要经过 Apple / Google / 微软的服务器）
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    /* 坏包也要弹一条，iOS 收到推送却不弹通知会被收回推送权限 */
  }
  const conv = Number(data.conv) || 0;
  e.waitUntil(
    self.registration.showNotification('Cipher IM', {
      body: '你有新消息',
      tag: conv ? `conv-${conv}` : 'cipher-im',
      renotify: true,
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      data: { conv },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const conv = (e.notification.data && e.notification.data.conv) || 0;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin) {
          c.postMessage({ t: 'openConv', conv });
          return c.focus();
        }
      }
      return self.clients.openWindow(conv ? `/?conv=${conv}` : '/');
    }),
  );
});
