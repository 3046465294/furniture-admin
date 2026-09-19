/**
 * 场景化压测（零依赖）
 *
 * 与"打满 QPS"的裸压不同，这里模拟真实业务比例，并按 SLO 判定通过与否：
 *   浏览商品列表 50% · 查看详情 25% · 加入购物车 15% · 查看购物车 10%
 *   （不压结算/支付：那是有副作用的写操作，会污染演示数据；写链路另有功能验收覆盖）
 *
 * 阶梯加压：每档并发持续 N 秒，记录 P50/P95/P99、成功率、吞吐。
 * 门禁：最终档 P95 超过阈值或错误率超过阈值 → 退出码非 0（可直接接 CI）。
 * 产物：基线 JSON（写入 logs/loadtest-baseline.json），便于纵向对比。
 *
 * 用法：
 *   node scripts/loadtest-scenario.mjs [--base http://127.0.0.1:8085] [--user buyer01] [--pass Buyer@2026]
 *   node scripts/loadtest-scenario.mjs --levels 10,30,60 --seconds 8 --p95 300 --err 0.01
 */
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const BASE = arg('base', 'http://127.0.0.1:8085')
const USER = arg('user', 'buyer01')
const PASS = arg('pass', 'Buyer@2026')
const LEVELS = String(arg('levels', '5,20,50')).split(',').map((s) => Number(s.trim())).filter(Boolean)
const SECONDS = Number(arg('seconds', 6))
const P95_LIMIT = Number(arg('p95', 300))          // 毫秒
const ERR_LIMIT = Number(arg('err', 0.01))         // 1%
const OUT = arg('out', 'logs/loadtest-baseline.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowMs = () => Number(process.hrtime.bigint() / 1000000n)

let cookie = ''
const hdr = (json) => {
  const h = {}
  if (cookie) h.cookie = cookie
  if (json) { h['Content-Type'] = 'application/json'; h['X-Requested-With'] = 'fetch' }
  return h
}
const call = async (path, { method = 'GET', body, json } = {}) => {
  const t0 = nowMs()
  try {
    const res = await fetch(BASE + path, { method, headers: hdr(json ?? !!body), body: body ? JSON.stringify(body) : undefined })
    const sc = res.headers.getSetCookie?.() ?? []
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ')
    await res.text()
    return { ok: res.status < 400, status: res.status, ms: nowMs() - t0 }
  } catch (e) {
    return { ok: false, status: 0, ms: nowMs() - t0, err: e.message }
  }
}

const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))] }

const main = async () => {
  console.log('════════ AURUM 场景化压测 ════════')
  console.log(`  目标 ${BASE} · 用户 ${USER} · 阶梯 ${LEVELS.join('/')} 并发 · 每档 ${SECONDS}s`)
  console.log(`  门禁 P95 ≤ ${P95_LIMIT}ms · 错误率 ≤ ${(ERR_LIMIT * 100).toFixed(1)}%`)

  // 准备：登录 + 一份商品清单（供各场景抽用）
  const lg = await call('/api/shop/login', { method: 'POST', body: { username: USER, password: PASS } })
  console.log(`  登录: ${lg.ok ? '成功' : '失败 ' + lg.status}`)
  const listRes = await fetch(BASE + '/api/shop/products?size=12', { headers: cookie ? { cookie } : {} })
  const list = await listRes.json().catch(() => ({ rows: [] }))
  const ids = (list.rows ?? []).map((r) => r.id)
  if (!ids.length) { console.error('  ✗ 拿不到商品清单，终止'); process.exit(1) }
  console.log(`  商品样本: ${ids.length} 个`)

  const report = { base: BASE, at: new Date().toISOString(), levels: [], thresholds: { p95: P95_LIMIT, errRate: ERR_LIMIT } }
  let worst = { level: 0, p95: 0, errRate: 0, rps: 0 }

  for (const level of LEVELS) {
    const lat = []; let ok = 0, bad = 0, rejected = 0, n = 0
    const t0 = nowMs(); const deadline = t0 + SECONDS * 1000
    const byKind = { list: 0, detail: 0, addCart: 0, cart: 0 }

    const worker = async (wid) => {
      let i = 0
      while (nowMs() < deadline) {
        const pid = ids[(wid + i) % ids.length]
        const r = Math.random()
        let res
        if (r < 0.50) { res = await call('/api/shop/products?size=8&page=1'); byKind.list++ }
        else if (r < 0.75) { res = await call('/api/shop/products/' + pid); byKind.detail++ }
        else if (r < 0.90) { res = await call('/api/shop/cart', { method: 'POST', body: { productId: pid, qty: 1 } }); byKind.addCart++ }
        else { res = await call('/api/shop/cart'); byKind.cart++ }
        n++; lat.push(res.ms)
        if (res.status >= 500 || res.status === 0) bad++; else if (res.status >= 400) rejected++; else ok++
        i++
        await sleep(0)
      }
    }
    await Promise.all(Array.from({ length: level }, (_, i) => worker(i)))
    const dur = (nowMs() - t0) / 1000
    const rps = n / dur
    const errRate = n ? bad / n : 0            // 仅 5xx 与网络失败计入故障率
    const p = { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99) }
    report.levels.push({ level, seconds: Number(dur.toFixed(1)), requests: n, rps: Number(rps.toFixed(1)), ok, bad, rejected, rejectRate: Number((n ? rejected / n : 0).toFixed(4)), errRate: Number(errRate.toFixed(4)), ...p, mix: byKind })
    if (p.p95 > worst.p95) worst = { level, p95: p.p95, errRate, rps }
    console.log(`  并发 ${String(level).padStart(3)} │ 请求 ${String(n).padStart(6)} │ ${rps.toFixed(0).padStart(5)} req/s │ P50 ${String(p.p50).padStart(4)}ms P95 ${String(p.p95).padStart(4)}ms P99 ${String(p.p99).padStart(4)}ms │ 故障 ${(errRate * 100).toFixed(2)}% 拒绝 ${((n ? rejected / n : 0) * 100).toFixed(1)}%`)
  }

  // 门禁判定（以最高档为准）
  const last = report.levels[report.levels.length - 1]
  const passed = last.p95 <= P95_LIMIT && last.errRate <= ERR_LIMIT
  report.verdict = { passed, lastLevel: last.level, p95: last.p95, errRate: last.errRate, rps: last.rps }

  console.log('')
  console.log(`  最高档 并发 ${last.level}：P95 ${last.p95}ms（限 ${P95_LIMIT}）· 故障率 ${(last.errRate * 100).toFixed(2)}%（限 ${(ERR_LIMIT * 100).toFixed(1)}%）· 业务拒绝 ${(last.rejectRate * 100).toFixed(1)}%（不计入故障）· 吞吐 ${last.rps} req/s`)
  console.log(`  ${passed ? '✅ 通过 SLO 门禁' : '❌ 未达 SLO 门禁'}`)
  console.log(`  业务比例：${JSON.stringify(last.mix)}`)

  try {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(OUT.replace(/[\\/][^\\/]*$/, ''), { recursive: true })
    writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
    console.log(`  基线已写入 ${OUT}`)
  } catch (e) { console.error('  基线写入失败: ' + e.message) }

  process.exit(passed ? 0 : 1)
}
await main()
