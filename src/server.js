/**
 * 至尊家居 · 现代化重构版 —— HTTP 服务（零第三方依赖）
 *
 *   · 安全头（CSP / X-Frame-Options / nosniff / Referrer-Policy）
 *   · Cookie 会话 + RBAC 权限（admin / operator / viewer）
 *   · 变更类接口要求自定义请求头（配合 SameSite=Strict Cookie 防 CSRF）
 *   · 全部 SQL 走预编译参数，杜绝注入
 *   · 每一次 API 请求都进指标系统 → 监控面板与 /metrics 都能看到
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, audit, tableCounts, dbSizeKB } from './db.js';
import {
  createSession, destroySession, currentUser, activeSessionCount,
  ensureAdmin, hashPassword, verifyPassword, can,
  loginAllowed, noteLoginFailure, clearLoginFailures, loginRateSnapshot,
  parseCookies, sessionCookieHeader, clearCookieHeader, SESSION_COOKIE,
} from './auth.js';
import { recordRequest, snapshot, addSseClient, startMetricsTicker, prometheusText, recentLogEntries, sseClientCount } from './metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const PORT = Number(process.env.PORT ?? 8090);
const HOST = process.env.HOST ?? '127.0.0.1';
const VERSION = '2.0.0';
const MAX_BODY = 256 * 1024;
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

// ────────────────────────── 工具 ──────────────────────────
const json = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
  return { status };
};

const securityHeaders = (secure) => ({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
});

const isSecure = (req) =>
  (req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { const e = new Error('请求体过大'); e.status = 413; throw e; }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const e = new Error('JSON 解析失败'); e.status = 400; throw e; }
}

const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function decodePath(rawPath) {
  const raw = String(rawPath).split('?')[0];
  try { return decodeURIComponent(raw); }
  catch { return Buffer.from(raw, 'latin1').toString('utf8'); }   // 兼容未百分号编码的客户端
}

// ────────────────────────── 静态文件 ──────────────────────────
function serveStatic(req, res, pathname, secure) {
  let p = decodePath(pathname);
  p = p.replace(/\\/g, '/').replace(/\0/g, '');
  if (p.endsWith('/')) p += 'index.html';
  const target = join(PUBLIC_DIR, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return { status: 403 }; }

  if (!existsSync(target) || !statSync(target).isFile()) {
    // 单页应用：未知路径回落到首页（但 API 例外，由上层处理）
    const fallback = join(PUBLIC_DIR, 'index.html');
    if (existsSync(fallback)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], ...securityHeaders(secure) });
      createReadStream(fallback).pipe(res);
      return { status: 200 };
    }
    res.writeHead(404).end('Not Found');
    return { status: 404 };
  }

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const st = statSync(target);
  // 缓存策略（踩过的坑）：之前对 JS/CSS 用了 public, max-age=3600，
  // 结果 Cloudflare 边缘把旧 app.js 缓存住，改了前端页面却不变——排查了很久。
  // 现在：HTML 一律 no-store；其它资源强制回源校验，避免"改了不生效"这类玄学问题。
  const isHtml = extname(target).toLowerCase() === '.html';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': isHtml ? 'no-store' : 'no-cache, must-revalidate',
    'ETag': `W/"${st.size}-${Math.floor(st.mtimeMs)}"`,
    ...securityHeaders(secure),
  });
  createReadStream(target).pipe(res);
  return { status: 200 };
}

// ────────────────────────── 业务查询 ──────────────────────────
function listProducts(q) {
  const page = clampInt(q.get('page'), 1, 10_000, 1);
  const size = clampInt(q.get('size'), 1, 100, 10);
  const kw = str(q.get('q'), 60);
  const cat = clampInt(q.get('category'), 0, 10_000, 0);
  const status = q.get('status');

  const where = ['p.deleted = 0'];
  const params = [];
  if (kw) { where.push('(p.name like ? or p.sku like ?)'); params.push(`%${kw}%`, `%${kw}%`); }
  if (cat) { where.push('p.category_id = ?'); params.push(cat); }
  if (status === '0' || status === '1') { where.push('p.status = ?'); params.push(Number(status)); }

  const clause = where.join(' and ');
  const total = db.prepare(`select count(*) as c from products p where ${clause}`).get(...params).c;
  const rows = db.prepare(`
    select p.*, c.name as category_name
    from products p left join categories c on c.id = p.category_id
    where ${clause}
    order by p.id desc limit ? offset ?
  `).all(...params, size, (page - 1) * size);

  return { page, size, total, rows: rows.map(rowToProduct) };
}

const rowToProduct = (r) => ({
  id: r.id, sku: r.sku, name: r.name, categoryId: r.category_id, categoryName: r.category_name ?? '',
  price: r.price_cents / 100, priceCents: r.price_cents, stock: r.stock, status: r.status,
  description: r.description ?? '', createdBy: r.created_by, createdAt: r.created_at,
  updatedBy: r.updated_by, updatedAt: r.updated_at,
});

function listCategories() {
  return db.prepare(`
    select c.*, (select count(*) from products p where p.category_id = c.id and p.deleted = 0) as product_count
    from categories c where c.deleted = 0 order by c.sort asc, c.id asc
  `).all().map((r) => ({
    id: r.id, name: r.name, sort: r.sort, status: r.status, remark: r.remark ?? '',
    productCount: r.product_count, createdBy: r.created_by, createdAt: r.created_at,
  }));
}

function listOrders(q) {
  const page = clampInt(q.get('page'), 1, 10_000, 1);
  const size = clampInt(q.get('size'), 1, 100, 10);
  const status = str(q.get('status'), 20);
  const where = ['deleted = 0'];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  const clause = where.join(' and ');
  const total = db.prepare(`select count(*) as c from orders where ${clause}`).get(...params).c;
  const rows = db.prepare(`select * from orders where ${clause} order by id desc limit ? offset ?`)
    .all(...params, size, (page - 1) * size);
  return { page, size, total, rows: rows.map((r) => ({
    id: r.id, orderNo: r.order_no, customer: r.customer, phone: r.phone,
    total: r.total_cents / 100, itemCount: r.item_count, status: r.status,
    remark: r.remark ?? '', createdAt: r.created_at,
  })) };
}

// ────────────────────────── 路由 ──────────────────────────
const ROUTES = [];
const route = (method, pattern, handler, opts = {}) => ROUTES.push({ method, pattern, handler, opts });

/** 权限包装：要求登录 / 要求某个动作权限 */
const guard = (handler, action = 'read') => async (ctx) => {
  if (!ctx.user) return json(ctx.res, 401, { error: '未登录或会话已过期' });
  if (action && !can(ctx.user.role, action)) return json(ctx.res, 403, { error: `当前角色（${ctx.user.role}）没有 ${action} 权限` });
  return handler(ctx);
};

