/**
 * 商城前台服务（8091）—— 顾客侧：浏览 / 搜索 / 购物车 / 下单 / 我的订单
 *
 * 为什么单独一个服务：
 *  1) 前后台职责不同：前台面向公网顾客，后台面向运营；分开部署是电商的常规形态
 *  2) 安全边界不同：前台只读商品 + 写自己的购物车/订单；后台才有商品与用户管理权限
 *  3) 与后台共用同一个 SQLite 库和同一套会话/审计设施，不重复造轮子
 *
 * 复用：../db.js（数据）、../auth.js（scrypt 口令 + HMAC 会话 + 登录限流）、../metrics.js（指标）
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, audit } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, currentUser, parseCookies,
  sessionCookieHeader, clearCookieHeader, SESSION_COOKIE,
  loginAllowed, noteLoginFailure, clearLoginFailures,
} from '../auth.js';
import { recordRequest, snapshot, prometheusText } from '../metrics.js';
import {
  cartOf, cartItems, moveStock, ORDER_STATUS, ORDER_FLOW, now,
} from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', 'public');
const PORT = Number(process.env.SHOP_PORT ?? 8091);
const HOST = process.env.SHOP_HOST ?? '127.0.0.1';
const VERSION = '1.0.0';
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};
const json = (res, status, body, extra = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...extra });
  res.end(payload);
  return { status };
};
const securityHeaders = (secure) => ({
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"].join('; '),
  ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
});
const isSecure = (req) => String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const int = (v, min, max, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const csrfOk = (req) => String(req.headers['x-requested-with'] ?? '').toLowerCase() === 'fetch';

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) { const e = new Error('请求体过大'); e.status = 413; throw e; } chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const e = new Error('JSON 解析失败'); e.status = 400; throw e; }
}
function serveStatic(req, res, pathname, secure) {
  let p = pathname; try { p = decodeURIComponent(p); } catch { /* 保底 */ }
  if (p === '/' || p === '') p = '/shop.html';
  const target = join(PUBLIC_DIR, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return { status: 404 };
  }
  const st = statSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size, 'Cache-Control': extname(target) === '.html' ? 'no-store' : 'no-cache, must-revalidate',
    ...securityHeaders(secure),
  });
  createReadStream(target).pipe(res);
  return { status: 200 };
}

// ─────────────────── 顾客鉴权（复用 users 表 + role=customer） ───────────────────
const customerOf = (user) => (user && (user.role === 'customer' || user.role === 'admin') ? user : null);
const requireCustomer = (ctx) => {
  const c = customerOf(ctx.user);
  if (!c) { json(ctx.res, 401, { error: '请先登录' }); return null; }
  return c;
};

// ─────────────────── 商品（公开只读） ───────────────────
function publicProducts(sp) {
  const page = int(sp.get('page'), 1, 1000, 1);
  const size = int(sp.get('size'), 1, 48, 12);
  const kw = str(sp.get('q'), 60);
  const cat = int(sp.get('category'), 0, 1e9, 0);
  const sort = str(sp.get('sort'), 20) || 'new';
  const where = ['p.deleted = 0', 'p.status = 1'];
  const params = [];
  if (kw) { where.push('(p.name like ? or p.sku like ?)'); params.push(`%${kw}%`, `%${kw}%`); }
  if (cat) { where.push('p.category_id = ?'); params.push(cat); }
  const order = sort === 'price_asc' ? 'p.price_cents asc' : sort === 'price_desc' ? 'p.price_cents desc' : sort === 'hot' ? 'sold desc' : 'p.id desc';
  const clause = where.join(' and ');
  const total = db.prepare(`select count(*) c from products p where ${clause}`).get(...params).c;
  const rows = db.prepare(`
    select p.id, p.sku, p.name, p.price_cents, p.stock, p.description, c.name as category,
           (select coalesce(sum(oi.qty),0) from order_items oi where oi.product_id = p.id) as sold,
           (select coalesce(round(avg(rating),1),0) from reviews r where r.product_id = p.id) as rating
    from products p left join categories c on c.id = p.category_id
    where ${clause} order by ${order} limit ? offset ?
  `).all(...params, size, (page - 1) * size);
  return { page, size, total, rows: rows.map((r) => ({ ...r, price: r.price_cents / 100 })) };
}

