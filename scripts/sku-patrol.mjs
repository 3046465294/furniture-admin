/**
 * 规格数据巡检（独立于商城进程）
 *
 * 为什么需要它：
 *   演示数据每 10 分钟重置会清空 product_skus，而默认规格原本只在商城进程**启动时**生成。
 *   线上商城是旧进程（无法重启），所以自愈巡检没有生效 → 重置后商品全部变「暂无可售规格」，
 *   商城直接卖不出东西。
 *
 *   这个脚本由「用户级计划任务」每 2 分钟跑一次，独立于商城进程，
 *   保证任何时刻在售商品都有可售规格；同时把商品级库存与各规格之和重新对齐。
 *
 * 幂等且轻量：只在缺失时插入，正常情况下几乎不产生写操作。
 */
import { db } from '../src/db.js'
import { ensureSkus, syncProductStock } from '../src/shop/schema.js'

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

try {
  const r = ensureSkus()
  let fixed = 0
  const bad = db.prepare(`
    select p.id from products p
    where p.deleted = 0 and p.status = 1
      and p.stock <> (select coalesce(sum(s.stock), 0) from product_skus s where s.product_id = p.id and s.status = 1)
  `).all()
  for (const p of bad) { syncProductStock(p.id); fixed++ }

  const missing = db.prepare(`
    select count(*) c from products p
    where p.deleted = 0 and p.status = 1
      and not exists (select 1 from product_skus s where s.product_id = p.id and s.status = 1)
  `).get().c

  if (r.created || fixed || missing) {
    console.log(`[${stamp()}] sku-patrol: created=${r.created} stockSynced=${fixed} stillMissing=${missing}`)
  }
  // 仍然缺失说明有异常，明确报出来（而不是静默通过）
  if (missing > 0) { console.log(`[${stamp()}] sku-patrol: WARNING ${missing} on-sale products have no sellable sku`) }
  process.exit(0)
} catch (e) {
  console.error(`[${stamp()}] sku-patrol failed: ${e.message}`)
  process.exit(1)
}
