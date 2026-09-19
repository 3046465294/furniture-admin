/**
 * 无障碍验收夹具：建一个双规格商品，并自检接口能看到它
 * 用法：node scripts/verify-a11y-fixture.mjs   → 最后一行为夹具 id（失败退出码非 0）
 *
 * 踩坑记录：删除旧夹具时直接 delete products 会撞外键 ——
 * 必须按依赖顺序先删 cart_items / product_images / product_skus / stock_movements / reviews / order_items。
 * （这与演示重置"漏删引用表导致崩溃"是同一个坑，所以这里显式列出全部依赖表。）
 */
import { db, now } from '../src/db.js'
import { syncProductStock, skusOf } from '../src/shop/schema.js'

const NAME = 'A11Y-双规格夹具'
const BASE = process.env.SHOP_BASE ?? 'http://127.0.0.1:8091'

// 找旧夹具并按依赖顺序清理
const olds = db.prepare('select id from products where name = ?').all(NAME).map((r) => r.id)
for (const id of olds) {
  db.prepare('delete from cart_items where product_id = ?').run(id)
  db.prepare('delete from product_images where product_id = ?').run(id)
  db.prepare('delete from product_skus where product_id = ?').run(id)
  db.prepare('delete from stock_movements where product_id = ?').run(id)
  db.prepare('delete from reviews where product_id = ?').run(id)
  db.prepare('delete from order_items where product_id = ?').run(id)
  db.prepare('delete from products where id = ?').run(id)
}

const pid = Number(db.prepare(`
  insert into products(sku, name, price_cents, stock, status, description, created_by, created_at, updated_by, updated_at)
  values ('A11Y2', ?, 10000, 20, 1, '无障碍验收夹具', 'audit', datetime('now'), 'audit', datetime('now'))
`).run(NAME).lastInsertRowid)

const ins = db.prepare(`
  insert into product_skus(product_id, spec, specs_json, sku_code, price_cents, stock, status, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
`)
ins.run(pid, '红色 / 单人', JSON.stringify({ 颜色: '红色', 尺寸: '单人' }), 'A11Y2-R1', 9900, 8)
ins.run(pid, '蓝色 / 双人', JSON.stringify({ 颜色: '蓝色', 尺寸: '双人' }), 'A11Y2-B2', 12900, 4)
const stock = syncProductStock(pid)
console.log(`  [夹具] id=${pid} 库内规格=${skusOf(pid).length} 商品级库存=${stock}`)

// 接口自检：夹具必须能被服务端读到，否则浏览器验证无意义
try {
  const res = await fetch(`${BASE}/api/shop/products/${pid}`)
  const data = await res.json()
  const apiSkus = data?.skus?.length ?? -1
  console.log(`  [接口] HTTP ${res.status} · skus=${apiSkus} · images=${data?.images?.length ?? 0}`)
  if (res.status !== 200 || apiSkus !== 2) {
    console.error('  [失败] 接口未返回 2 个规格 —— 夹具对服务端不可见，后续浏览器验证无意义')
    process.exit(1)
  }
  console.log(`  [就绪] FIXTURE_ID=${pid}`)
  console.log(String(pid))
  process.exit(0)
} catch (e) {
  console.error('  [失败] 接口自检异常: ' + e.message)
  process.exit(1)
}