/** 变更类请求要求自定义头（CSRF 防护） */
function csrfOk(req) {
  return String(req.headers['x-requested-with'] ?? '').toLowerCase() === 'fetch';
}

// — 认证 —
route('POST', '/api/auth/login', async ({ req, res, body, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With 请求头' });
  const username = str(body.username, 40);
  const password = String(body.password ?? '');
  const key = `${ip}|${username}`;
  if (!loginAllowed(key)) return json(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });

  const user = db.prepare('select * from users where username = ? and active = 1').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const st = noteLoginFailure(key);
    audit(username || 'unknown', 'login_failed', 'session', `失败第 ${st.count} 次`, ip);
    return json(res, 401, { error: '用户名或密码错误', failed: st.count });
  }
  clearLoginFailures(key);
  const { token, expires } = createSession(user, ip, req.headers['user-agent']);
  db.prepare('update users set last_login_at = ?, failed_count = 0 where id = ?').run(now(), user.id);
  audit(user.username, 'login', 'session', '登录成功', ip);
  return json(res, 200,
    { user: { username: user.username, displayName: user.display_name, role: user.role } },
    { 'Set-Cookie': sessionCookieHeader(token, expires, isSecure(req)) });
});

route('POST', '/api/auth/logout', async ({ req, res, cookies, ip, user }) => {
  destroySession(cookies[SESSION_COOKIE]);
  if (user) audit(user.username, 'logout', 'session', '', ip);
  return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader(isSecure(req)) });
});

route('GET', '/api/auth/me', async ({ res, user }) =>
  json(res, 200, { user: user ? { username: user.username, displayName: user.displayName, role: user.role } : null }));

