/**
 * 修复游客购物车（第三版）
 *  ① cartOfGuest 插入改用真实存在的列
 *  ② 迁移 carts 表：真实结构是 user_id NOT NULL UNIQUE，与"游客车"根本冲突
 *     → 新建 user_id 可空 + guest_key 唯一 的表并搬迁
 *
 * 注：本脚本位于仓库内（scripts/），相对导入 ../src/db.js 才能正确解析。
 *     （上两次失败的根因就是把脚本放 /tmp，导入路径解析到 AppData\Local\src\db.js）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { db } from '../src/db.js'

const A = 'C:/Users/winner/Desktop/furniture-admin/'
const log = []

// ① 代码修复
{
  const F = A + 'src/shop/schema.js'
  let t = readFileSync(F, 'utf8')
  const variants = [
    "    const r = db.prepare('insert into carts(user_id, guest_key, created_at) values (null, ?, ?)').run(guestKey, now());",
    "    const r = db.prepare('insert into carts(user_id, guest_key, created_at, updated_at) values (null, ?, ?, ?)').run(guestKey, now(), now());",
  ]
  const target = "    const r = db.prepare('insert into carts(guest_key, updated_at) values (?, ?)').run(guestKey, now());"
  let done = false
  for (const v of variants) if (t.includes(v)) { t = t.replace(v, target); done = true; break }
  if (!done && t.includes(target)) done = true
  if (done) { writeFileSync(F, t, 'utf8'); log.push('cartOfGuest 插入列已修正为 (guest_key, updated_at)') }
  else log.push('[警告] cartOfGuest 插入语句锚点未命中')
}

// ② 迁移 carts
{
  const before = db.prepare("select sql from sqlite_master where name='carts'").get()?.sql?.replace(/\s+/g, ' ') ?? ''
  const need = /user_id integer not null/i.test(before)
  if (!need) {
    log.push('carts 表无需迁移（user_id 已可空）')
  } else {
    db.exec('begin')
    try {
      const cleared = db.prepare('delete from cart_items').run().changes
      db.exec(`create table carts_new (
        id integer primary key autoincrement,
        user_id integer unique references users(id),
        guest_key text unique,
        updated_at text
      )`)
      db.exec('insert into carts_new(id, user_id, guest_key, updated_at) select id, user_id, guest_key, updated_at from carts')
      db.exec('drop table carts')
      db.exec('alter table carts_new rename to carts')
      db.exec('commit')
      log.push('carts 已迁移（清空临时购物车行 ' + cleared + ' 条）')
    } catch (e) {
      db.exec('rollback')
      log.push('迁移失败: ' + e.message)
    }
  }
  log.push('新结构: ' + (db.prepare("select sql from sqlite_master where name='carts'").get()?.sql?.replace(/\s+/g, ' ') ?? ''))
}

console.log(log.map((x) => '   · ' + x).join('\n'))