// ─────────────────── 路由 ───────────────────
const ROUTES = [];
const route = (method, pattern, handler) => ROUTES.push({ method, pattern, handler });
const productById = (id) => db.prepare(`
  select p.*, c.name as category, (select coalesce(sum(oi.qty),0) from order_items oi where oi.product_id = p.id) as sold,
         (select coalesce(round(avg(rating),1),0) from reviews r where r.product_id = p.id) as rating,
         (select count(*) from reviews r where r.product_id = p.id) as review_count
  from products p left join categories c on c.id = p.category_id
  where p.id = ? and p.deleted = 0`).get(id);

route('GET', '/api/shop/categories', async ({ res }) => json(res, 200, {
  rows: db.prepare(`select c.id, c.name, (select count(*) from products p where p.category_id = c.id and p.deleted = 0 and p.status = 1) as count
                    from categories c where c.deleted = 0 and c.status = 1 order by c.sort, c.id`).all(),
}));
route('GET', '/api/shop/products', async ({ res, url }) => json(res, 200, publicProducts(url.searchParams)));
route('GET', '/api/shop/products/:id', async ({ res, params }) => {
  const p = productById(int(params.id, 1, 1e15, 0));
  if (!p || p.status !== 1) return json(res, 404, { error: '商品不存在或已下架' });
  const reviews = db.prepare('select r.rating, r.content, r.created_at, u.username from reviews r join users u on u.id = r.user_id where r.product_id = ? order by r.id desc limit 20').all(p.id);
  return json(res, 200, {
    product: { id: p.id, sku: p.sku, name: p.name, price: p.price_cents / 100, priceCents: p.price_cents, stock: p.stock,
      description: p.description, category: p.category, categoryId: p.category_id, sold: p.sold, rating: p.rating, reviewCount: p.review_count },
    reviews,
  });
});

route('POST', '/api/shop/register', async ({ req, res, body, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With 请求头' });
  const username = str(body.username, 40);
  const password = String(body.password ?? '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json(res, 400, { error: '用户名需为 3-20 位字母、数字或下划线' });
  if (password.length < 8) return json(res, 400, { error: '密码至少 8 位' });
  if (db.prepare('select id from users where username = ?').get(username)) return json(res, 409, { error: '用户名已被注册' });
  const r = db.prepare('insert into users(username,display_name,password_hash,role,active,created_at) values (?,?,?,?,1,?)')
    .run(username, str(body.nickname, 30) || username, hashPassword(password), 'customer', now());
  const uid = Number(r.lastInsertRowid);
  db.prepare('insert into customers(user_id, nickname, phone, created_at) values (?,?,?,?)').run(uid, str(body.nickname, 30) || username, str(body.phone, 20), now());
  audit(username, 'shop_register', `user#${uid}`, '前台注册', ip);
  const { token, expires } = createSession({ id: uid }, ip, req.headers['user-agent']);
  return json(res, 201, { ok: true }, { 'Set-Cookie': sessionCookieHeader(token, expires, isSecure(req)) });
});

route('POST', '/api/shop/login', async ({ req, res, body, ip }) => {
  if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With 请求头' });
  const username = str(body.username, 40);
  const key = `${ip}|shop|${username}`;
  if (!loginAllowed(key)) return json(res, 429, { error: '尝试次数过多，请 10 分钟后再试' });
  const user = db.prepare("select * from users where username = ? and active = 1 and role in ('customer','admin')").get(username);
  if (!user || !verifyPassword(String(body.password ?? ''), user.password_hash)) {
    const st = noteLoginFailure(key);
    return json(res, 401, { error: '用户名或密码错误', failed: st.count });
  }
  clearLoginFailures(key);
  const { token, expires } = createSession(user, ip, req.headers['user-agent']);
  audit(user.username, 'shop_login', 'session', '', ip);
  return json(res, 200, { user: { username: user.username, nickname: user.display_name } }, { 'Set-Cookie': sessionCookieHeader(token, expires, isSecure(req)) });
});
route('POST', '/api/shop/logout', async ({ req, res, cookies }) => {
  destroySession(cookies[SESSION_COOKIE]);
  return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader(isSecure(req)) });
});
route('GET', '/api/shop/me', async ({ res, user }) => {
  const c = customerOf(user);
  if (!c) return json(res, 200, { user: null });
  const cust = db.prepare('select * from customers where user_id = ?').get(c.id);
  return json(res, 200, { user: { username: c.username, nickname: cust?.nickname || c.displayName, phone: cust?.phone || '' } });
});

