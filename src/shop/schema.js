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
    select ci.id, ci.qty, p.id as product_id, p.sku, p.name, p.price_cents, p.stock, p.status,
           (p.price_cents * ci.qty) as subtotal_cents
    from cart_items ci join products p on p.id = ci.product_id
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
