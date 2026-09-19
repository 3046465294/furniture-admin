/**
 * 电商数据模型（在前台/后台之间共享的库表）
 *
 * 设计说明：
 *  · 与后台管理系统共用同一个 SQLite 库（data/furniture.db），前后台各跑一个服务
 *  · 顾客与后台用户共用 users 表，用 role 区分（customer / operator / admin / viewer），
 *    这样鉴权、会话、审计这套基础设施完全复用，不用维护两套登录
 *  · 金额一律以「分」存储（整数），避免浮点误差
 *  · 订单主表 orders 沿用后台已有结构，订单明细单独放 order_items —— 这是电商的核心关系
 *  · 库存变动留痕（stock_movements），下单/取消/人工调整都可追溯
 */
import { db, now } from '../db.js';

db.exec(`
-- 顾客资料（与 users 一对一）
create table if not exists customers (
  user_id    integer primary key references users(id),
  nickname   text default '',
  phone      text default '',
  created_at text
);

-- 收货地址（一个顾客可多条，默认一条）
create table if not exists addresses (
  id         integer primary key autoincrement,
  user_id    integer not null references users(id),
  receiver   text not null,
  phone      text not null,
  region     text not null default '',
  detail     text not null default '',
  is_default integer not null default 0,
  created_at text
);
create index if not exists idx_addr_user on addresses(user_id);

-- 购物车（一人一车）
create table if not exists carts (
  id         integer primary key autoincrement,
  user_id    integer not null unique references users(id),
  updated_at text
);

-- 购物车明细
create table if not exists cart_items (
  id         integer primary key autoincrement,
  cart_id    integer not null references carts(id),
  product_id integer not null references products(id),
  qty        integer not null default 1,
  added_at   text,
  unique(cart_id, product_id)
);

-- 订单明细（orders 目前只有汇总字段，这里补上买了什么）
create table if not exists order_items (
  id           integer primary key autoincrement,
  order_id     integer not null references orders(id),
  product_id   integer references products(id),
  sku          text not null default '',
  name         text not null default '',
  price_cents  integer not null default 0,
  qty          integer not null default 1,
  subtotal_cents integer not null default 0
);
create index if not exists idx_oitems_order on order_items(order_id);

-- 支付流水（演示环境为模拟支付，字段按真实支付网关的形态设计）
create table if not exists payments (
  id         integer primary key autoincrement,
  order_id   integer not null references orders(id),
  channel    text not null default 'mock',
  amount_cents integer not null default 0,
  status     text not null default 'pending',   -- pending | paid | failed | refunded
  trade_no   text default '',
  created_at text,
  paid_at    text
);
create index if not exists idx_pay_order on payments(order_id);

-- 库存变动留痕
create table if not exists stock_movements (
  id         integer primary key autoincrement,
  product_id integer not null references products(id),
  delta      integer not null,
  reason     text not null default '',
  ref        text default '',
  created_at text
);

-- 商品评价（下单后可评，演示环境不做审核流程）
create table if not exists reviews (
  id         integer primary key autoincrement,
  product_id integer not null references products(id),
  user_id    integer not null references users(id),
  order_id   integer references orders(id),
  rating     integer not null default 5,
  content    text default '',
  created_at text
);
create index if not exists idx_review_product on reviews(product_id);
`);

// ── 商品域：SPU(商品) → SKU(规格) + 商品图 ──
db.exec(`
create table if not exists product_skus (
  id          integer primary key autoincrement,
  product_id  integer not null references products(id),
  spec        text not null default '默认',
  specs_json  text not null default '{}',
  sku_code    text default '',
  price_cents integer not null default 0,
  stock       integer not null default 0,
  status      integer not null default 1,
  created_at  text, updated_at text,
  unique(product_id, spec)
);
create index if not exists idx_sku_product on product_skus(product_id);
create table if not exists product_images (
  id         integer primary key autoincrement,
  product_id integer not null references products(id),
  url        text not null,
  sort       integer not null default 0,
  is_primary integer not null default 0,
  created_at text
);
create index if not exists idx_img_product on product_images(product_id);
`);

// 购物车项支持 SKU（老库没有该列时补上，向后兼容）
try { db.exec('alter table cart_items add column sku_id integer'); } catch { /* 已存在 */ }
try { db.exec('alter table order_items add column sku_id integer'); } catch { /* 已存在 */ }

/** 幂等迁移：为没有规格的商品生成「默认」SKU，并把老购物车项挂到默认 SKU 上 */
export function ensureSkus() {
  const noSku = db.prepare('select p.* from products p where p.deleted = 0 and not exists (select 1 from product_skus s where s.product_id = p.id)').all();
  const ins = db.prepare('insert into product_skus(product_id, spec, specs_json, sku_code, price_cents, stock, status, created_at, updated_at) values (?,?,?,?,?,?,1,?,?)');
  for (const p of noSku) ins.run(p.id, '默认', '{}', p.sku || '', p.price_cents, p.stock, now(), now());
  const fixed = db.prepare('update cart_items set sku_id = (select id from product_skus s where s.product_id = cart_items.product_id order by s.id limit 1) where sku_id is null').run().changes;
  return { created: noSku.length, cartsFixed: fixed };
}