// ─────────────────── 购物车 ───────────────────
const cartPayload = (userId) => {
  const items = cartItems(cartOf(userId));
  const total = items.reduce((a, b) => a + b.subtotal_cents, 0);
  return { items: items.map((i) => ({ id: i.id, productId: i.product_id, sku: i.sku, name: i.name, price: i.price_cents / 100, qty: i.qty, stock: i.stock, subtotal: i.subtotal_cents / 100 })), totalCents: total, total: total / 100, count: items.reduce((a, b) => a + b.qty, 0) };
};
route('GET', '/api/shop/cart', async (ctx) => {
  const c = requireCustomer(ctx); if (!c) return;
  return json(ctx.res, 200, cartPayload(c.id));
});
route('POST', '/api/shop/cart', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  const pid = int(ctx.body.productId, 1, 1e15, 0);
  const qty = int(ctx.body.qty, 1, 99, 1);
  const p = productById(pid);
  if (!p || p.status !== 1) return json(ctx.res, 404, { error: '商品不存在或已下架' });
  const cartId = cartOf(c.id);
  const exist = db.prepare('select * from cart_items where cart_id = ? and product_id = ?').get(cartId, pid);
  const want = (exist?.qty ?? 0) + qty;
  if (want > p.stock) return json(ctx.res, 409, { error: `库存不足（剩 ${p.stock} 件）` });
  if (exist) db.prepare('update cart_items set qty = ? where id = ?').run(want, exist.id);
  else db.prepare('insert into cart_items(cart_id, product_id, qty, added_at) values (?,?,?,?)').run(cartId, pid, qty, now());
  return json(ctx.res, 200, cartPayload(c.id));
});
route('PUT', '/api/shop/cart/:id', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  const row = db.prepare('select * from cart_items where id = ? and cart_id = ?').get(int(ctx.params.id, 1, 1e15, 0), cartOf(c.id));
  if (!row) return json(ctx.res, 404, { error: '购物车项不存在' });
  const qty = int(ctx.body.qty, 0, 99, 1);
  if (qty === 0) { db.prepare('delete from cart_items where id = ?').run(row.id); return json(ctx.res, 200, cartPayload(c.id)); }
  const p = productById(row.product_id);
  if (qty > (p?.stock ?? 0)) return json(ctx.res, 409, { error: `库存不足（剩 ${p?.stock ?? 0} 件）` });
  db.prepare('update cart_items set qty = ? where id = ?').run(qty, row.id);
  return json(ctx.res, 200, cartPayload(c.id));
});
route('DELETE', '/api/shop/cart/:id', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  db.prepare('delete from cart_items where id = ? and cart_id = ?').run(int(ctx.params.id, 1, 1e15, 0), cartOf(c.id));
  return json(ctx.res, 200, cartPayload(c.id));
});