// — 家具商品 —
route('GET', '/api/products', guard(async ({ res, url }) => json(res, 200, listProducts(url.searchParams))));
route('POST', '/api/products', guard(async ({ req, res, body, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const name = str(body.name, 80); const sku = str(body.sku, 40);
  if (!name || !sku) return json(res, 400, { error: '商品名称与 SKU 必填' });
  if (body.price === undefined && body.priceCents === undefined) return json(res, 400, { error: '价格必填' });
  const cents = body.priceCents !== undefined ? Math.round(Number(body.priceCents)) : Math.round(Number(body.price) * 100);
  if (!Number.isFinite(cents) || cents < 0) return json(res, 400, { error: '价格不合法' });
  const dup = db.prepare('select id from products where sku = ? and deleted = 0').get(sku);
  if (dup) return json(res, 409, { error: 'SKU 已存在' });
  const r = db.prepare(`insert into products(sku,name,category_id,price_cents,stock,status,description,created_by,created_at,updated_by,updated_at)
                        values (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sku, name, clampInt(body.categoryId, 0, 10_000, 0) || null, cents,
      clampInt(body.stock, 0, 1_000_000, 0), body.status === 0 ? 0 : 1, str(body.description, 500),
      user.username, now(), user.username, now());
  audit(user.username, 'product_create', `product#${r.lastInsertRowid}`, `${name} / ${sku}`, ip);
  return json(res, 201, { id: Number(r.lastInsertRowid) });
}, 'write'));

route('PUT', '/api/products/:id', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const cur = db.prepare('select * from products where id = ? and deleted = 0').get(id);
  if (!cur) return json(res, 404, { error: '商品不存在' });
  const cents = body.priceCents !== undefined ? Math.round(Number(body.priceCents))
    : body.price !== undefined ? Math.round(Number(body.price) * 100) : cur.price_cents;
  if (!Number.isFinite(cents) || cents < 0) return json(res, 400, { error: '价格不合法' });
  db.prepare(`update products set name=?, category_id=?, price_cents=?, stock=?, status=?, description=?, updated_by=?, updated_at=? where id=?`)
    .run(str(body.name, 80) || cur.name, clampInt(body.categoryId, 0, 10_000, 0) || null, cents,
      clampInt(body.stock, 0, 1_000_000, cur.stock), body.status === 0 ? 0 : 1,
      body.description === undefined ? cur.description : str(body.description, 500), user.username, now(), id);
  audit(user.username, 'product_update', `product#${id}`, str(body.name, 40), ip);
  return json(res, 200, { ok: true });
}, 'write'));

