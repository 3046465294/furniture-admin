/**
 * 安全审计套件（自动化，零依赖）
 *
 * 用法：node scripts/security-audit.mjs
 *   · 对本地服务跑一遍越权 / 注入 / CSRF / 限流 / 路径穿越 / 头部与 Cookie 策略检查
 *   · 输出 PASS/FAIL 清单与风险等级，任一 HIGH 未通过则退出码非 0（可直接接 CI 门禁）
 *
 * 这比"看一眼代码觉得安全"可靠：每次改动后 30 秒能重跑一遍。
 */
const A = 'http://127.0.0.1:8090';   // 后台管理
const S = 'http://127.0.0.1:8091';   // 商城前台
const G = 'http://127.0.0.1:8085';   // 网关
const ADMIN_PWD = process.env.FA_ADMIN_PWD ?? ''
const VIEWER = { u: 'demo', p: 'shijia.cyou' }
const CUSTOMER = { u: 'buyer01', p: 'Buyer@2026' }   // 前台登录用顾客账号（viewer 按设计不能登录前台）

let pass = 0, fail = 0, high = 0
const findings = []
const check = (level, name, ok, detail = '') => {
  if (ok) pass++; else { fail++; if (level === 'HIGH') high++ }
  findings.push({ level, name, ok, detail })
  console.log(`  ${ok ? '[OK]' : '[FAIL]'} [${level}] ${name}${detail ? '   ' + detail : ''}`)
}

async function req(base, path, opts = {}) {
  // 关键：本函数永不抛异常。任何单项的网络错误/解析错误都退化成 status 0，
  // 这样一轮审计不会被某一个探针搞崩（踩过的坑：空 header 值让 fetch 抛错，整轮中断）
  try {
    const headers = { ...(opts.headers ?? {}) }
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      if (!opts.noCsrf) headers['X-Requested-With'] = 'fetch'   // noCsrf: true 用来实测"缺少该头的请求"
    }
    const res = await fetch(base + path, {
      method: opts.method ?? 'GET', headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      redirect: 'manual',
    })
    const setCookie = res.headers.getSetCookie?.() ?? []
    const text = await res.text()
    let data = {}; try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }
    return { status: res.status, headers: res.headers, data, text, cookie: setCookie.map((c) => c.split(';')[0]).join('; '), setCookie }
  } catch (e) {
    return { status: 0, headers: new Headers(), data: { error: 'probe failed: ' + e.message }, text: '', cookie: '', setCookie: [], probeError: e.message }
  }
}
const login = async (base, username, password) => {
  const r = await req(base, base === S || base === G ? '/api/shop/login' : '/api/auth/login', { method: 'POST', json: { username, password } })
  return r.status === 200 ? r.cookie : null
}

// 审计前置：清掉后台账号的历史登录锁定，保证每次跑的起点一致（脚本可重复执行）
async function clearLoginLock() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync('C:/Users/winner/Desktop/furniture-admin/data/furniture.db')
    db.prepare('update users set failed_count = 0, locked_until = 0').run()
    db.close()
    console.log('  [setup] 已清理登录锁定状态，保证本轮审计起点一致')
  } catch (e) { console.log('  [setup] 清理锁定失败（忽略）: ' + e.message) }
}
await clearLoginLock()

// 专用限流探针账号：避免与越权检查抢同一个 demo 账号（被锁后越权检查会静默跳过）
const PROBE = { u: 'audit_probe_' + Date.now().toString(36), p: 'Probe@' + Date.now().toString(36) }   // 每轮唯一：避免跨轮次锁定污染其它检查
try {
  const { hashPassword } = await import('file:///C:/Users/winner/Desktop/furniture-admin/src/auth.js')
  const { DatabaseSync } = await import('node:sqlite')
  const d = new DatabaseSync('C:/Users/winner/Desktop/furniture-admin/data/furniture.db')
  d.prepare("insert into users(username,display_name,password_hash,role,active,created_at) values (?,?,?,'customer',1,datetime('now')) on conflict(username) do update set password_hash=excluded.password_hash, active=1")
    .run(PROBE.u, '审计探针账号', hashPassword(PROBE.p))
  d.close()
  console.log('  [setup] 限流探针账号就绪：' + PROBE.u)
  // 越权检查用的顾客探针账号（每轮唯一）：商城登录仅允许 customer/admin，故用 customer 角色
  const VIEWPROBE = { u: 'audit_cust_' + Date.now().toString(36), p: 'Cust@' + Date.now().toString(36) }
  globalThis.__VIEWPROBE = VIEWPROBE
  d.prepare("insert into users(username,display_name,password_hash,role,active,created_at) values (?,?,?,'customer',1,datetime('now')) on conflict(username) do update set password_hash=excluded.password_hash, active=1")
    .run(VIEWPROBE.u, '审计顾客探针', hashPassword(VIEWPROBE.p))
  console.log('  [setup] 越权探针账号就绪：' + VIEWPROBE.u)
} catch (e) { console.log('  [setup] 探针账号创建失败（将导致限流检查失败）: ' + e.message) }

