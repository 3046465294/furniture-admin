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
import { ensureContentTables, registerContentRoutes } from './content.js'
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
import { recordRequest, snapshot, addSseClient, startMetricsTicker, prometheusText, recentLogEntries, sseClientCount, pushLog, broadcast } from './metrics.js';
import { resetDemoData, isBusinessDataEmpty, resetCoverageIssues } from './seed-data.js';
import { ensureAlertRules, evaluateAlerts, getRules, setRule, activeAlerts, alertHistory, onAlertChange } from './alerts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const PORT = Number(process.env.PORT ?? 8090);
const HOST = process.env.HOST ?? '127.0.0.1';
const VERSION = '2.3.0';
/** 低库存阈值（可入库配置，这里先给默认值） */
const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);
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
    'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload),
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
    parentId: r.parent_id ?? null, productCount: r.product_count, createdBy: r.created_by, createdAt: r.created_at,
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
  json(res, 200, { ...snapshot(), sessions: activeSessionCount(), sseClients: sseClientCount(), tables: tableCounts(), dbKB: dbSizeKB(),
    lowStockCount: db.prepare('select count(*) c from products where deleted = 0 and status = 1 and stock <= ?').get(LOW_STOCK_THRESHOLD).c })));
// Prometheus 端点：机器抓取无法携带会话 Cookie，因此支持静态 Bearer 令牌（METRICS_TOKEN）。
// 设计取舍：设了令牌就只认令牌（避免两个入口都开着）；没设令牌则回落到会话鉴权，本地开发方便。
route('GET', '/api/system/metrics.prom', async ({ req, res, user }) => {
  const expected = process.env.METRICS_TOKEN;
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const allowed = expected ? bearer === expected : !!user;
  if (!allowed) return json(res, 401, { error: expected ? '缺少或错误的 Bearer 令牌' : '未登录' });
  const body = prometheusText();
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', ...securityHeaders(isSecure(req)) });
  res.end(body);
  return { status: 200 };
});
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

// ── 二期：用户与权限（RBAC）、会话管理 ──
const ROLES = ['admin', 'operator', 'viewer'];

route('GET', '/api/users', guard(async ({ res }) => json(res, 200, {
  rows: db.prepare('select id,username,display_name,role,active,last_login_at,created_at from users order by id').all()
    .map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: u.active, lastLoginAt: u.last_login_at, createdAt: u.created_at })),
}), 'manage_users'));

route('POST', '/api/users', guard(async ({ req, res, body, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const username = str(body.username, 40);
  const password = String(body.password ?? '');
  const role = ROLES.includes(body.role) ? body.role : 'viewer';
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json(res, 400, { error: '用户名需为 3-20 位字母、数字或下划线' });
  if (password.length < 8) return json(res, 400, { error: '口令至少 8 位' });
  if (db.prepare('select id from users where username = ?').get(username)) return json(res, 409, { error: '用户名已存在' });
  const r = db.prepare('insert into users(username,display_name,password_hash,role,active,created_at) values (?,?,?,?,1,?)')
    .run(username, str(body.displayName, 40) || username, hashPassword(password), role, now());
  audit(user.username, 'user_create', `user#${r.lastInsertRowid}`, `${username} / ${role}`, ip);
  return json(res, 201, { id: Number(r.lastInsertRowid) });
}, 'manage_users'));

route('PUT', '/api/users/:id', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const target = db.prepare('select * from users where id = ?').get(id);
  if (!target) return json(res, 404, { error: '用户不存在' });
  const role = ROLES.includes(body.role) ? body.role : target.role;
  const active = body.active === undefined ? target.active : (body.active ? 1 : 0);
  // 关键保护：不允许把最后一个启用的管理员降级或停用，否则会把系统自己锁死
  if (target.role === 'admin' && (role !== 'admin' || !active)) {
    const admins = db.prepare("select count(*) as c from users where role = 'admin' and active = 1").get().c;
    if (admins <= 1) return json(res, 409, { error: '至少保留一个启用的管理员账号' });
  }
  db.prepare('update users set display_name = ?, role = ?, active = ? where id = ?')
    .run(str(body.displayName, 40) || target.display_name, role, active, id);
  if (body.password) {
    if (String(body.password).length < 8) return json(res, 400, { error: '口令至少 8 位' });
    db.prepare('update users set password_hash = ?, failed_count = 0, locked_until = 0 where id = ?').run(hashPassword(String(body.password)), id);
  }
  if (!active) db.prepare('update sessions set revoked = 1 where user_id = ?').run(id);
  audit(user.username, 'user_update', `user#${id}`, `${target.username} → ${role}${active ? '' : '（已停用）'}${body.password ? ' + 重置口令' : ''}`, ip);
  return json(res, 200, { ok: true });
}, 'manage_users'));