// ─────────────────── 收货地址 ───────────────────
route('GET', '/api/shop/addresses', async (ctx) => {
  const c = requireCustomer(ctx); if (!c) return;
  return json(ctx.res, 200, { rows: db.prepare('select * from addresses where user_id = ? order by is_default desc, id desc').all(c.id) });
});
route('POST', '/api/shop/addresses', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  const receiver = str(ctx.body.receiver, 30), phone = str(ctx.body.phone, 20);
  if (!receiver || !phone) return json(ctx.res, 400, { error: '收货人与手机号必填' });
  if (!/^1\d{10}$|^\d{6,20}$/.test(phone.replace(/[^0-9]/g, ''))) return json(ctx.res, 400, { error: '手机号格式不正确' });
  const isDefault = ctx.body.isDefault ? 1 : 0;
  if (isDefault) db.prepare('update addresses set is_default = 0 where user_id = ?').run(c.id);
  const r = db.prepare('insert into addresses(user_id, receiver, phone, region, detail, is_default, created_at) values (?,?,?,?,?,?,?)')
    .run(c.id, receiver, phone, str(ctx.body.region, 60), str(ctx.body.detail, 120), isDefault, now());
  return json(ctx.res, 201, { id: Number(r.lastInsertRowid) });
});

// ─────────────────── 结算下单 ───────────────────
route('POST', '/api/shop/checkout', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  const addr = db.prepare('select * from addresses where id = ? and user_id = ?').get(int(ctx.body.addressId, 1, 1e15, 0), c.id);
  if (!addr) return json(ctx.res, 400, { error: '请选择有效的收货地址' });
  const items = cartItems(cartOf(c.id));
  if (!items.length) return json(ctx.res, 400, { error: '购物车是空的' });

  // 下单前逐项校验库存（真实系统还要做并发扣减/锁，这里用事务保证一致性）
  for (const i of items) {
    const p = db.prepare('select stock, status, name from products where id = ? and deleted = 0').get(i.product_id);
    if (!p || p.status !== 1) return json(ctx.res, 409, { error: `「${i.name}」已下架，请从购物车移除` });
    if (p.stock < i.qty) return json(ctx.res, 409, { error: `「${i.name}」库存不足（剩 ${p.stock} 件）` });
  }

  const totalCents = items.reduce((a, b) => a + b.subtotal_cents, 0);
  const orderNo = 'SO' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + String(Date.now()).slice(-5);

  db.exec('begin');
  try {
    const r = db.prepare(`insert into orders(order_no, customer, phone, total_cents, item_count, status, remark, created_by, created_at, updated_by, updated_at)
                          values (?,?,?,?,?, 'pending', ?,?,?,?,?)`)
      .run(orderNo, addr.receiver, addr.phone, totalCents, items.reduce((a, b) => a + b.qty, 0),
        `${addr.region} ${addr.detail}${ctx.body.remark ? ' / ' + str(ctx.body.remark, 100) : ''}`, c.username, now(), c.username, now());
    const orderId = Number(r.lastInsertRowid);
    const insItem = db.prepare('insert into order_items(order_id, product_id, sku, name, price_cents, qty, subtotal_cents) values (?,?,?,?,?,?,?)');
    for (const i of items) {
      insItem.run(orderId, i.product_id, i.sku, i.name, i.price_cents, i.qty, i.subtotal_cents);
      moveStock(i.product_id, -i.qty, '下单扣减', orderNo);
    }
    db.prepare('insert into payments(order_id, channel, amount_cents, status, created_at) values (?,?,?,?,?)').run(orderId, 'mock', totalCents, 'pending', now());
    db.prepare('delete from cart_items where cart_id = ?').run(cartOf(c.id));
    db.exec('commit');
    audit(c.username, 'shop_checkout', `order#${orderId}`, `${orderNo} / ${(totalCents / 100).toFixed(2)} 元`, ctx.ip);
    return json(ctx.res, 201, { orderNo, orderId, total: totalCents / 100 });
  } catch (e) {
    db.exec('rollback');
    return json(ctx.res, 500, { error: '下单失败：' + e.message });
  }
});

