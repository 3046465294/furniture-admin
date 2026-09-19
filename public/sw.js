/**
 * AURUM 商城 Service Worker
 *
 * 策略（按资源类型区分，避免"缓存把数据变旧"这个经典坑）：
 *   · 应用壳（HTML/CSS/JS/图标）：stale-while-revalidate —— 先给缓存保证秒开，后台拉新
 *   · 商品接口 /api/shop/**    ：network-first —— 数据永远优先取新；失败时回落到缓存（离线可看点内容）
 *   · 图片 /img/**             ：cache-first —— 内容不变，缓存命中即用
 *   · 其它（含后台接口）        ：不拦截，直连网络
 *
 * 版本：改动壳资源时必须升 CACHE_VERSION，否则用户会一直拿到旧壳（我在这上面踩过缓存坑）
 */
const CACHE_VERSION = 'aurum-shop-v3.0.1';
const SHELL = [
  '/',
  '/shop.html',
  '/shop.css?v=3.0.0',
  '/style.css',
  '/shop.js?v=1.8.2',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // 单个资源失败不应让整个安装失败（例如某个版本号写错）
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isApi = (url) => url.pathname.startsWith('/api/');
const isImage = (url) => url.pathname.startsWith('/img/');
const isShell = (url) => !isApi(url) && !isImage(url) && (url.pathname === '/' || /\.(html|css|js|webmanifest|svg|ico|png|jpg|jpeg|webp)$/i.test(url.pathname));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                      // 变更类请求一律直连
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // 只处理同源

  // 商品接口：网络优先，离线回落缓存
  if (isApi(url)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response(JSON.stringify({ error: '离线状态，暂时无法获取数据' }), {
          status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 图片：缓存优先
  if (isImage(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    })());
    return;
  }

  // 应用壳：stale-while-revalidate
  if (isShell(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req, { ignoreSearch: url.pathname === '/' });
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return cached ?? (await network) ?? new Response('离线', { status: 503 });
    })());
  }
});