route('GET', '/api/sessions', guard(async ({ res, user }) => json(res, 200, {
  rows: db.prepare(`select s.id, s.created_at, s.expires_at, s.ip, s.user_agent, u.username
                    from sessions s join users u on u.id = s.user_id
                    where s.revoked = 0 and s.expires_at > ? order by s.created_at desc limit 50`).all(Date.now())
    .map((s) => ({ id: s.id.slice(0, 8) + '…', fullId: s.id, username: s.username, ip: s.ip, userAgent: (s.user_agent ?? '').slice(0, 60), createdAt: new Date(s.created_at).toISOString().slice(0, 19).replace('T', ' '), expiresInMin: Math.round((s.expires_at - Date.now()) / 60000), self: false })),
}), 'manage_users'));

route('DELETE', '/api/sessions/:id', guard(async ({ req, res, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = str(params.id, 64);
  const row = db.prepare('select * from sessions where id = ?').get(id);
  if (!row) return json(res, 404, { error: '会话不存在' });
  db.prepare('update sessions set revoked = 1 where id = ?').run(id);
  audit(user.username, 'session_revoke', `session#${id.slice(0, 8)}`, '', ip);
  return json(res, 200, { ok: true });
}, 'manage_users'));

// ── 二期：订单写操作（带状态机校验）与分类修改 ──
const ORDER_FLOW = { pending: ['paid', 'cancelled'], paid: ['shipped', 'cancelled'], shipped: ['done'], done: [], cancelled: [] };
const ORDER_LABEL = { pending: '待付款', paid: '已付款', shipped: '已发货', done: '已完成', cancelled: '已取消' };

route('POST', '/api/orders', guard(async ({ req, res, body, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const customer = str(body.customer, 40);
  if (!customer) return json(res, 400, { error: '客户名称必填' });
  const items = clampInt(body.itemCount, 1, 999, 1);
  const total = Math.round(Number(body.total ?? 0) * 100);
  if (!Number.isFinite(total) || total < 0) return json(res, 400, { error: '金额不合法' });
  const no = 'SO' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + String(Date.now()).slice(-5);
  const r = db.prepare(`insert into orders(order_no,customer,phone,total_cents,item_count,status,remark,created_by,created_at,updated_by,updated_at)
                        values (?,?,?,?,?, 'pending', ?,?,?,?,?)`)
    .run(no, customer, str(body.phone, 20), total, items, str(body.remark, 200), user.username, now(), user.username, now());
  audit(user.username, 'order_create', `order#${r.lastInsertRowid}`, `${no} / ${customer}`, ip);
  return json(res, 201, { id: Number(r.lastInsertRowid), orderNo: no });
}, 'write'));

route('PUT', '/api/orders/:id/status', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const cur = db.prepare('select * from orders where id = ? and deleted = 0').get(id);
  if (!cur) return json(res, 404, { error: '订单不存在' });
  const next = str(body.status, 20);
  if (!ORDER_LABEL[next]) return json(res, 400, { error: '未知的状态值' });
  if (next === cur.status) return json(res, 400, { error: `订单已经是「${ORDER_LABEL[next]}」` });
  const allowed = ORDER_FLOW[cur.status] ?? [];
  if (!allowed.includes(next)) {
    return json(res, 409, { error: `不允许从「${ORDER_LABEL[cur.status]}」直接变成「${ORDER_LABEL[next]}」`, allowed: allowed.map((s) => ({ value: s, label: ORDER_LABEL[s] })) });
  }
  db.prepare('update orders set status = ?, updated_by = ?, updated_at = ? where id = ?').run(next, user.username, now(), id);
  audit(user.username, 'order_status', `order#${id}`, `${ORDER_LABEL[cur.status]} → ${ORDER_LABEL[next]}`, ip);
  return json(res, 200, { ok: true, status: next });
}, 'write'));

