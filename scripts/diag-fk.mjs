import { db } from '../src/db.js'
console.log('  cart_items 的外键指向:')
for (const f of db.prepare('pragma foreign_key_list(cart_items)').all()) {
  console.log('    → ' + f.table + '.' + f.to + '  (列 ' + f.from + ')')
}
console.log('  carts 是否存在: ' + !!db.prepare("select 1 from sqlite_master where name='carts'").get())
const bad = db.prepare('pragma foreign_key_check').all()
console.log('  外键一致性检查: ' + (bad.length ? '发现 ' + bad.length + ' 处违规 → ' + JSON.stringify(bad.slice(0,3)) : '全部通过 ✅'))
