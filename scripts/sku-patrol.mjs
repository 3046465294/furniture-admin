/**
 * 规格与购物车数据巡检（由用户级计划任务每 2 分钟执行，独立于商城进程）
 *
 * 为什么需要它（两次真实故障的教训）：
 *   1) 演示数据每 10 分钟重置会清空 product_skus，而默认规格原本只在商城进程启动时生成
 *      → 重置后所有在售商品变「暂无可售规格」，商城卖不出东西
 *   2) 规格被清空后，cart_items 里会留下**指向已删规格的悬空 sku_id**，
 *      加上老表唯一键 (cart_id, product_id)，加购会直接 500
 *
 * 本脚本做三件事（全部幂等、开销极小）：
 *   ① 补齐缺失的默认规格
 *   ② 清理悬空 sku_id 的购物车行（购物车是临时数据，清理安全）
 *   ③ 把商品级库存与「各规格之和」重新对齐
 * 发现无法自愈的情况会明确报错，而不是静默通过。
 */
import { db } from '../src/db.js'
import { ensureSkus, syncProductStock } from '../src/shop/schema.js'

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

try {
  // ① 补齐默认规格
  const r = ensureSkus()

  // ② 清理悬空引用（放在补齐之后：先让规格存在，再删除确实无主的行）
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

  // 自检：在售商品必须都有可售规格
  const missing = db.prepare(`
    select count(*) c from products p
    where p.deleted = 0 and p.status = 1
      and not exists (select 1 from product_skus s where s.product_id = p.id and s.status = 1)
  `).get().c

  const changed = r.created || purged || bad.length
  if (changed || missing) {
    console.log(`[${stamp()}] sku-patrol: skusCreated=${r.created} cartRowsPurged=${purged} stockSynced=${bad.length} stillMissing=${missing}`)
  }
  if (missing > 0) {
    console.error(`[${stamp()}] sku-patrol: WARNING ${missing} on-sale products still have no sellable sku`)
    process.exit(2)
  }
  process.exit(0)
} catch (e) {
  console.error(`[${stamp()}] sku-patrol failed: ${e.message}`)
  process.exit(1)
}