route('PUT', '/api/categories/:id', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const cur = db.prepare('select * from categories where id = ? and deleted = 0').get(id);
  if (!cur) return json(res, 404, { error: '分类不存在' });
  db.prepare('update categories set name = ?, sort = ?, status = ?, remark = ?, updated_by = ?, updated_at = ? where id = ?')
    .run(str(body.name, 40) || cur.name, clampInt(body.sort, 0, 9999, cur.sort), body.status === 0 ? 0 : 1,
      body.remark === undefined ? cur.remark : str(body.remark, 200), user.username, now(), id);
  audit(user.username, 'category_update', `category#${id}`, str(body.name, 40), ip);
  return json(res, 200, { ok: true });
}, 'write'));

/** 库存回补（后台侧）：与前台 shop/schema.js 的 moveStock 语义一致，都写 stock_movements 留痕 */
function moveStockDb(productId, delta, reason, ref) {
  if (!productId) return;
  db.prepare('update products set stock = stock + ?, updated_at = ? where id = ?').run(delta, now(), productId);
  db.prepare('insert into stock_movements(product_id, delta, reason, ref, created_at) values (?,?,?,?,?)').run(productId, delta, reason, ref, now());
}

// ── 规格（SKU）管理：商品域的运营入口 ──
/** 商品级库存 = 各启用规格之和（与前台/告警口径一致） */
function syncProductStock(productId) {
  const total = db.prepare('select coalesce(sum(stock), 0) t from product_skus where product_id = ? and status = 1').get(productId).t;
  db.prepare('update products set stock = ?, updated_at = ? where id = ?').run(total, now(), productId);
  return total;
}

route('GET', '/api/products/:id/skus', guard(async ({ res, params }) => {
  const pid = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const rows = db.prepare('select id, spec, specs_json, sku_code, price_cents, stock, status from product_skus where product_id = ? order by status desc, id').all(pid);
  return json(res, 200, { rows: rows.map((r) => ({ ...r, price: r.price_cents / 100 })) });
}, 'read'));

route('POST', '/api/products/:id/skus', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const pid = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const p = db.prepare('select * from products where id = ? and deleted = 0').get(pid);
  if (!p) return json(res, 404, { error: '商品不存在' });
  const spec = str(body.spec, 60);
  if (!spec) return json(res, 400, { error: '规格名称必填（如「米白 / 三人位」）' });
  if (db.prepare('select id from product_skus where product_id = ? and spec = ?').get(pid, spec)) return json(res, 409, { error: '该规格已存在' });
  const priceCents = body.price === undefined || body.price === null || body.price === ''
    ? p.price_cents
    : Math.max(0, Math.round(Number(body.price) * 100));
  const stock = clampInt(body.stock, 0, 1000000000, 0);
  const r = db.prepare('insert into product_skus(product_id, spec, specs_json, sku_code, price_cents, stock, status, created_at, updated_at) values (?,?,?,?,?,?,1,?,?)')
    .run(pid, spec, JSON.stringify(body.specs ?? {}), str(body.skuCode, 40), priceCents, stock, now(), now());
  audit(user.username, 'sku_create', 'sku#' + r.lastInsertRowid, p.name + ' / ' + spec + ' ¥' + (priceCents / 100).toFixed(2) + ' 库存' + stock, ip);
  return json(res, 201, { id: Number(r.lastInsertRowid), productStock: syncProductStock(pid) });
}, 'write'));

route('PUT', '/api/skus/:id', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const s = db.prepare('select * from product_skus where id = ?').get(id);
  if (!s) return json(res, 404, { error: '规格不存在' });
  const spec = body.spec === undefined ? s.spec : str(body.spec, 60);
  if (!spec) return json(res, 400, { error: '规格名称不能为空' });
  const dup = db.prepare('select id from product_skus where product_id = ? and spec = ? and id <> ?').get(s.product_id, spec, id);
  if (dup) return json(res, 409, { error: '同商品下已有同名规格' });
  const priceCents = body.price === undefined || body.price === null || body.price === ''
    ? s.price_cents
    : Math.max(0, Math.round(Number(body.price) * 100));
  const stock = body.stock === undefined ? s.stock : clampInt(body.stock, 0, 1000000000, 0);
  db.prepare('update product_skus set spec = ?, price_cents = ?, stock = ?, sku_code = ?, updated_at = ? where id = ?')
    .run(spec, priceCents, stock, body.skuCode === undefined ? s.sku_code : str(body.skuCode, 40), now(), id);
  audit(user.username, 'sku_update', 'sku#' + id, spec + ' ¥' + (priceCents / 100).toFixed(2) + ' 库存' + stock, ip);
  return json(res, 200, { ok: true, productStock: syncProductStock(s.product_id) });
}, 'write'));

