/**
 * 生成商品图资源（SVG 占位图）—— 幂等，可被巡检脚本重复调用
 *
 * 说明与取舍：
 *   · 真实电商的商品图是运营上传的实拍图；这里是作品演示，没有实拍图可用
 *   · 所以生成"明确标注为示意"的 SVG 占位图（渐变 + 商品名 + 视图序号），
 *     而不是拿网图冒充实拍 —— 不伪造素材是底线
 *   · 覆盖**所有在售商品**（每件 3 张），使演示重置清空 product_images 后能被巡检恢复
 */
import { db, now } from '../src/db.js'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

const DIR = 'C:/Users/winner/Desktop/furniture-admin/public/img/'
mkdirSync(DIR, { recursive: true })

const PALETTES = [
  ['#f4f4f4', '#e8e8e8', '#111111'],
  ['#f7f6f3', '#ecebe7', '#111111'],
  ['#f2f4f6', '#e6eaee', '#111111'],
  ['#f5f3f7', '#eae6ef', '#111111'],
]

/** 一张"示意商品图"：渐变底 + 首字 + 商品名 + 视图序号（明确标注非实拍） */
function svg(name, cat, idx, total) {
  const [c1, c2, acc] = PALETTES[idx % PALETTES.length]
  const safe = (s) => String(s ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]))
  const initial = safe(String(name || '?').trim().slice(0, 1))
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
  <text x="400" y="470" text-anchor="middle" font-family="system-ui,'PingFang SC','Microsoft YaHei'" font-size="40" fill="#111111" opacity="0.92">${safe(name)}</text>
  <text x="400" y="530" text-anchor="middle" font-family="system-ui,'PingFang SC','Microsoft YaHei'" font-size="26" fill="#555555" opacity="0.9">${safe(cat ?? '家居')} · 视图 ${idx + 1}/${total} · 示意图（非实拍）</text>
  <text x="400" y="740" text-anchor="middle" font-family="system-ui" font-size="22" fill="#999999" opacity="0.9">AURUM 家居商城 · 演示素材</text>
</svg>
`
}

/** 为所有在售商品补齐 3 张图（幂等） */
export function ensureProductImages() {
  const products = db.prepare(`
    select p.id, p.name, c.name as cat from products p
    left join categories c on c.id = p.category_id
    where p.deleted = 0 and p.status = 1
    order by p.id
  `).all()

  let addedRows = 0, addedFiles = 0
  for (const p of products) {
    let imgs = db.prepare('select url, sort from product_images where product_id = ? order by sort').all(p.id)
    if (imgs.length === 0) {
      for (let i = 1; i <= 3; i++) {
        const url = `/img/p${p.id}-${i}.svg`
        db.prepare('insert into product_images(product_id, url, sort, is_primary, created_at) values (?,?,?,?,?)')
          .run(p.id, url, i, i === 1 ? 1 : 0, now())
        addedRows++
      }
      imgs = db.prepare('select url, sort from product_images where product_id = ? order by sort').all(p.id)
    }
    imgs.forEach((im, i) => {
      const file = DIR + String(im.url).split('/').pop()
      if (!existsSync(file)) { writeFileSync(file, svg(p.name, p.cat, i, imgs.length), 'utf8'); addedFiles++ }
    })
  }
  return { products: products.length, addedRows, addedFiles }
}

// 直接执行时打印结果（被巡检脚本 import 时也会执行，幂等安全）
const r = ensureProductImages()
console.log(`  ✅ 商品图巡检：覆盖 ${r.products} 个在售商品 · 新增记录 ${r.addedRows} 条 · 新增文件 ${r.addedFiles} 个`)