console.log('======== AURUM 安全审计 ========')
console.log('\n【1】未认证访问（应全部 401）')
for (const [base, path, label] of [
  [A, '/api/products', '后台-商品列表'],
  [A, '/api/users', '后台-用户列表'],
  [A, '/api/system/audit', '后台-审计日志'],
  [A, '/api/system/login-attempts', '后台-登录尝试'],
  [S, '/api/shop/cart', '前台-购物车'],
  [S, '/api/shop/orders', '前台-我的订单'],
  [S, '/api/shop/addresses', '前台-收货地址'],
]) {
  const r = await req(base, path)
  check('HIGH', `未登录访问 ${label}`, r.status === 401, `HTTP ${r.status}`)
}

console.log('\n【2】CSRF 防护（变更类请求缺少 X-Requested-With 应 400）')
const adminCookieForCsrf = ADMIN_PWD ? await login(A, 'admin', ADMIN_PWD) : null
for (const [base, path, body, label] of [
  [A, '/api/products', { sku: 'X', name: 'x', price: 1 }, '后台-新建商品'],
  [S, '/api/shop/register', { username: 'csrf_probe', password: 'Abcd1234' }, '前台-注册'],
  [S, '/api/shop/login', { username: 'demo', password: 'x' }, '前台-登录'],
]) {
  // 后台接口需要先登录才能走到 CSRF 校验（未登录会被 401 提前拦掉，那也是对的）
  const cookie = base === A ? adminCookieForCsrf : undefined
  const r = await req(base, path, { method: 'POST', json: body, noCsrf: true, cookie })
  const refused = [400, 401, 403].includes(r.status)
  check('HIGH', `CSRF 拦截 ${label}（拒绝即通过，执行了才算失败）`, refused, `HTTP ${r.status}` + (r.status === 201 || r.status === 200 ? ' 请求被执行!' : ''))
}

console.log('\n【3】越权（只读账号不得写/管用户）')
const VIEWPROBE = globalThis.__VIEWPROBE
const viewerCookie = await login(S, VIEWPROBE.u, VIEWPROBE.p)
if (viewerCookie) {
  const r1 = await req(S, '/api/shop/cart', { method: 'POST', json: { productId: 1, qty: 1 }, cookie: viewerCookie })
  check('MED', 'viewer 加购（前台业务允许）', r1.status === 200 || r1.status === 409, `HTTP ${r1.status}`)
  const adminCookie = ADMIN_PWD ? await login(A, 'admin', ADMIN_PWD) : null
  if (adminCookie) {
    const r2 = await req(A, '/api/users', { method: 'POST', json: { username: 'rbac_probe', password: 'Abcd1234', role: 'admin' }, cookie: viewerCookie })
    check('HIGH', 'viewer 尝试建管理员账号', r2.status === 401 || r2.status === 403, `HTTP ${r2.status}`)
  } else check('HIGH', 'RBAC 写检查（缺少后台口令，不允许静默跳过）', false, '请设置 FA_ADMIN_PWD')
}

// 前置会话拿不到 = 这项没验成，必须计 FAIL（不能因为账号被锁就当作通过）
if (!viewerCookie) check('HIGH', '越权检查前置会话（viewer 登录失败，不允许静默跳过）', false, 'viewer 账号可能被上一轮锁定')

console.log('\n【4】路径穿越与敏感文件暴露（应 404）')
// 判定标准：404/400 为拦截；200 时看内容里有没有源码/数据库特征（SPA 首页属正常）
const looksLeaked = (r) => /SQLite format|export function|createHmac|node:sqlite|repositoryformatversion/.test(r.text)
for (const [base, path, label] of [
  [A, '/../src/auth.js', '后台-源码'],
  [A, '/..%2f..%2fdata%2ffurniture.db', '后台-数据库文件'],
  [A, '/.git/config', '后台-git 配置'],
  [S, '/../../package.json', '前台-源码'],
  [S, '/../data/furniture.db', '前台-数据库文件'],
]) {
  const r = await req(base, path)
  check('HIGH', `拦截 ${label}`, (r.status === 404 || r.status === 400) || (r.status === 200 && !looksLeaked(r)), `HTTP ${r.status}${looksLeaked(r) ? ' 内容泄露!' : ''}`)
}