route('DELETE', '/api/products/:id', guard(async ({ req, res, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const cur = db.prepare('select * from products where id = ? and deleted = 0').get(id);
  if (!cur) return json(res, 404, { error: '商品不存在' });
  db.prepare('update products set deleted = 1, updated_by = ?, updated_at = ? where id = ?').run(user.username, now(), id);
  audit(user.username, 'product_delete', `product#${id}`, cur.name, ip);
  return json(res, 200, { ok: true });
}, 'delete'));

// — 分类 —
route('GET', '/api/categories', guard(async ({ res }) => json(res, 200, { rows: listCategories() })));
route('POST', '/api/categories', guard(async ({ req, res, body, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const name = str(body.name, 40);
  if (!name) return json(res, 400, { error: '分类名称必填' });
  const r = db.prepare(`insert into categories(name,sort,status,remark,created_by,created_at,updated_by,updated_at) values (?,?,?,?,?,?,?,?)`)
    .run(name, clampInt(body.sort, 0, 9999, 0), body.status === 0 ? 0 : 1, str(body.remark, 200), user.username, now(), user.username, now());
  audit(user.username, 'category_create', `category#${r.lastInsertRowid}`, name, ip);
  return json(res, 201, { id: Number(r.lastInsertRowid) });
}, 'write'));
route('DELETE', '/api/categories/:id', guard(async ({ req, res, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const used = db.prepare('select count(*) as c from products where category_id = ? and deleted = 0').get(id).c;
  if (used) return json(res, 409, { error: `该分类下还有 ${used} 个商品，先移走再删除` });
  db.prepare('update categories set deleted = 1 where id = ?').run(id);
  audit(user.username, 'category_delete', `category#${id}`, '', ip);
  return json(res, 200, { ok: true });
}, 'delete'));

// — 订单 —
route('GET', '/api/orders', guard(async ({ res, url }) => json(res, 200, listOrders(url.searchParams))));

// — 系统 / 监控 —
route('GET', '/api/system/health', async ({ res }) => json(res, 200, {
  status: 'ok', version: VERSION, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
  node: process.version, tables: tableCounts(), dbKB: dbSizeKB(), sessions: activeSessionCount(),
}));
route('GET', '/api/system/metrics', guard(async ({ res }) =>
  json(res, 200, { ...snapshot(), sessions: activeSessionCount(), sseClients: sseClientCount(), tables: tableCounts(), dbKB: dbSizeKB() })));
route('GET', '/api/system/metrics.prom', guard(async ({ res }) => {
  const body = prometheusText();
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', ...securityHeaders(isSecure({ headers: {} })) });
  res.end(body);
  return { status: 200 };
}));
route('GET', '/api/system/logs', guard(async ({ res, url }) => json(res, 200, { rows: recentLogEntries(clampInt(url.searchParams.get('limit'), 1, 200, 60)) })));
route('GET', '/api/system/audit', guard(async ({ res }) => json(res, 200, {
  rows: db.prepare('select * from audit_log order by id desc limit 50').all(),
})));
route('GET', '/api/system/login-attempts', guard(async ({ res }) => json(res, 200, { rows: loginRateSnapshot() }), 'manage_users'));

// SSE 实时流（浏览器 EventSource 无法带自定义头，因此这里用 Cookie 鉴权）
route('GET', '/api/system/stream', async ({ req, res, user }) => {
  if (!user) return json(res, 401, { error: '未登录' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...securityHeaders(isSecure(req)),
  });
  const remove = addSseClient(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);
  req.on('close', () => { clearInterval(ping); remove(); });
  return { status: 200 };
});

// ────────────────────────── 主服务 ──────────────────────────
function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const parts = r.pattern.split('/').filter(Boolean);
    const actual = pathname.split('/').filter(Boolean);
    if (parts.length !== actual.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = actual[i];
      else if (parts[i] !== actual[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

// 启动指标推送（管理员账号在 listen 回调里创建，那里会把随机密码打印一次）
// enrich：把需要查库/进程信息的字段补进 SSE 推送里，否则面板上的「在线会话 / 数据库 / Node」会是空的
startMetricsTicker(1000, () => ({
  sessions: activeSessionCount(),
  dbKB: dbSizeKB(),
  sseClients: sseClientCount(),
  node: process.version,
}));

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const secure = isSecure(req);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const cookies = parseCookies(req.headers.cookie ?? '');
  const user = currentUser(req);

  try {
    // 请求体只解析一次
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readJson(req) : {};

    if (pathname.startsWith('/api/')) {
      const hit = matchRoute(req.method ?? 'GET', pathname);
      if (!hit) {
        json(res, 404, { error: '接口不存在' }).status;
        recordRequest({ method: req.method, path: pathname, status: 404, ms: Date.now() - t0, actor: user?.username });
        return;
      }
      const ctx = { req, res, url, body, params: hit.params, user, ip, cookies, secure };
      try {
        const out = await hit.route.handler(ctx);
        if (!pathname.startsWith('/api/system/stream')) {
          recordRequest({ method: req.method, path: pathname, status: out?.status ?? 200, ms: Date.now() - t0, actor: user?.username });
        } else {
          recordRequest({ method: req.method, path: pathname, status: 200, ms: Date.now() - t0, actor: user?.username, note: 'SSE 已连接' });
        }
      } catch (err) {
        const status = err?.status ?? 500;
        json(res, status, { error: err?.message ?? '服务器错误' });
        recordRequest({ method: req.method, path: pathname, status, ms: Date.now() - t0, actor: user?.username, note: '异常' });
      }
      return;
    }

    // 静态资源与单页应用
    serveStatic(req, res, pathname, secure);
  } catch (err) {
    const status = err?.status ?? 500;
    try { json(res, status, { error: err?.message ?? '服务器错误' }); } catch {}
    recordRequest({ method: req.method, path: pathname, status, ms: Date.now() - t0, actor: user?.username, note: '异常' });
  }
});

server.listen(PORT, HOST, () => {
  const admin = ensureAdmin();
  console.log(`[furniture-admin v${VERSION}] 已启动 → http://${HOST}:${PORT}/`);
  console.log(`  实时监控：/api/system/stream（SSE）   Prometheus：/api/system/metrics.prom`);
  if (admin) {
    console.log('  ---------------------------------------------------------------');
    console.log(`  已创建管理员账号：${admin.username}`);
    console.log(`  初始密码（请立刻保存，页面不再显示）：${admin.password}`);
    console.log('  ---------------------------------------------------------------');
  }
});

export { server };
