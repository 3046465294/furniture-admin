/**
 * 生成商品图资源（SVG 占位图）
 *
 * 说明与取舍：
 *   · 真实电商的商品图是运营上传的实拍图；这里是作品演示，没有实拍图可用
 *   · 所以生成"明确标注为示意"的 SVG 占位图（渐变 + 商品名 + 视图序号），
 *     而不是拿网图冒充实拍 —— 不伪造素材是底线
 *   · 同时给若干商品补多图夹具，用于验证详情页图画廊
 */
import { db, now } from '../src/db.js'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

const DIR = 'C:/Users/winner/Desktop/furniture-admin/public/img/'
mkdirSync(DIR, { recursive: true })

const PALETTES = [
  ['#2a2116', '#6d5326', '#f7cd7c'],
  ['#1e2420', '#31584a', '#9fe8cf'],
  ['#241d28', '#5b3a6b', '#e0b8ff'],
  ['#1d232b', '#33506b', '#a8d4ff'],
]

/** 一张"示意商品图"：渐变底 + 品类标签 + 商品名 + 视图序号 */
function svg(name, cat, idx, total) {
  const [c1, c2, acc] = PALETTES[idx % PALETTES.length]
  const safe = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]))
  const initial = safe(String(name).trim().slice(0, 1))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800" role="img" aria-label="${safe(name)} 示意图 ${idx + 1}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="0.55" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/>
    </linearGradient>
    <linearGradient id="sh" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.12"/>
    </linearGradient>
  </defs>
  <rect width="800" height="800" fill="url(#g)"/>
  <rect width="800" height="800" fill="url(#sh)"/>
  <text x="400" y="360" text-anchor="middle" font-family="system-ui,'PingFang SC','Microsoft YaHei'" font-size="260" font-weight="700" fill="${acc}" opacity="0.92">${initial}</text>
  <text x="400" y="470" text-anchor="middle" font-family="system-ui,'PingFang SC','Microsoft YaHei'" font-size="40" fill="#ffffff" opacity="0.92">${safe(name)}</text>
  <text x="400" y="530" text-anchor="middle" font-family="system-ui,'PingFang SC','Microsoft YaHei'" font-size="26" fill="#ffffff" opacity="0.6">${safe(cat ?? '家居')} · 视图 ${idx + 1}/${total} · 示意图（非实拍）</text>
  <text x="400" y="740" text-anchor="middle" font-family="system-ui" font-size="22" fill="#ffffff" opacity="0.38">AURUM 家居商城 · 演示素材</text>
</svg>
`
}

// ① 为已有 product_images 行生成文件
let made = 0
const rows = db.prepare(`
  select pi.url, pi.sort, p.name, c.name as cat
  from product_images pi join products p on p.id = pi.product_id
  left join categories c on c.id = p.category_id
  order by pi.product_id, pi.sort`).all()
const byProduct = new Map()
for (const r of rows) {
  const list = byProduct.get(r.url.replace(/-\d+\.svg$/, '')) ?? []
  list.push(r); byProduct.set(r.url.replace(/-\d+\.svg$/, ''), list)
}
for (const [, list] of byProduct) {
  list.forEach((r, i) => {
    const file = DIR + r.url.split('/').pop()
    if (!existsSync(file)) { writeFileSync(file, svg(r.name, r.cat, i, list.length), 'utf8'); made++ }
  })
}

// ② 给前 4 个商品补多图夹具（每件 3 张），用于验证图画廊
let fixture = 0
const products = db.prepare('select p.id, p.name, c.name as cat from products p left join categories c on c.id = p.category_id where p.deleted = 0 order by p.id desc limit 4').all()
for (const p of products) {
  const has = db.prepare('select count(*) c from product_images where product_id = ?').get(p.id).c
  if (has > 0) {
    // 已有记录：按记录生成文件
    const imgs = db.prepare('select url, sort from product_images where product_id = ? order by sort').all(p.id)
    imgs.forEach((im, i) => {
      const file = DIR + im.url.split('/').pop()
      if (!existsSync(file)) { writeFileSync(file, svg(p.name, p.cat, i, imgs.length), 'utf8'); made++ }
    })
    continue
  }
  for (let i = 1; i <= 3; i++) {
    const url = `/img/p${p.id}-${i}.svg`
    db.prepare('insert into product_images(product_id, url, sort, is_primary, created_at) values (?,?,?,?,?)')
      .run(p.id, url, i, i === 1 ? 1 : 0, now())
    writeFileSync(DIR + url.split('/').pop(), svg(p.name, p.cat, i - 1, 3), 'utf8')
    fixture++
  }
}

console.log('  ✅ 生成/补齐商品图 ' + (made + fixture) + ' 张（已有记录 ' + made + ' + 新夹具 ' + fixture + '）')
console.log('  ✅ 图片目录: ' + DIR)
const total = db.prepare('select count(*) c from product_images').get().c
console.log('  ✅ 全库商品图记录: ' + total + ' 条，覆盖商品 ' + db.prepare('select count(distinct product_id) c from product_images').get().c + ' 个')
