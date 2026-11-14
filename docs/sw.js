/* 慢壘紀錄 PWA 離線外殼（GitHub Pages：網站在 /softball-iv4/ 底下，路徑一律用相對路徑）
   - 頁面（HTML）：先抓網路拿最新版，沒訊號時改用手機上存的版本
   - CSS / JS / 圖示 / Firebase 程式庫 / 字型：先用手機上的，背景再更新
   - Firestore、登入等資料請求不經過這裡，由 Firebase 自己的離線暫存處理
   改版時把 VERSION 加一，舊快取會自動清掉。 */
const VERSION = 'v1';
const CACHE = 'softball-' + VERSION;
const BASE = new URL('./', self.location).href;
const abs = (p) => new URL(p, BASE).href;

const PAGES = ['index.html', 'score.html', 'sheet.html', 'admin.html', 'signup.html', 'standings.html'];
const ASSETS = [
  'common.css', 'common.js', 'config.js', 'icon.svg', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'
];
const CDN = [
  'https://cdn.jsdelivr.net/npm/firebase@10.12.2/firebase-app-compat.js',
  'https://cdn.jsdelivr.net/npm/firebase@10.12.2/firebase-auth-compat.js',
  'https://cdn.jsdelivr.net/npm/firebase@10.12.2/firebase-firestore-compat.js'
];
const RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// 有轉址過的回應，Safari 不接受由 service worker 直接回傳，重新包一次
async function clean(r) {
  if (!r || !r.redirected) return r;
  const body = await r.blob();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const urls = [...PAGES.map(abs), ...ASSETS.map(abs), ...CDN];
    // 逐一加入，個別失敗不會讓整個安裝失敗
    await Promise.all(urls.map((u) =>
      fetch(u, { cache: 'reload' })
        .then(async (r) => (r.ok ? c.put(u, await clean(r)) : null))
        .catch(() => null)
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('softball-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 頁面在快取裡的位置：去掉 ?參數；資料夾本身（/softball-iv4/）視為 index.html；沒有副檔名的補 .html
function pageKey(url) {
  const u = new URL(url.pathname, url.origin);
  if (u.pathname.endsWith('/')) u.pathname += 'index.html';
  else if (!/\.[a-z0-9]+$/i.test(u.pathname)) u.pathname += '.html';
  return u.href;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const inScope = req.url.startsWith(BASE);

  // 頁面：網路優先，離線用快取
  if (req.mode === 'navigate' && inScope) {
    e.respondWith((async () => {
      const key = pageKey(url);
      const c = await caches.open(CACHE);
      try {
        const fresh = await clean(await fetch(req));
        if (fresh.ok) c.put(key, fresh.clone());
        return fresh;
      } catch (err) {
        return (await c.match(key)) || (await c.match(abs('score.html'))) || (await c.match(abs('index.html'))) ||
          new Response('<meta charset="utf-8"><p style="font:16px sans-serif;padding:2em">目前沒有網路，且這一頁還沒存到手機上。請在有網路時先打開一次。</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // 靜態資源：先用快取，背景更新
  if (inScope || RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req, { ignoreSearch: inScope });
      const update = fetch(req).then((r) => {
        if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
        return r;
      }).catch(() => null);
      if (hit) { e.waitUntil(update); return hit; }
      return (await update) || new Response('', { status: 504 });
    })());
  }
  // 其他（Firestore、Firebase Auth 等）不攔截
});
