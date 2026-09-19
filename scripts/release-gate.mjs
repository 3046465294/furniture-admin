/**
 * 一键发布门禁（release gate）
 *
 * 用法：node scripts/release-gate.mjs [--fast]
 *
 * 判定逻辑（全绿才允许发布）：
 *   1) 服务可达性    —— 后台 / 商城 / 网关 三个入口必须健康
 *   2) 模块验收      —— 各模块的验收脚本（目前：商品域 SKU 矩阵）
 *   3) 安全审计      —— HIGH 必须为 0
 *   4) 性能冒烟      —— 经网关打一轮短压测，错误率必须为 0、P95 不超过阈值
 *
 * 为什么要有它：把"能不能发布"从人的记忆变成一条命令。
 * 任何一项红 → 退出码非 0 → CI 或人工都不该继续发布。
 */
import { spawnSync } from 'node:child_process'

const FAST = process.argv.includes('--fast')
const NODE = process.execPath
const CWD = 'C:/Users/winner/Desktop/furniture-admin'
const results = []
const run = (name, cmd, args, opts = {}) => {
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { cwd: CWD, encoding: 'utf8', env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 32 * 1024 * 1024 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const code = r.status ?? 1
  results.push({ name, code, ms: Date.now() - t0, tail: out.trim().split('\n').slice(-4).join('\n') })
  console.log(`\n${code === 0 ? '[OK]  ' : '[FAIL]'} ${name}   (${Math.round((Date.now() - t0) / 100) / 10}s)`)
  if (code !== 0) console.log(out.trim().split('\n').slice(-14).map((l) => '      ' + l).join('\n'))
  return code === 0
}

console.log('════════ AURUM 发布门禁 ════════')

// 1) 服务可达性
const health = async () => {
  const targets = [
    ['后台', 'http://127.0.0.1:8090/api/system/health'],
    ['商城', 'http://127.0.0.1:8091/api/shop/health'],
    ['网关', 'http://127.0.0.1:8085/api/shop/health'],
  ]
  let ok = true
  for (const [name, url] of targets) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
      const good = r.status < 500
      console.log(`  [${good ? 'OK' : 'FAIL'}] 服务可达 ${name}  HTTP ${r.status}`)
      if (!good) ok = false
    } catch (e) {
      console.log(`  [FAIL] 服务可达 ${name}  ${e.message}`)
      ok = false
    }
  }
  results.push({ name: '服务可达性', code: ok ? 0 : 1 })
  return ok
}

const main = async () => {
  const h = await health()
  const a = run('模块验收：商品域（规格/SKU）', NODE, ['scripts/accept-module1.mjs'])
  const s = run('安全审计（HIGH 必须为 0）', NODE, ['scripts/security-audit.mjs'], { env: { FA_ADMIN_PWD: process.env.FA_ADMIN_PWD ?? '' } })
  let p = true
  if (!FAST) {
    p = run('性能冒烟（经网关 10 并发 5 秒）', NODE, ['scripts/loadtest.js', '--base', 'http://127.0.0.1:8085',
      '--concurrency', '10', '--duration', '5', '--pass', process.env.FA_ADMIN_PWD ?? '',
      '--paths', '/api/shop/products?size=5,/api/shop/categories,/api/shop/health'])
  }
  const all = h && a && s && p
  console.log('\n════════ 门禁结论 ════════')
  for (const r of results) console.log(`  ${r.code === 0 ? '[OK]  ' : '[FAIL]'} ${r.name}`)
  console.log(`\n  ${all ? '✅ 全绿 —— 允许发布' : '❌ 存在未通过项 —— 禁止发布'}`)
  process.exit(all ? 0 : 1)
}
await main()