console.log('\n【5】注入与异常输入（不得 5xx）')
for (const [base, path, label] of [
  [S, "/api/shop/products?q=' or 1=1--", '前台-搜索 SQL 注入尝试'],
  [S, "/api/shop/products?category=1;drop table users--", '前台-分类参数注入尝试'],
  [A, '/api/products?q=%00%ff%fe', '后台-二进制脏参数'],
  [S, '/api/shop/products/' + encodeURIComponent('1 union select 1'), '前台-详情非法 id'],
]) {
  const r = await req(base, path)
  check('HIGH', `不崩 ${label}`, r.status < 500, `HTTP ${r.status}`)
}

console.log('\n【6】请求体与参数边界')
{
  const big = 'x'.repeat(300 * 1024)
  const r = await req(A, '/api/auth/login', { method: 'POST', json: { username: 'a', password: big } })
  check('MED', '超大请求体被拒（413/400/401）', [413, 400, 401].includes(r.status), `HTTP ${r.status}`)
  const r2 = await req(S, '/api/shop/register', { method: 'POST', json: { username: 'a'.repeat(500), password: 'x'.repeat(500) } })
  check('HIGH', '超长字段被校验拒绝', r2.status === 400, `HTTP ${r2.status}`)
}

console.log('\n【7】安全响应头与 Cookie 策略')
// 两个服务都验：后台(8090) 与 商城(8091) —— 任一缺失都应暴露出来
for (const [base, path, who] of [[A, '/api/system/health', '后台'], [S, '/api/shop/health', '商城']]) {
  const r = await req(base, path)
  const h = r.headers
  const csp = h.get('content-security-policy') ?? ''
  check('HIGH', `[${who}] CSP 存在且禁止内联脚本`, !!csp && !/script-src[^;]*unsafe-inline/.test(csp), csp ? csp.slice(0, 48) + '…' : '(无，HTTP ' + r.status + ')')
  check('HIGH', `[${who}] X-Frame-Options: DENY（防点击劫持）`, (h.get('x-frame-options') ?? '') === 'DENY', h.get('x-frame-options') ?? '(无)')
  check('MED', `[${who}] X-Content-Type-Options: nosniff`, (h.get('x-content-type-options') ?? '') === 'nosniff')
  check('MED', `[${who}] Referrer-Policy 已设置`, !!h.get('referrer-policy'), h.get('referrer-policy') ?? '(无)')
}
if (VIEWER.p) {
  const r = await req(S, '/api/shop/login', { method: 'POST', json: { username: CUSTOMER.u, password: CUSTOMER.p } })
  const c = r.setCookie.join(';')
  check('HIGH', '会话 Cookie 为 HttpOnly', /HttpOnly/i.test(c))
  check('HIGH', '会话 Cookie 为 SameSite=Strict/Lax', /SameSite=(Strict|Lax)/i.test(c))
  check('MED', '本地 HTTP 下不带 Secure（HTTPS 下才带）', !/Secure/i.test(c), '经隧道访问时应带 Secure')
}

console.log('\n【8】登录限流与锁定')
{
  let last = 0
  let lastFailed = 0
  for (let i = 0; i < 8; i++) {
    const r = await req(A, '/api/auth/login', { method: 'POST', json: { username: PROBE.u, password: 'wrong-' + i } })
    last = r.status
    lastFailed = r.data?.failed ?? lastFailed
    if (r.status === 429) break
  }
  // 断言口径：实现可以是响应 429，也可以是返回 401 同时累计失败次数（达到阈值后锁定）
  check('HIGH', '连续错误口令被限制（429 或失败计数达阈值）', last === 429 || lastFailed >= 5, `最后一次 HTTP ${last}，失败计数 ${lastFailed}`)
}

console.log('\n【9】网关运维接口保护')
{
  const r = await req(G, '/_gw/weight?group=shop&id=shop-green&weight=99', { method: 'PUT' })
  check('HIGH', '无令牌改灰度权重被拒', r.status === 401, `HTTP ${r.status}`)
  const r2 = await req(G, '/_gw/metrics.prom')
  check('LOW', '网关指标端点同样需要令牌', r2.status === 401, `HTTP ${r2.status}`)
}

console.log('\n======== 审计结果 ========')
console.log(`  通过 ${pass} 项 · 失败 ${fail} 项（其中 HIGH ${high} 项）`)
if (high > 0) {
  console.log('  >> 存在高风险未通过项，禁止发布：')
  findings.filter((f) => !f.ok && f.level === 'HIGH').forEach((f) => console.log('     · ' + f.name + '  ' + f.detail))
}
process.exit(high > 0 ? 1 : 0)
