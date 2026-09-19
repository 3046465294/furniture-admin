/**
 * 给数据巡检加入「类目层级恢复」
 *
 * 背景：演示重置会重建 categories，我新加的两级层级会被清掉（回到 6 个根、0 个子）。
 *       这已是第四类"重置后遗症"（前三个：规格缺失、悬空购物车行、商品图缺失），
 *       统一由每 2 分钟的数据巡检自愈。
 *
 * 为什么单独写这个补丁脚本：上一轮我把同样的改动写成 shell 内联 node，括号被 shell 吃掉导致失败。
 * 规矩：补丁脚本必须用 write 工具写在仓库内，走 shell 只会重复踩坑。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const F = 'C:/Users/winner/Desktop/furniture-admin/scripts/sku-patrol.mjs'
let t = readFileSync(F, 'utf8')
const log = []

if (t.includes('类目层级')) {
  log.push('巡检已包含类目层级恢复，无需改动')
} else {
  const anchor = '  // ④ 补齐商品图（重置会清空 product_images）'
  const block = [
    '  // ③.5 恢复类目层级（重置会重建 categories 并丢掉 parent_id —— 第四类重置后遗症）',
    '  let catFixed = 0',
    '  {',
    "    const catTotal = db.prepare('select count(*) c from categories').get().c",
    "    const withParent = db.prepare('select count(*) c from categories where parent_id is not null').get().c",
    '    if (catTotal > 1 && withParent === 0) {',
    "      let root = db.prepare(\"select id from categories where name = '家居'\").get()",
    '      if (!root) {',
    "        const r = db.prepare(\"insert into categories(name, sort, status, remark, parent_id, created_by, created_at, updated_by, updated_at) values ('家居',0,1,'根类目',null,'seed',?,'seed',?)\").run(now(), now())",
    '        root = { id: Number(r.lastInsertRowid) }',
    '      }',
    "      const kids = db.prepare('select id from categories where id <> ? and parent_id is null').all(root.id)",
    "      for (const k of kids) { db.prepare('update categories set parent_id = ?, updated_at = ? where id = ?').run(root.id, now(), k.id); catFixed++ }",
    '    }',
    '  }',
    '',
    anchor,
  ].join('\n')

  if (!t.includes(anchor)) {
    log.push('[警告] 未找到商品图步骤锚点，未改动')
  } else {
    t = t.replace(anchor, block)
    // 巡检原本只导入 db，恢复层级需要 now()
    t = t.replace("import { db } from '../src/db.js'", "import { db, now } from '../src/db.js'")
    // 有改动时输出，并在自检里带上类目
    t = t.replace(
      'const changed = r.created || purged || bad.length || img.addedRows || img.addedFiles',
      'const changed = r.created || purged || bad.length || img.addedRows || img.addedFiles || catFixed'
    )
    t = t.replace('imgFiles=${img.addedFiles}', 'imgFiles=${img.addedFiles} catFixed=${catFixed}')
    // 自检：类目层级不应只剩一层
    t = t.replace(
      "  const missingImg = db.prepare(`",
      "  const flatCats = db.prepare('select count(*) c from categories where parent_id is null').get().c\n  const allCats = db.prepare('select count(*) c from categories').get().c\n  const missingImg = db.prepare(`"
    )
    t = t.replace(
      '  if (missingSku > 0 || missingImg > 0) {',
      "  if (missingSku > 0 || missingImg > 0 || (allCats > 1 && flatCats === allCats)) {"
    )
    t = t.replace(
      "    console.error(`[${stamp()}] patrol: WARNING 仍有 ${missingSku} 个商品无可售规格、${missingImg} 个商品无图`)",
      "    console.error(`[${stamp()}] patrol: WARNING 仍有 ${missingSku} 个商品无可售规格、${missingImg} 个商品无图、类目层级 ${flatCats}/${allCats} 全为顶层`)"
    )
    writeFileSync(F, t, 'utf8')
    log.push('已把类目层级恢复插入巡检（含自检与输出）')
  }
}

console.log(log.map((x) => '   · ' + x).join('\n'))