route('DELETE', '/api/skus/:id', guard(async ({ req, res, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const s = db.prepare('select * from product_skus where id = ?').get(id);
  if (!s) return json(res, 404, { error: '规格不存在' });
  const enabled = db.prepare('select count(*) c from product_skus where product_id = ? and status = 1').get(s.product_id).c;
  if (enabled <= 1) return json(res, 409, { error: '至少保留一个启用规格，否则商品将不可售' });
  db.prepare('update product_skus set status = 0, updated_at = ? where id = ?').run(now(), id);
  audit(user.username, 'sku_disable', 'sku#' + id, s.spec, ip);
  return json(res, 200, { ok: true, productStock: syncProductStock(s.product_id) });
}, 'write'));

// ── 二期补充：订单履约（发货 / 完成 / 退款）──
// 前台只能「支付」与「取消」；发货、完成、退款是运营动作，只存在于后台。
route('POST', '/api/orders/:id/ship', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: "缺少 X-Requested-With" });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const o = db.prepare('select * from orders where id = ? and deleted = 0').get(id);
  if (!o) return json(res, 404, { error: '订单不存在' });
  if (o.status !== 'paid') return json(res, 409, { error: '只有「已付款」的订单可以发货（当前：' + (ORDER_LABEL[o.status] ?? o.status) + '）' });
  const tracking = str(body.tracking, 60);
  const carrier = str(body.carrier, 30) || '顺丰速运';
  db.exec("begin");
  try {
    db.prepare('update orders set status = \'shipped\', remark = ?, updated_by = ?, updated_at = ? where id = ?')
      .run((o.remark ? o.remark + ' / ' : '') + '快递：' + carrier + (tracking ? ' ' + tracking : ''), user.username, now(), id);
    db.prepare('insert into shipments(order_id, carrier, tracking_no, status, created_by, created_at, updated_at) values (?,?,?,?,?,?,?)')
      .run(id, carrier, tracking, 'shipped', user.username, now(), now());
    db.exec("commit");
  } catch (e) { db.exec("rollback"); return json(res, 500, { error: "发货失败：" + e.message }); }
  audit(user.username, 'order_ship', 'order#' + id, o.order_no + ' / ' + carrier + ' ' + tracking, ip);
  return json(res, 200, { ok: true, carrier, tracking });
}, 'write'));

route('POST', '/api/orders/:id/complete', guard(async ({ req, res, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: "缺少 X-Requested-With" });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const o = db.prepare('select * from orders where id = ? and deleted = 0').get(id);
  if (!o) return json(res, 404, { error: '订单不存在' });
  if (o.status !== 'shipped') return json(res, 409, { error: '只有「已发货」的订单可以确认完成（当前：' + (ORDER_LABEL[o.status] ?? o.status) + '）' });
  db.prepare("update orders set status = 'done', updated_by = ?, updated_at = ? where id = ?").run(user.username, now(), id);
  db.prepare("update shipments set status = 'delivered', updated_at = ? where order_id = ?").run(now(), id);
  audit(user.username, 'order_complete', 'order#' + id, o.order_no, ip);
  return json(res, 200, { ok: true });
}, 'write'));

