/**
 * 多级类目 · 第 2 步（接口层）
 *
 * 目标：后台 /api/categories 返回 parentId，让界面能表达层级。
 * 现状：映射用显式字段列表（第 176 行附近），且查询可能是显式列 —— 两处都要照顾。
 *
 * 做法：只做最小改动并打印上下文，便于人工核对；不做任何其它改动。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const F = 'C:/Users/winner/Desktop/furniture-admin/src/server.js'
let t = readFileSync(F, 'utf8')
const log = []

// ① 找到类目列表路由，打印其查询语句（判断是否需要补列）
const routeIdx = t.indexOf("'/api/categories'")
if (routeIdx < 0) { console.log('   [警告] 未找到类目路由'); process.exit(1) }
const segEnd = t.indexOf("route(", routeIdx + 20)
const seg = t.slice(routeIdx, segEnd > 0 ? segEnd : routeIdx + 2000)
const selectLine = (seg.match(/select[\s\S]{0,240}?from categories/i) ?? [''])[0].replace(/\s+/g, ' ').trim()
log.push('类目查询语句: ' + (selectLine || '（未匹配到，可能来自视图/函数）'))

// ② 若查询是显式列且未包含 parent_id，则补上
if (selectLine && /^select\s+(c\.)?id\b/i.test(selectLine) && !/parent_id/.test(selectLine)) {
  const fixed = selectLine.replace(/^select\s+/i, (m) => m + (selectLine.includes('c.id') ? 'c.parent_id, ' : 'parent_id, '))
  t = t.replace(selectLine.replace(/\s+/g, ' '), fixed)   // 注意：selectLine 已归一化空白，需用原文替换
  log.push('[需人工确认] 查询为显式列且缺 parent_id，已尝试补列')
} else if (/parent_id/.test(selectLine) || /\*/.test(selectLine)) {
  log.push('查询已包含 parent_id（显式或 *），无需改查询 ✅')
}

// ③ 映射处补 parentId
const mapOld = '    productCount: r.product_count, createdBy: r.created_by, createdAt: r.created_at,'
if (t.includes(mapOld)) {
  t = t.replace(mapOld, '    parentId: r.parent_id ?? null, productCount: r.product_count, createdBy: r.created_by, createdAt: r.created_at,')
  log.push('已在映射中加入 parentId ✅')
} else if (t.includes('parentId: r.parent_id')) {
  log.push('映射已包含 parentId')
} else {
  log.push('[警告] 未匹配到映射行，未改动')
}

writeFileSync(F, t, 'utf8')

// ④ 打印改动后的类目路由片段，便于核对
const idx2 = t.indexOf("'/api/categories'")
console.log(log.map((x) => '   · ' + x).join('\n'))
console.log('   改动后片段:')
console.log(t.slice(idx2, idx2 + 900).split('\n').slice(0, 22).map((l) => '     ' + l).join('\n'))