route('POST', '/api/shop/orders/:id/pay', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  const o = db.prepare('select * from orders where id = ? and deleted = 0').get(int(ctx.params.id, 1, 1e15, 0));
  if (!o) return json(ctx.res, 404, { error: '订单不存在' });
  if (o.created_by !== c.username) return json(ctx.res, 403, { error: '无权操作他人订单' });
  if (o.status !== 'pending') return json(ctx.res, 409, { error: `订单当前是「${ORDER_STATUS[o.status]}」，无法支付` });
  const tradeNo = 'MOCK' + Date.now();
  db.exec('begin');
  try {
    db.prepare("update orders set status = 'paid', updated_at = ? where id = ?").run(now(), o.id);
    db.prepare("update payments set status = 'paid', trade_no = ?, paid_at = ? where order_id = ?").run(tradeNo, now(), o.id);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); return json(ctx.res, 500, { error: '支付失败' }); }
  audit(c.username, 'shop_pay', `order#${o.id}`, `${o.order_no} / 模拟支付 ${tradeNo}`, ctx.ip);
  return json(ctx.res, 200, { ok: true, tradeNo, note: '演示环境为模拟支付，未接入真实支付渠道' });
});

route('POST', '/api/shop/orders/:id/cancel', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  const o = db.prepare('select * from orders where id = ? and deleted = 0').get(int(ctx.params.id, 1, 1e15, 0));
  if (!o) return json(ctx.res, 404, { error: '订单不存在' });
  if (o.created_by !== c.username) return json(ctx.res, 403, { error: '无权操作他人订单' });
  if (!(ORDER_FLOW[o.status] ?? []).includes('cancelled')) return json(ctx.res, 409, { error: `「${ORDER_STATUS[o.status]}」状态不可取消` });
  db.exec('begin');
  try {
    db.prepare("update orders set status = 'cancelled', updated_at = ? where id = ?").run(now(), o.id);
    for (const it of db.prepare('select * from order_items where order_id = ?').all(o.id)) moveStock(it.product_id, it.qty, '订单取消回补', o.order_no);
    db.prepare("update payments set status = 'refunded' where order_id = ? and status = 'paid'").run(o.id);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); return json(ctx.res, 500, { error: '取消失败' }); }
  audit(c.username, 'shop_cancel', `order#${o.id}`, o.order_no, ctx.ip);
  return json(ctx.res, 200, { ok: true });
});

route('GET', '/api/shop/orders', async (ctx) => {
  const c = requireCustomer(ctx); if (!c) return;
  const rows = db.prepare(`select o.id, o.order_no, o.total_cents, o.item_count, o.status, o.created_at, o.remark,
                                  (select group_concat(name, ' / ') from order_items oi where oi.order_id = o.id) as items
                           from orders o where o.deleted = 0 and o.created_by = ? order by o.id desc limit 50`).all(c.username);
  return json(ctx.res, 200, { rows: rows.map((r) => ({ ...r, total: r.total_cents / 100, statusText: ORDER_STATUS[r.status] ?? r.status })) });
});
route('GET', '/api/shop/orders/:orderNo', async (ctx) => {
  const c = requireCustomer(ctx); if (!c) return;
  const o = db.prepare('select * from orders where order_no = ? and deleted = 0').get(str(ctx.params.orderNo, 32));
  if (!o || o.created_by !== c.username) return json(ctx.res, 404, { error: '订单不存在' });
  const items = db.prepare('select * from order_items where order_id = ?').all(o.id);
  const pay = db.prepare('select * from payments where order_id = ? order by id desc limit 1').get(o.id);
  return json(ctx.res, 200, {
    order: { id: o.id, orderNo: o.order_no, total: o.total_cents / 100, status: o.status, statusText: ORDER_STATUS[o.status] ?? o.status,
      itemCount: o.item_count, receiver: o.customer, phone: o.phone, remark: o.remark, createdAt: o.created_at },
    items: items.map((i) => ({ name: i.name, sku: i.sku, price: i.price_cents / 100, qty: i.qty, subtotal: i.subtotal_cents / 100 })),
    payment: pay ? { channel: pay.channel, status: pay.status, tradeNo: pay.trade_no, paidAt: pay.paid_at } : null,
  });
});

