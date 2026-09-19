/**
  try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
 * 演示数据定义 + 一键重置（供 CLI 与服务的定时重置共用）
 *
 * 为什么单独抽出来：登录页上写着「数据每 10 分钟重置为种子数据」，
 * 这句话必须在代码里成立 —— 所以重置逻辑和服务端定时器用的是同一份数据。
 */
import { now } from './db.js';

export const CATEGORIES = [
  { name: '沙发', sort: 1, remark: '客厅主家具' },
  { name: '床类', sort: 2, remark: '实木床 / 软床' },
  { name: '餐桌椅', sort: 3, remark: '餐厅家具' },
  { name: '衣柜', sort: 4, remark: '定制与成品衣柜' },
  { name: '储物收纳', sort: 5, remark: '边柜 / 斗柜 / 置物架' },
  { name: '户外家具', sort: 6, remark: '阳台与庭院' },
];

export const PRODUCTS = [
  ['SF-1001', '北欧简约三人布艺沙发', '沙发', 2699.0, 18, 1, '可拆洗棉麻面料，实木框架，长 210cm'],
  ['SF-1002', '意式极简真皮沙发（四人位）', '沙发', 8999.0, 6, 1, '头层牛皮，高回弹海绵，含贵妃位'],
  ['SF-1003', '客厅多功能沙发床', '沙发', 3399.0, 11, 1, '三档可调靠背，展开 190×120cm'],
  ['BD-2001', '白蜡木实木双人床 1.8m', '床类', 4299.0, 9, 1, '榫卯结构，环保水性漆，含床板'],
  ['BD-2002', '软包靠背储物床 1.5m', '床类', 3899.0, 7, 1, '床下大容量储物，气动升降'],
  ['BD-2003', '儿童护栏床 1.2m', '床类', 1899.0, 15, 1, '圆角处理，可拆护栏'],
  ['DT-3001', '岩板伸缩餐桌（1.4-1.8m）', '餐桌椅', 4599.0, 12, 1, '12mm 岩板台面，实木伸缩结构'],
  ['DT-3002', '白蜡木餐椅（四把装）', '餐桌椅', 2399.0, 20, 1, '人体工学靠背，可叠放'],
  ['DT-3003', '小户型圆餐桌 1.0m', '餐桌椅', 1699.0, 14, 1, '适合 2-4 人，中柱实木底座'],
  ['WG-4001', '推拉门实木衣柜 2.0m', '衣柜', 5699.0, 5, 1, '内部可调层板，含穿衣镜'],
  ['WG-4002', '开放式衣帽间组合', '衣柜', 7899.0, 3, 1, '可按墙面尺寸模块化组合'],
  ['ST-5001', '实木五斗柜', '储物收纳', 2299.0, 16, 1, '静音滑轨，防倾倒设计'],
  ['ST-5002', '客厅电视边柜 1.8m', '储物收纳', 1999.0, 10, 0, '已下架：等待新款替代'],
  ['OD-6001', '户外藤编休闲三件套', '户外家具', 3199.0, 8, 1, 'PE 藤编，防雨坐垫'],
];

export const ORDERS = [
  ['SO20260901001', '李先生', '138****2211', 2699.0, 1, 'done', '自提'],
  ['SO20260902002', '王女士', '139****7788', 8898.0, 2, 'shipped', '需要上门安装'],
  ['SO20260903003', '张先生', '137****3344', 4599.0, 1, 'paid', '工作日送达'],
  ['SO20260904004', '刘女士', '135****9900', 11198.0, 3, 'pending', '货款到账后发货'],
  ['SO20260905005', '陈先生', '186****1122', 1899.0, 1, 'cancelled', '客户改选其他型号'],
  ['SO20260906006', '赵女士', '188****5566', 5699.0, 1, 'paid', '含安装'],
];

/** 只判断业务数据是否为空（首次启动用） */
export function isBusinessDataEmpty(db) {
  return db.prepare('select count(*) as c from categories').get().c === 0;
}

/**
 * 把业务数据恢复成种子状态。
 * 注意：只清业务表（商品/分类/订单/审计），**不动 users 与会话**，
 * 否则演示者每次重置都会被踢下线。
 */