route('POST', '/api/orders/:id/refund', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: "缺少 X-Requested-With" });
  const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const o = db.prepare('select * from orders where id = ? and deleted = 0').get(id);
  if (!o) return json(res, 404, { error: '订单不存在' });
  if (!['paid', 'shipped', 'done'].includes(o.status)) return json(res, 409, { error: '当前状态不可退款（' + (ORDER_LABEL[o.status] ?? o.status) + '）' });
  const reason = str(body.reason, 100) || '运营退款';
  const items = db.prepare("select * from order_items where order_id = ?").all(id);
  db.exec("begin");
  try {
    db.prepare("update orders set status = 'cancelled', remark = ?, updated_by = ?, updated_at = ? where id = ?")
      .run((o.remark ? o.remark + ' / ' : '') + '已退款：' + reason, user.username, now(), id);
    for (const it of items) {
      if (it.sku_id) db.prepare('update product_skus set stock = stock + ?, updated_at = ? where id = ?').run(it.qty, now(), it.sku_id);
      moveStockDb(it.product_id, it.qty, '退款回补', o.order_no);
    }
    db.prepare("update payments set status = 'refunded' where order_id = ?").run(id);
    db.prepare('insert into refunds(order_id, amount_cents, reason, operator, created_at) values (?,?,?,?,?)')
      .run(id, o.total_cents, reason, user.username, now());
    db.exec("commit");
  } catch (e) { db.exec("rollback"); return json(res, 500, { error: "退款失败：" + e.message }); }
  audit(user.username, 'order_refund', 'order#' + id, o.order_no + ' / ' + reason, ip);
  return json(res, 200, { ok: true, refunded: o.total_cents / 100 });
}, 'write'));

// ── 三期：告警规则与历史 ──
route('GET', '/api/system/alerts', guard(async ({ res }) => json(res, 200, {
  rules: getRules(), active: activeAlerts(), history: alertHistory(30),
})));
route('PUT', '/api/system/alerts/:id', guard(async ({ req, res, body, params, user, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' });
  const rule = setRule(str(params.id, 40), body);
  if (!rule) return json(res, 400, { error: '规则不存在或阈值不合法' });
  audit(user.username, 'alert_rule_update', `rule#${rule.id}`, `阈值=${rule.threshold}${rule.unit} 启用=${rule.enabled}`, ip);
  return json(res, 200, { rule });
}, 'manage_users'));

// ── 三期：CSV 导出（不引依赖，手动拼，注意按 RFC4180 转义） ──
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (rows) => '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

route('GET', '/api/export/products.csv', guard(async ({ req, res, user, ip }) => {
  const rows = [['ID', 'SKU', '名称', '分类', '价格(元)', '库存', '状态', '创建人', '创建时间']];
  for (const p of db.prepare(`select p.*, c.name as cat from products p left join categories c on c.id = p.category_id
                              where p.deleted = 0 order by p.id`).all()) {
    rows.push([p.id, p.sku, p.name, p.cat ?? '', (p.price_cents / 100).toFixed(2), p.stock, p.status ? '上架' : '下架', p.created_by, p.created_at]);
  }
  audit(user.username, 'export_products', 'csv', `${rows.length - 1} 行`, ip);
  const body = csv(rows);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="products.csv"',
    'Content-Length': Buffer.byteLength(body),
    ...securityHeaders(isSecure(req)),
  });
  res.end(body);
  return { status: 200 };
}, 'read'));

route('GET', '/api/export/orders.csv', guard(async ({ req, res, user, ip }) => {
  const rows = [['订单号', '客户', '手机', '金额(元)', '件数', '状态', '备注', '创建时间']];
  for (const o of db.prepare('select * from orders where deleted = 0 order by id').all()) {
    rows.push([o.order_no, o.customer, o.phone, (o.total_cents / 100).toFixed(2), o.item_count, ORDER_LABEL[o.status] ?? o.status, o.remark, o.created_at]);
  }
  audit(user.username, 'export_orders', 'csv', `${rows.length - 1} 行`, ip);
  const body = csv(rows);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="orders.csv"',
    'Content-Length': Buffer.byteLength(body),
    ...securityHeaders(isSecure(req)),
  });
  res.end(body);
  return { status: 200 };
}, 'read'));

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

// 演示重置：登录页承诺了「数据每 10 分钟重置为种子数据」，这里让它成立（可用 DEMO_RESET_MS 覆盖）
const RESET_INTERVAL_MS = Number(process.env.DEMO_RESET_MS ?? 10 * 60 * 1000);
let nextResetAt = Date.now() + RESET_INTERVAL_MS;

