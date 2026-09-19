import { db } from '../src/db.js'
// 购物车是临时数据：直接清空再重建，彻底避开悬空 sku_id 的外键问题
const cleared = db.prepare('delete from cart_items').run().changes
db.exec('begin')
try {
  db.exec(`create table cart_items_new (
    id integer primary key autoincrement,
    cart_id integer not null references carts(id),
    product_id integer not null references products(id),
    sku_id integer references product_skus(id),
    qty integer not null default 1,
    added_at text,
    unique(cart_id, sku_id)
  )`)
  db.exec('drop table cart_items')
  db.exec('alter table cart_items_new rename to cart_items')
  db.exec('create index if not exists idx_cart_items_cart on cart_items(cart_id)')
  db.exec('commit')
  console.log('  ✅ cart_items 已重建：唯一键 (cart_id, sku_id)（清空 ' + cleared + ' 条临时数据）')
} catch (e) { db.exec('rollback'); console.log('  ❌ 重建失败: ' + e.message); process.exit(1) }
const sql = db.prepare("select sql from sqlite_master where name='cart_items'").get().sql.replace(/\s+/g, ' ')
console.log('  新定义: ' + sql.slice(0, 190))
