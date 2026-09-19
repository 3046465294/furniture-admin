/**
 * 多级类目树 · 第 1 步（数据模型）
 *
 * 为什么要分步：多级类目会同时影响数据模型、接口、后台界面、前台筛选与商品归属校验，
 * 一次全改风险太大（本项目已多次因此踩坑）。所以按"数据模型 → 接口 → 界面 → 前台"分步推进，
 * 每步都可独立验证。
 *
 * 本步只做两件低风险的事：
 *   ① categories 增加 parent_id（幂等 ALTER）
 *   ② 若当前是单层结构，则建立两级示例层级（家具 → 沙发/床类/餐桌椅/衣柜/储物/户外）
 *
 * 不做：不改任何既有查询、不动前端、不动商品归属（避免影响正在运行的服务）。
 */
import { db, now } from '../src/db.js'

const log = []

// ① 幂等加列
try { db.exec('alter table categories add column parent_id integer references categories(id)'); log.push('已新增列 categories.parent_id') }
catch { log.push('categories.parent_id 已存在') }
try { db.exec('create index if not exists idx_categories_parent on categories(parent_id)'); log.push('已建索引 idx_categories_parent') }
catch (e) { log.push('索引创建失败: ' + e.message) }

// ② 建立两级层级（仅当目前全是顶层时）
const total = db.prepare('select count(*) c from categories').get().c
const withParent = db.prepare('select count(*) c from categories where parent_id is not null').get().c
if (total > 0 && withParent === 0) {
  // 顶层：家居（把现有类目挂到它下面）
  const rootName = '家居'
  let root = db.prepare('select id from categories where name = ?').get(rootName)
  if (!root) {
    const r = db.prepare('insert into categories(name, sort, status, remark, parent_id, created_by, created_at, updated_by, updated_at) values (?,?,1,?,null,?,?,?,?)')
      .run(rootName, 0, '根类目', 'seed', now(), 'seed', now())
    root = { id: Number(r.lastInsertRowid) }
    log.push('已建立根类目「' + rootName + '」')
  }
  const kids = db.prepare('select id, name from categories where id <> ? and parent_id is null order by sort, id').all(root.id)
  for (const k of kids) {
    db.prepare('update categories set parent_id = ?, updated_at = ? where id = ?').run(root.id, now(), k.id)
  }
  log.push('已将 ' + kids.length + ' 个类目挂到根类目下：' + kids.map((k) => k.name).join('、'))
} else {
  log.push('已有层级结构（parent_id 非空 ' + withParent + ' 个），跳过建树')
}

// ③ 自检：打印当前树
const all = db.prepare('select id, name, parent_id, sort from categories order by coalesce(parent_id, 0), sort, id').all()
log.push('当前类目结构（' + all.length + ' 条）：')
for (const c of all) log.push('   ' + (c.parent_id ? '└─ ' : '· ') + c.name + ' (id=' + c.id + (c.parent_id ? ', parent=' + c.parent_id : '') + ')')

console.log(log.map((x) => '   ' + x).join('\n'))