route('POST', '/api/shop/reviews', async (ctx) => {
  if (!csrfOk(ctx.req)) return json(ctx.res, 400, { error: '缺少 X-Requested-With' });
  const c = requireCustomer(ctx); if (!c) return;
  const pid = int(ctx.body.productId, 1, 1e15, 0);
  const oid = int(ctx.body.orderId, 1, 1e15, 0);
  const bought = db.prepare('select o.id from orders o join order_items oi on oi.order_id = o.id where o.id = ? and oi.product_id = ? and o.created_by = ?').get(oid, pid, c.username);
  if (!bought) return json(ctx.res, 403, { error: '只能评价自己买过的商品' });
  db.prepare('insert into reviews(product_id, user_id, order_id, rating, content, created_at) values (?,?,?,?,?,?)')
    .run(pid, c.id, oid, int(ctx.body.rating, 1, 5, 5), str(ctx.body.content, 300), now());
  return json(ctx.res, 201, { ok: true });
});

// 监控端点（沿用后台那套指标）
route('GET', '/api/shop/metrics.prom', async ({ res }) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(prometheusText());
  return { status: 200 };
});
route('GET', '/api/shop/health', async ({ res }) => json(res, 200, {
  status: 'ok', service: 'shop', version: VERSION, uptimeSec: Math.round(process.uptime()),
  products: db.prepare('select count(*) c from products where deleted = 0 and status = 1').get().c,
  orders: db.prepare('select count(*) c from orders where deleted = 0').get().c,
}));

function match(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const parts = r.pattern.split('/').filter(Boolean), actual = pathname.split('/').filter(Boolean);
    if (parts.length !== actual.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = actual[i];
      else if (parts[i] !== actual[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const secure = isSecure(req);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  const pathname = url.pathname;
  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const cookies = parseCookies(req.headers.cookie ?? '');
  const user = currentUser(req);
  try {
    if (pathname.startsWith('/api/')) {
      const hit = match(req.method ?? 'GET', pathname);
      if (!hit) { json(res, 404, { error: '接口不存在' }); recordRequest({ method: req.method, path: pathname, status: 404, ms: Date.now() - t0, actor: user?.username }); return; }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readJson(req) : {};
      const ctx = { req, res, url, body, params: hit.params, user, ip, cookies, secure };
      try {
        const out = await hit.route.handler(ctx);
        recordRequest({ method: req.method, path: pathname, status: out?.status ?? 200, ms: Date.now() - t0, actor: user?.username });
      } catch (err) {
        const status = err?.status ?? 500;
        json(res, status, { error: err?.message ?? '服务器错误' });
        recordRequest({ method: req.method, path: pathname, status, ms: Date.now() - t0, actor: user?.username, note: '异常' });
      }
      return;
    }
    serveStatic(req, res, pathname, secure);
  } catch (err) {
    try { json(res, err?.status ?? 500, { error: err?.message ?? '服务器错误' }); } catch {}
    recordRequest({ method: req.method, path: pathname, status: err?.status ?? 500, ms: Date.now() - t0, note: '异常' });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`[AURUM 商城前台 v${VERSION}] 已启动 → http://${HOST}:${PORT}/`);
  console.log(`  顾客侧：浏览/搜索/购物车/下单/我的订单   监控：/api/shop/metrics.prom`);
});
export { server };
