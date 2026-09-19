/**
 * 把内容域接入 server.js
 * 先核对辅助函数与请求参数名，再插入注册调用 —— 不猜。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const F = 'C:/Users/winner/Desktop/furniture-admin/src/server.js'
let t = readFileSync(F, 'utf8')
const log = []

// ① 核对辅助函数是否存在（名字/签名）
for (const name of ['route', 'guard', 'json', 'csrfOk', 'clampInt', 'str', 'int', 'customerOf']) {
  const re = new RegExp(`(function|const)\\s+${name}\\b`)
  log.push(`${name}: ${re.test(t) ? '存在 ✅' : '未找到 ❌'}`)
}

// ② 核对 GET 列表类路由怎么拿查询参数
const m = t.match(/route\('GET', '\/api\/(orders|products|users)'[\s\S]{0,220}/)
log.push('列表类路由样例:\n' + (m ? m[0].split('\n').slice(0, 6).map((l) => '     ' + l.trim()).join('\n') : '     （未匹配）'))

// ③ 找到"服务启动"锚点，把注册放在它之前
const anchors = ['// 启动', 'server.listen(', 'listen(', '启动自检']
let anchor = anchors.find((a) => t.includes(a))
log.push('启动锚点: ' + (anchor ?? '未找到'))

// ④ 插入 import（若无）
if (!t.includes("from './content.js'")) {
  const firstImport = t.match(/^import .*$/m)
  if (firstImport) {
    t = t.replace(firstImport[0], firstImport[0] + "\nimport { ensureContentTables, registerContentRoutes } from './content.js'")
    log.push('已插入 content.js 的 import ✅')
  } else log.push('[警告] 未找到 import 语句')
}

// ⑤ 插入注册调用（放在启动锚点之前）
if (!t.includes('registerContentRoutes({')) {
  const idx = anchor ? t.indexOf(anchor) : -1
  if (idx > 0) {
    const call = [
      '// ── 站点内容域（项目案例 / 博客文章）：表初始化 + 路由注册 ──',
      'const contentCounts = ensureContentTables();',
      "registerContentRoutes({ route, guard, json, csrfOk, clampInt, str });",
      "console.log(`  内容域：项目 ${contentCounts.projects} · 文章 ${contentCounts.posts}`);",
      '',
    ].join('\n')
    t = t.slice(0, idx) + call + t.slice(idx)
    log.push('已在启动前注册内容路由 ✅')
  } else log.push('[警告] 无启动锚点，未插入注册调用')
}

writeFileSync(F, t, 'utf8')
console.log(log.map((x) => '   · ' + x).join('\n'))
