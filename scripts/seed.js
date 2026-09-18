/**
 * 种子数据：家具分类 / 商品 / 订单（与第一版「至尊家居」的业务域一致，便于对照）
 * 用法：node scripts/seed.js          仅在空库时写入
 *       node scripts/seed.js --force  清空业务数据后重写
 */
import { db, now, audit } from '../src/db.js';

const force = process.argv.includes('--force');

const categories = [
  { name: '沙发', sort: 1, remark: '客厅主家具' },
  { name: '床类', sort: 2, remark: '实木床 / 软床' },
  { name: '餐桌椅', sort: 3, remark: '餐厅家具' },
  { name: '衣柜', sort: 4, remark: '定制与成品衣柜' },
  { name: '储物收纳', sort: 5, remark: '边柜 / 斗柜 / 置物架' },
  { name: '户外家具', sort: 6, remark: '阳台与庭院' },
];

const products = [
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

const orders = [
  ['SO20260901001', '李先生', '138****2211', 2699.0, 1, 'done', '自提'],
  ['SO20260902002', '王女士', '139****7788', 8898.0, 2, 'shipped', '需要上门安装'],
  ['SO20260903003', '张先生', '137****3344', 4599.0, 1, 'paid', '工作日送达'],
  ['SO20260904004', '刘女士', '135****9900', 11198.0, 3, 'pending', '货款到账后发货'],
  ['SO20260905005', '陈先生', '186****1122', 1899.0, 1, 'cancelled', '客户改选其他型号'],
  ['SO20260906006', '赵女士', '188****5566', 5699.0, 1, 'paid', '含安装'],
];

if (force) {
  db.exec('delete from products; delete from categories; delete from orders;');
  console.log('[seed] 已清空业务数据');
}

const isEmpty = db.prepare('select count(*) as c from categories').get().c === 0;
if (!isEmpty) {
  console.log('[seed] 已有数据，跳过（要重写请加 --force）');
  process.exit(0);
}

const catIds = {};
const insCat = db.prepare(`insert into categories(name,sort,status,remark,created_by,created_at,updated_by,updated_at)
                           values (?,?,1,?,'seed',?, 'seed',?)`);
for (const c of categories) {
  const r = insCat.run(c.name, c.sort, c.remark, now(), now());
  catIds[c.name] = Number(r.lastInsertRowid);
}

const insProd = db.prepare(`insert into products(sku,name,category_id,price_cents,stock,status,description,created_by,created_at,updated_by,updated_at)
                            values (?,?,?,?,?,?,?,'seed',?, 'seed',?)`);
for (const [sku, name, cat, price, stock, status, desc] of products) {
  insProd.run(sku, name, catIds[cat] ?? null, Math.round(price * 100), stock, status, desc, now(), now());
}

const insOrder = db.prepare(`insert into orders(order_no,customer,phone,total_cents,item_count,status,remark,created_by,created_at,updated_by,updated_at)
                             values (?,?,?,?,?,?,?,'seed',?, 'seed',?)`);
for (const [no, cust, phone, total, items, status, remark] of orders) {
  insOrder.run(no, cust, phone, Math.round(total * 100), items, status, remark, now(), now());
}

audit('seed', 'seed_data', 'database', `${categories.length} 分类 / ${products.length} 商品 / ${orders.length} 订单`, 'local');

console.log(`[seed] 完成：${categories.length} 个分类、${products.length} 个商品、${orders.length} 个订单`);
