/**
 * 模块 1（商品域：规格/SKU 矩阵）验收脚本
 * 用法：node scripts/accept-module1.mjs [base]
 * 全程用 Node 原生 fetch，不依赖外部工具与临时文件（Git Bash 的 /tmp 与 Windows 工具路径不一致，踩过坑）
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8091'
let cookie = ''
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? '   ' + extra : '')) }
const api = async (path, opts = {}) => {
  const headers = { ...(opts.headers ?? {}) }
  if (cookie) headers.cookie = cookie
  if (opts.body) { headers['Content-Type'] = 'application/json'; headers['X-Requested-With'] = 'fetch' }
  const res = await fetch(BASE + path, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const sc = res.headers.getSetCookie?.() ?? []
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ')
  const text = await res.text()
  let data = {}
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 120) } }
  return { status: res.status, data }
}

console.log('== 模块 1 验收：商品域（规格 / SKU / 商品图）==')
const health = await api('/api/shop/health')
ok('服务健康', health.status === 200, '商品 ' + health.data.products + ' 件')

// 找一个有多规格的商品
const list = await api('/api/shop/products?size=48')
let target = null
for (const p of list.data.rows) {
  const d = await api('/api/shop/products/' + p.id)
  if ((d.data.skus?.length ?? 0) > 1) { target = d.data; break }
}
if (!target) { console.log('  ❌ 没有找到多规格商品（先给商品配规格再跑本脚本）'); process.exit(1) }
const P = target.product
ok('详情接口返回规格列表', target.skus.length > 1, target.skus.length + ' 个规格')
ok('详情接口返回商品图', Array.isArray(target.images), (target.images?.length ?? 0) + ' 张')
ok('规格含结构化 specs（颜色/尺寸）', Object.keys(target.skus[0].specs ?? {}).length > 0, JSON.stringify(target.skus[0].specs))
ok('每个规格有独立价格与库存', target.skus.every((k) => k.priceCents > 0 && k.stock >= 0))
console.log('    商品：' + P.name + '  商品级库存 ' + P.stock + '（= 各规格之和 ' + target.skus.reduce((a, b) => a + b.stock, 0) + '）')
target.skus.forEach((k) => console.log('      · ' + k.spec + '  ¥' + k.price + '  库存 ' + k.stock + '  ' + k.skuCode))

const login = await api('/api/shop/login', { method: 'POST', body: { username: 'buyer01', password: 'Buyer@2026' } })
ok('顾客登录', login.status === 200)

const sku = target.skus[1]
const before = sku.stock
const add = await api('/api/shop/cart', { method: 'POST', body: { productId: P.id, skuId: sku.id, qty: 2 } })
ok('按指定规格加购', add.status === 200)
const line = add.data.items?.[0]
ok('购物车显示规格文本', line?.spec === sku.spec, '（' + (line?.spec ?? '') + '）')
ok('购物车按规格价计价', line?.price === sku.price, '¥' + (line?.price ?? 0))

const over = await api('/api/shop/cart', { method: 'POST', body: { productId: P.id, skuId: sku.id, qty: 999 } })
ok('超卖被拦截（409）', over.status === 409, over.data.error ?? '')

const addr = await api('/api/shop/addresses')
let addrId = addr.data.rows?.[0]?.id
if (!addrId) {
  const a = await api('/api/shop/addresses', { method: 'POST', body: { receiver: '演示顾客', phone: '13800001111', region: '浙江省杭州市西湖区', detail: '文一西路 100 号', isDefault: true } })
  addrId = a.data.id
}
const co = await api('/api/shop/checkout', { method: 'POST', body: { addressId: addrId, remark: '模块1验收' } })
ok('规格级下单', co.status === 201, co.data.orderNo ?? co.data.error)

const detail = await api('/api/shop/orders/' + co.data.orderNo)
ok('订单明细带规格', (detail.data.items?.[0]?.name ?? '').includes(sku.spec), detail.data.items?.[0]?.name ?? '')

const after = await api('/api/shop/products/' + P.id)
const skuAfter = after.data.skus.find((k) => k.id === sku.id)
ok('规格库存按下单扣减', skuAfter.stock === before - 2, before + ' → ' + skuAfter.stock)
ok('商品级库存同步（各规格之和）', after.data.product.stock === after.data.skus.reduce((a, b) => a + b.stock, 0), '商品级 ' + after.data.product.stock)

console.log('\n== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ==')
process.exit(fail ? 1 : 0)