/**
 * 重置覆盖率自检：任何"引用 products / orders"的表如果没有出现在重置清单里，
 * 删除时就会触发 FOREIGN KEY constraint failed（曾导致后台每 10 分钟崩一次）。
 * 启动与重置时都会检查，缺表直接告警 —— 用机制代替记忆。
 */
const RESET_TABLES = ["shipments", "refunds", "order_items", "payments", "stock_movements", "reviews",
  "product_images", "product_skus", "cart_items", "carts", "orders", "products", "categories", "audit_log"];
export function resetCoverageIssues(db) {
  try {
    const tables = db.prepare("select name, sql from sqlite_master where type = 'table'").all();
    const missing = [];
    for (const t of tables) {
      if (!t.sql) continue;
      if (RESET_TABLES.includes(t.name)) continue;
      if (/references\s+(products|orders)/i.test(t.sql)) missing.push(t.name);
    }
    return missing;
  } catch { return []; }
}

export function resetDemoData(db, { force = false } = {}) {
  if (!force && !isBusinessDataEmpty(db)) return null;

  // 注意顺序：先删依赖表再删主表。只清业务数据，不动 users（账号）与 addresses（顾客自己的资料）。
  // 踩过的坑：最初只删了 orders，导致 order_items / payments / stock_movements 变成孤儿数据，
  // 商品删除后订单明细还会引用不存在的商品 id。
  // 删除顺序必须覆盖所有引用关系（漏一张就会 FOREIGN KEY constraint failed —— 这就是上次后台崩落的原因）：
//   shipments / refunds / order_items / payments  → orders
//   product_skus / product_images / stock_movements / reviews / cart_items → products
//   cart_items → carts
  try { db.exec('PRAGMA foreign_keys = OFF'); } catch {}
db.exec(`
  delete from shipments;
  delete from refunds;
  delete from order_items;
  delete from payments;
  delete from stock_movements;
  delete from reviews;
  delete from product_images;
  delete from product_skus;
  delete from cart_items;
  delete from carts;
  delete from orders;
  delete from products;
  delete from categories;
  delete from audit_log;
`);
  try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
  // 自检：重置后外键约束必须恢复开启（关闭状态下会静默允许孤儿数据）
  try {
    const fk = db.prepare('pragma foreign_keys').get();
    if (fk && String(fk.foreign_keys) === '0') console.warn('[reset] 警告：外键约束未恢复为开启，存在孤儿数据风险');
  } catch {}

  const insCat = db.prepare(`insert into categories(name,sort,status,remark,created_by,created_at,updated_by,updated_at)
                             values (?,?,1,?,'seed',?,'seed',?)`);
  const catIds = {};
  for (const c of CATEGORIES) catIds[c.name] = Number(insCat.run(c.name, c.sort, c.remark, now(), now()).lastInsertRowid);

  const insProd = db.prepare(`insert into products(sku,name,category_id,price_cents,stock,status,description,created_by,created_at,updated_by,updated_at)
                              values (?,?,?,?,?,?,?,'seed',?,'seed',?)`);
  for (const [sku, name, cat, price, stock, status, desc] of PRODUCTS) {
    insProd.run(sku, name, catIds[cat] ?? null, Math.round(price * 100), stock, status, desc, now(), now());
  }

  const insOrder = db.prepare(`insert into orders(order_no,customer,phone,total_cents,item_count,status,remark,created_by,created_at,updated_by,updated_at)
                               values (?,?,?,?,?,?,?,'seed',?,'seed',?)`);
  for (const [no, cust, phone, total, items, status, remark] of ORDERS) {
    insOrder.run(no, cust, phone, Math.round(total * 100), items, status, remark, now(), now());
  }

  db.prepare('insert into audit_log(actor,action,target,detail,ip,created_at) values (?,?,?,?,?,?)')
    .run('system', 'demo_reset', 'database',
      `${CATEGORIES.length} 分类 / ${PRODUCTS.length} 商品 / ${ORDERS.length} 订单 已重置为种子数据`, 'internal', now());

  return { categories: CATEGORIES.length, products: PRODUCTS.length, orders: ORDERS.length };
}