/** 某商品的全部规格 */
export function skusOf(productId) {
  return db.prepare('select * from product_skus where product_id = ? and status = 1 order by id').all(productId);
}
/** 商品图（主图在前） */
export function imagesOf(productId) {
  return db.prepare('select url, is_primary from product_images where product_id = ? order by is_primary desc, sort, id').all(productId);
}
/** 库存聚合：products.stock 保持为各 SKU 之和（后台与告警沿用这个口径） */
export function syncProductStock(productId) {
  const s = db.prepare('select coalesce(sum(stock),0) total from product_skus where product_id = ? and status = 1').get(productId).total;
  db.prepare('update products set stock = ?, updated_at = ? where id = ?').run(s, now(), productId);
  return s;
}

// ── 运费模板 ──
db.exec(`
create table if not exists shipping_templates (
  id              integer primary key autoincrement,
  name            text not null,
  region_keywords text default '',      -- 命中地址中任一关键词即适用（逗号分隔）
  base_cents      integer not null default 0,   -- 首件运费
  per_item_cents  integer not null default 0,   -- 续件运费
  free_over_cents integer not null default 0,   -- 满此金额包邮（0 = 不包邮）
  enabled         integer not null default 1,
  sort            integer not null default 0,
  created_at      text
);
`);
try { db.exec('alter table orders add column goods_cents integer'); } catch { /* 已存在 */ }
try { db.exec('alter table orders add column shipping_cents integer'); } catch { /* 已存在 */ }

/** 幂等种子：三档运费模板（默认免运费，保证演示环境可预期） */
export function ensureShippingTemplates() {
  const n = db.prepare('select count(*) c from shipping_templates').get().c;
  if (n > 0) return n;
  const ins = db.prepare('insert into shipping_templates(name, region_keywords, base_cents, per_item_cents, free_over_cents, enabled, sort, created_at) values (?,?,?,?,?,1,?,?)');
  ins.run('默认（演示免运费）', '', 0, 0, 0, 10, now());
  ins.run('常规地区', '北京,上海,广东,江苏,浙江,四川,湖北', 1200, 300, 200000, 20, now());
  ins.run('偏远地区', '新疆,西藏,青海,内蒙古,甘肃,宁夏,海南', 3500, 800, 500000, 30, now());
  return 3;
}

/**
 * 计算运费。region 为收货地区文本（用于匹配模板），goodsCents 为商品金额，itemCount 为件数。
 * 匹配规则：命中关键词最多的模板优先；无命中则用默认模板（sort 最小）。
 */
export function quoteShipping(region, goodsCents, itemCount) {
  const list = db.prepare('select * from shipping_templates where enabled = 1 order by sort, id').all();
  if (!list.length) return { feeCents: 0, name: '未配置运费模板', freeApplied: false };
  const text = String(region ?? '');
  let best = null, bestHit = 0;
  for (const t of list) {
    const kws = String(t.region_keywords || '').split(',').map((s) => s.trim()).filter(Boolean);
    const hit = kws.filter((k) => text.includes(k)).length;
    if (hit > bestHit) { best = t; bestHit = hit }
  }
  const tpl = best ?? list[0];
  const free = tpl.free_over_cents > 0 && goodsCents >= tpl.free_over_cents;
  const extra = Math.max(0, itemCount - 1);
  const feeCents = free ? 0 : tpl.base_cents + tpl.per_item_cents * extra;
  return { feeCents, name: tpl.name, freeApplied: free, freeOverCents: tpl.free_over_cents };
}

export const ORDER_STATUS = { pending: '待付款', paid: '已付款', shipped: '已发货', done: '已完成', cancelled: '已取消' };
/** 状态机：前台只能做「支付」和「取消」，发货/完成由后台操作 */
export const ORDER_FLOW = { pending: ['paid', 'cancelled'], paid: ['shipped', 'cancelled'], shipped: ['done'], done: [], cancelled: [] };

/** 取购物车 id（不存在就建） */
export function cartOf(userId) {
  let row = db.prepare('select id from carts where user_id = ?').get(userId);
  if (!row) {
    const r = db.prepare('insert into carts(user_id, updated_at) values (?, ?)').run(userId, now());
    row = { id: Number(r.lastInsertRowid) };
  }
  return row.id;
}

/** 购物车内容（联商品，过滤已删除/下架） */
export function cartItems(cartId) {
  return db.prepare(`
    select ci.id, ci.qty, ci.sku_id, p.id as product_id, p.sku, p.name, p.status,
           coalesce(s.price_cents, p.price_cents) as price_cents,
           coalesce(s.stock, p.stock) as stock,
           coalesce(s.spec, '默认') as spec,
           (coalesce(s.price_cents, p.price_cents) * ci.qty) as subtotal_cents
    from cart_items ci join products p on p.id = ci.product_id
    left join product_skus s on s.id = ci.sku_id
    where ci.cart_id = ? and p.deleted = 0
    order by ci.id desc
  `).all(cartId);
}

/** 库存变更 + 留痕 */
export function moveStock(productId, delta, reason, ref = '') {
  db.prepare('update products set stock = stock + ?, updated_at = ? where id = ?').run(delta, now(), productId);
  db.prepare('insert into stock_movements(product_id, delta, reason, ref, created_at) values (?,?,?,?,?)')
    .run(productId, delta, reason, ref, now());
}

export { db, now };
