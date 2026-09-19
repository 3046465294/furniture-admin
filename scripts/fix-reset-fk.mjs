import { readFileSync, writeFileSync } from 'node:fs'
const F = 'C:/Users/winner/Desktop/furniture-admin/src/seed-data.js'
let t = readFileSync(F, 'utf8')
if (t.includes('foreign_keys = OFF')) { console.log('   已有开关，跳过'); process.exit(0) }
const m = t.match(/  db\.exec\(`\s*\n?\s*delete from shipments;[\s\S]*?`\);/)
if (!m) { console.log('   ⚠ 未匹配到删除块'); process.exit(1) }
const block = m[0]
const wrapped = [
  '  // 重置是全量清业务数据，删除顺序再小心也可能漏（本文件已因漏表崩溃过两次）。',
  '  // 因此这里显式关闭外键检查完成删除，再打开并做一致性检查 —— 顺序不再是可靠性前提。',
  "  try { db.exec('PRAGMA foreign_keys = OFF'); } catch {}",
  block,
  "  try { db.exec('PRAGMA foreign_keys = ON'); } catch {}",
  '  const violations = db.prepare(\'pragma foreign_key_check\').all();',
  "  if (violations.length) console.warn('[reset] 外键一致性告警: ' + JSON.stringify(violations.slice(0, 3)));",
].join('\n')
t = t.replace(block, wrapped)
writeFileSync(F, t, 'utf8')
console.log('   ✅ 已为重置换上外键开关 + 一致性检查')
