/**
 * 数据巡检（由用户级计划任务每 2 分钟执行，独立于商城进程）
 *
 * 为什么需要它（三次真实故障的教训）：
 *   1) 演示重置清空 product_skus → 所有在售商品变「暂无可售规格」，商城卖不出东西
 *   2) 规格被清空后购物车留下悬空 sku_id + 老唯一键 (cart_id, product_id) → 加购 500
 *   3) 重置还会清空 product_images → 详情页图画廊消失
 *
 * 本脚本把三类"重置后遗症"一次性恢复（全部幂等、开销极小）：
 *   ① 补齐缺失的默认规格
 *   ② 清理悬空 sku_id 的购物车行（购物车是临时数据，清理安全）
 *   ③ 对齐商品级库存与「各规格之和」
 *   ④ 补齐商品图（记录 + SVG 文件）
 * 若在售商品仍无可售规格，明确报错退出（不静默通过）。
 */
import { db } from '../src/db.js'
import { ensureSkus, syncProductStock } from '../src/shop/schema.js'
import { ensureProductImages } from './make-product-images.mjs'

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

try {
  // ① 补齐默认规格
  const r = ensureSkus()

  // ② 清理悬空引用（先让规格存在，再删除确实无主的行）
  const purged = db.prepare(`
    delete from cart_items
    where sku_id is not null and not exists (select 1 from product_skus s where s.id = cart_items.sku_id)
  `).run().changes

  // ③ 对齐商品级库存
  const bad = db.prepare(`
    select p.id from products p
    where p.deleted = 0 and p.status = 1
      and p.stock <> (select coalesce(sum(s.stock), 0) from product_skus s where s.product_id = p.id and s.status = 1)
  `).all()
  for (const p of bad) syncProductStock(p.id)

  // ④ 补齐商品图（重置会清空 product_images）
  const img = ensureProductImages()

  // 自检：在售商品必须都有可售规格与商品图
  const missingSku = db.prepare(`
    select count(*) c from products p
    where p.deleted = 0 and p.status = 1
      and not exists (select 1 from product_skus s where s.product_id = p.id and s.status = 1)
  `).get().c
  const missingImg = db.prepare(`
    select count(*) c from products p
    where p.deleted = 0 and p.status = 1
      and not exists (select 1 from product_images i where i.product_id = p.id)
  `).get().c

  const changed = r.created || purged || bad.length || img.addedRows || img.addedFiles
  if (changed || missingSku || missingImg) {
    console.log(`[${stamp()}] patrol: skusCreated=${r.created} cartPurged=${purged} stockSynced=${bad.length} imgRows=${img.addedRows} imgFiles=${img.addedFiles} missingSku=${missingSku} missingImg=${missingImg}`)
  }
  if (missingSku > 0 || missingImg > 0) {
    console.error(`[${stamp()}] patrol: WARNING 仍有 ${missingSku} 个商品无可售规格、${missingImg} 个商品无图`)
    process.exit(2)
  }
  process.exit(0)
} catch (e) {
  console.error(`[${stamp()}] patrol failed: ${e.message}`)
  process.exit(1)
}
