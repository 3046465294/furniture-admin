import { db } from '../src/db.js'
db.exec('begin')
try {
  const cleared = db.prepare('delete from cart_items').run().changes
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
  db.exec('commit')
  console.log('   ✅ cart_items 已重建（清空临时行 ' + cleared + ' 条）')
} catch (e) { db.exec('rollback'); console.log('   ❌ 失败: ' + e.message) }
const fks = db.prepare('pragma foreign_key_list(cart_items)').all().map((f) => f.table + '.' + f.to).join(', ')
console.log('   外键现指向: ' + fks)
const bad = db.prepare('pragma foreign_key_check').all()
console.log('   一致性检查: ' + (bad.length ? '仍有 ' + bad.length + ' 处违规' : '全部通过 ✅'))