// ── 站点内容域（项目案例 / 博客文章）：表初始化 + 路由注册 ──
const contentCounts = ensureContentTables();
registerContentRoutes({ route, guard, json, csrfOk, clampInt, str });
console.log(`  内容域：项目 ${contentCounts.projects} · 文章 ${contentCounts.posts}`);
// 启动指标推送（管理员账号在 listen 回调里创建，那里会把随机密码打印一次）
// enrich：把需要查库/进程信息的字段补进 SSE 推送里，否则面板上的「在线会话 / 数据库 / Node」会是空的
startMetricsTicker(1000, (snap) => {
  try { evaluateAlerts(snap); } catch {}
  // 业务侧指标：低库存商品数（库存 ≤ 阈值且在上架），交给告警引擎判定
  let lowStock = 0;
  try { lowStock = db.prepare("select count(*) c from products where deleted = 0 and status = 1 and stock <= ?").get(LOW_STOCK_THRESHOLD).c; } catch {}
  return {
    lowStockCount: lowStock,
    sessions: activeSessionCount(),
    dbKB: dbSizeKB(),
    sseClients: sseClientCount(),
    node: process.version,
    nextResetAt,
    resetIntervalMs: RESET_INTERVAL_MS,
    alerts: activeAlerts(),
  };
});

// 告警状态变化（firing / resolved）→ 推进实时日志流与面板
onAlertChange((ev) => {
  pushLog({
    t: Date.now(), level: ev.state === 'firing' ? 'error' : 'info',
    method: 'ALERT', path: '/' + ev.ruleId, status: ev.state === 'firing' ? 500 : 200, ms: 0,
    actor: 'monitor',
    note: ev.state === 'firing'
      ? ('触发：' + ev.name + ' ' + ev.value + ev.unit + ' > ' + ev.threshold + ev.unit)
      : ('恢复：' + ev.name + '（持续 ' + ev.durationSec + 's）'),
  });
});

ensureAlertRules();

// 启动期自检：重置清单是否覆盖了所有引用 products/orders 的表（缺表 = 未来必崩）
{
  const missing = resetCoverageIssues(db);
  if (missing.length) console.warn('[启动自检] 重置清单缺表：' + missing.join(', ') + '（请补进 RESET_TABLES，否则演示重置会因外键失败而崩）');
  else console.log('[启动自检] 重置覆盖率完整（14 张表）');
}

// 告警判定必须独立于「有没有人开着监控面板」。
// 踩过的坑：一开始把判定塞在 SSE 推送的 enrich 里，而推送在没有订阅者时会直接 return，
// 结果出现"没人看面板时告警不评估"——监控系统最不该有的行为。现在独立成 1 秒定时器。
const alertTimer = setInterval(() => {
  try { evaluateAlerts(snapshot()); } catch {}
}, 1000);
alertTimer.unref?.();

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const secure = isSecure(req);
  // 统一挂安全头：API 响应同样需要（原来只有静态文件带，接口返回裸奔）
  for (const [hk, hv] of Object.entries(securityHeaders(secure))) { try { res.setHeader(hk, hv) } catch {} }
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

  // 首次启动写入种子数据；之后每 RESET_INTERVAL_MS 自动重置（只重置业务表，不动账号与会话）
  if (isBusinessDataEmpty(db)) {
    const r = resetDemoData(db, { force: true });
    console.log(`  [demo] 已写入种子数据：${r.categories} 分类 / ${r.products} 商品 / ${r.orders} 订单`);
  }
  const resetTimer = setInterval(() => {
    const r = resetDemoData(db, { force: true });
    nextResetAt = Date.now() + RESET_INTERVAL_MS;
    const note = `演示数据已重置为种子数据（${r.products} 商品 / ${r.orders} 订单）`;
    pushLog({ t: Date.now(), level: 'warn', method: 'SYSTEM', path: '/demo/reset', status: 200, ms: 0, actor: 'system', note });
    broadcast({ type: 'reset', at: Date.now(), counts: r, nextResetAt });
    console.log(`  [demo] ${note}`);
  }, RESET_INTERVAL_MS);
  resetTimer.unref?.();

  console.log(`[AURUM 家居运营中台 v${VERSION}] 已启动 → http://${HOST}:${PORT}/`);
  console.log(`  实时监控：/api/system/stream（SSE）   Prometheus：/api/system/metrics.prom`);
  console.log(`  演示数据每 ${Math.round(RESET_INTERVAL_MS / 60000)} 分钟自动重置（下次：${new Date(nextResetAt).toLocaleTimeString('zh-CN', { hour12: false })}）`);
  if (admin) {
    console.log('  ---------------------------------------------------------------');
    console.log(`  已创建管理员账号：${admin.username}`);
    console.log(`  初始密码（请立刻保存，页面不再显示）：${admin.password}`);
    console.log('  ---------------------------------------------------------------');
  }
});

export { server };
