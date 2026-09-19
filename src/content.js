/**
 * 站点内容域 —— 项目案例 / 博客文章
 *
 * 定位变更：AURUM 从"家居电商后台"改为"个人站点运营后台"。
 *   保留：鉴权 / RBAC / 审计 / 告警 / 实时监控 / Prometheus（这些是真正值钱的基建）
 *   替换：业务域从"商品·分类·订单"换成"项目案例·博客文章"
 *   家具模块：仅从导航隐藏，代码与数据表保留（随时可回）
 *
 * 设计要点：
 *   · 双语字段（zh/en）与站点一致：title/title_en、summary/summary_en
 *   · slug 唯一，用于生成静态页 URL；写入前统一规整为 kebab-case
 *   · status: 1=已发布 0=草稿；博客另有 published_at（首次发布时写入）
 *   · 所有写操作带 CSRF 校验 + RBAC(write) + 审计留痕
 *   · 表由本模块 ensureContentTables() 幂等创建，并内置一批种子数据（与现有站点内容对应）
 */
import { db, now, audit } from './db.js'

export function ensureContentTables() {
  db.exec(`
    create table if not exists site_projects (
      id            integer primary key autoincrement,
      slug          text unique,
      title         text not null,
      title_en      text default '',
      summary       text default '',
      summary_en    text default '',
      tags          text default '',
      cover         text default '',
      body          text default '',
      sort          integer default 0,
      status        integer default 1,
      featured      integer default 0,
      created_by    text, created_at text, updated_by text, updated_at text
    );
    create table if not exists site_posts (
      id            integer primary key autoincrement,
      slug          text unique,
      title         text not null,
      title_en      text default '',
      summary       text default '',
      summary_en    text default '',
      tags          text default '',
      cover         text default '',
      body          text default '',
      status        integer default 0,
      published_at  text default '',
      created_by    text, created_at text, updated_by text, updated_at text
    );
    create index if not exists idx_projects_sort on site_projects(status, sort, id);
    create index if not exists idx_posts_status on site_posts(status, published_at, id);
  `)

  try { db.exec("alter table site_posts add column summary_en text default ''"); } catch { /* 已存在 */ }
  try { db.exec("alter table site_projects add column featured integer default 0"); } catch { /* 已存在 */ }

  // 种子：与现有站点内容对应（仅在空表时写入）
  const pc = db.prepare('select count(*) c from site_projects').get().c
  if (pc === 0) {
    const ins = db.prepare(`insert into site_projects(slug,title,title_en,summary,summary_en,tags,cover,body,sort,status,featured,created_by,created_at,updated_by,updated_at)
                            values (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`)
    ins.run('furniture-admin', 'AURUM 家居运营中台（零依赖 Node + 实时监控）',
      'AURUM home-furnishing ops console (zero-dependency Node + live monitoring)',
      '家具商品/分类/订单的运营后台：后端只用 Node 内置能力，零第三方依赖；带实时监控与 Prometheus 端点。',
      'A furniture catalogue, category and order console built only on Node built-ins with live monitoring.',
      'Node.js,SQLite,RBAC,监控', '/projects/furniture-admin/01-login.jpg', '', 10, 1, 'seed', now(), 'seed', now())
    ins.run('apk-analyzer', 'APK 分析器', 'APK analyzer',
      '安卓安装包静态分析：权限/组件/签名/风险点提取。', 'Static analysis of Android packages.',
      'Android,静态分析', '', '', 20, 1, 'seed', now(), 'seed', now())
    ins.run('ai-image-toolkit', 'AI 图片工具箱', 'AI image toolkit',
      '批量图片处理与生成的工作流工具。', 'Batch image processing workflows.',
      'AI,工具', '', '', 30, 1, 'seed', now(), 'seed', now())
    ins.run('mobile-app-customization', '移动应用定制', 'Mobile app customization',
      '面向客户的应用定制交付记录。', 'Client-facing app customization delivery.',
      '交付,定制', '', '', 40, 1, 'seed', now(), 'seed', now())
  }

  const bc = db.prepare('select count(*) c from site_posts').get().c
  if (bc === 0) {
    const ins = db.prepare(`insert into site_posts(slug,title,title_en,summary,tags,cover,body,status,published_at,created_by,created_at,updated_by,updated_at)
                            values (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    ins.run('zero-dependency-backend', '零依赖后端：只用 Node 内置能力做完整服务',
      'A zero-dependency backend with Node built-ins',
      '用 node:sqlite / node:crypto / node:http 做出带鉴权、限流、审计与监控的完整后端。',
      'Node.js,后端', '', '', 1, now(), 'seed', now(), 'seed', now())
    ins.run('ubuntu-docker-compose-deploy', 'Ubuntu + Docker Compose 部署实战',
      'Deploying with Ubuntu and Docker Compose',
      '从零把服务部署到云主机的完整过程与踩坑记录。',
      'Docker,部署', '', '', 1, now(), 'seed', now(), 'seed', now())
    ins.run('dex-checksum-forensics', 'DEX 校验和取证',
      'DEX checksum forensics',
      '安卓 DEX 文件被篡改后的校验和取证方法。',
      'Android,取证', '', '', 0, '', 'seed', now(), 'seed', now())
  }

  return {
    projects: db.prepare('select count(*) c from site_projects').get().c,
    posts: db.prepare('select count(*) c from site_posts').get().c,
  }
}

const kebab = (s) => String(s ?? '').trim().toLowerCase()
  .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

/**
 * 注册内容管理路由。app 由 server.js 注入（route/guard/json/csrfOk/clampInt/str），
 * 避免本模块依赖 server.js 的内部实现。
 */
export function registerContentRoutes(app) {
  const { route, guard, json, csrfOk, clampInt, str } = app

  const listOf = (table) => (q) => {
    const status = q.get('status')
    const kw = str(q.get('q'), 60)
    const where = ['1=1']
    const args = []
    if (status === '0' || status === '1') { where.push('status = ?'); args.push(Number(status)) }
    if (kw) { where.push('(title like ? or title_en like ? or summary like ?)'); args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`) }
    return db.prepare(`select * from ${table} where ${where.join(' and ')}
                       order by ${table === 'site_projects' ? 'sort asc, id asc' : 'coalesce(nullif(published_at,\'\'), created_at) desc, id desc'}`)
      .all(...args)
  }

  const writeBody = (table, body, id) => {
    const b = {
      slug: str(body.slug, 80) || null,
      title: str(body.title, 200),
      title_en: str(body.titleEn ?? body.title_en, 200),
      summary: str(body.summary, 600),
      summary_en: str(body.summaryEn ?? body.summary_en, 600),
      tags: str(body.tags, 200),
      cover: str(body.cover, 300),
      body: String(body.body ?? '').slice(0, 200000),
      status: body.status === 0 || body.status === '0' ? 0 : 1,
    }
    if (table === 'site_projects') b.sort = clampInt(body.sort, 0, 9999, 0)
    return b
  }

  for (const [seg, table] of [['projects', 'site_projects'], ['posts', 'site_posts']]) {
    // 列表
    route('GET', `/api/content/${seg}`, guard(async ({ res, url }) => {
      const rows = listOf(table)(url.searchParams)
      return json(res, 200, { rows, total: rows.length })
    }, 'read'))

    // 新建
    route('POST', `/api/content/${seg}`, guard(async ({ req, res, body, user, ip }) => {
      if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' })
      const b = writeBody(table, body)
      if (!b.title) return json(res, 400, { error: '标题必填' })
      b.slug = b.slug || kebab(b.title) || `${seg}-${Date.now().toString(36)}`
      if (db.prepare(`select id from ${table} where slug = ?`).get(b.slug)) return json(res, 409, { error: 'slug 已存在：' + b.slug })
      const cols = Object.keys(b)
      const r = table === 'site_projects'
        ? db.prepare(`insert into site_projects(${cols.join(',')},created_by,created_at,updated_by,updated_at)
                      values (${cols.map(() => '?').join(',')},?,?,?,?)`).run(...cols.map((c) => b[c]), user.username, now(), user.username, now())
        : db.prepare(`insert into site_posts(${cols.join(',')},published_at,created_by,created_at,updated_by,updated_at)
                      values (${cols.map(() => '?').join(',')},?,?,?,?,?)`).run(...cols.map((c) => b[c]), b.status ? now() : '', user.username, now(), user.username, now())
      audit(user.username, `${seg}_create`, `${seg}#${r.lastInsertRowid}`, b.title, ip)
      return json(res, 201, { id: Number(r.lastInsertRowid), slug: b.slug })
    }, 'write'))

    // 修改
    route('PUT', `/api/content/${seg}/:id`, guard(async ({ req, res, body, params, user, ip }) => {
      if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' })
      const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0)
      const cur = db.prepare(`select * from ${table} where id = ?`).get(id)
      if (!cur) return json(res, 404, { error: '内容不存在' })
      const b = writeBody(table, { ...cur, ...body }, id)
      b.slug = b.slug || cur.slug
      const dup = db.prepare(`select id from ${table} where slug = ? and id <> ?`).get(b.slug, id)
      if (dup) return json(res, 409, { error: 'slug 已被占用' })
      const sets = Object.keys(b).map((c) => `${c} = ?`)
      const args = Object.keys(b).map((c) => b[c])
      if (table === 'site_posts') {
        // 首次发布时写入 published_at
        const pub = cur.status === 0 && b.status === 1 && !cur.published_at ? now() : cur.published_at
        sets.push('published_at = ?'); args.push(pub)
      }
      db.prepare(`update ${table} set ${sets.join(', ')}, updated_by = ?, updated_at = ? where id = ?`)
        .run(...args, user.username, now(), id)
      audit(user.username, `${seg}_update`, `${seg}#${id}`, b.title + '（' + (b.status ? '发布' : '草稿') + '）', ip)
      return json(res, 200, { ok: true })
    }, 'write'))

    // 删除
    route('DELETE', `/api/content/${seg}/:id`, guard(async ({ req, res, params, user, ip }) => {
      if (!csrfOk(req)) return json(res, 400, { error: '缺少 X-Requested-With' })
      const id = clampInt(params.id, 1, Number.MAX_SAFE_INTEGER, 0)
      const cur = db.prepare(`select * from ${table} where id = ?`).get(id)
      if (!cur) return json(res, 404, { error: '内容不存在' })
      db.prepare(`delete from ${table} where id = ?`).run(id)
      audit(user.username, `${seg}_delete`, `${seg}#${id}`, cur.title, ip)
      return json(res, 200, { ok: true })
    }, 'write'))
  }

  // 概览统计（后台首页/侧栏角标用）
  route('GET', '/api/content/stats', guard(async ({ res }) => json(res, 200, {
    projects: db.prepare('select count(*) c from site_projects').get().c,
    projectsPublished: db.prepare('select count(*) c from site_projects where status = 1').get().c,
    posts: db.prepare('select count(*) c from site_posts').get().c,
    postsPublished: db.prepare('select count(*) c from site_posts where status = 1').get().c,
    postsDraft: db.prepare('select count(*) c from site_posts where status = 0').get().c,
  }), 'read'))
}
