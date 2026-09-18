/**
 * 数据层 —— Node 内置 SQLite（node:sqlite），零第三方依赖。
 *
 * 设计沿用上一版（RuoYi 项目）的约定，便于对照：
 *   · 每张业务表都带审计字段 created_by / created_at / updated_by / updated_at
 *   · 一律软删除（deleted 标记），不物理删数据
 *   · 状态位用整数枚举，和原先的 status char(1) 等价
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');
const DB_FILE = process.env.DB_FILE ?? join(DATA_DIR, 'furniture.db');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);

db.exec('pragma journal_mode = WAL');
db.exec('pragma foreign_keys = ON');
db.exec('pragma busy_timeout = 5000');

db.exec(`
create table if not exists users (
  id            integer primary key autoincrement,
  username      text    not null unique,
  display_name  text    not null default '',
  password_hash text    not null,
  role          text    not null default 'viewer',   -- admin | operator | viewer
  active        integer not null default 1,
  failed_count  integer not null default 0,
  locked_until  integer not null default 0,           -- epoch ms
  last_login_at text,
  created_at    text    not null
);

create table if not exists sessions (
  id         text primary key,                        -- 随机 id（Cookie 里放的是它的 HMAC，不直接放 id）
  user_id    integer not null references users(id),
  created_at integer not null,
  expires_at integer not null,
  ip         text,
  user_agent text,
  revoked    integer not null default 0
);

create table if not exists categories (
  id         integer primary key autoincrement,
  name       text not null,
  sort       integer not null default 0,
  status     integer not null default 1,              -- 1 启用 / 0 停用
  remark     text default '',
  created_by text, created_at text,
  updated_by text, updated_at text,
  deleted    integer not null default 0
);

create table if not exists products (
  id          integer primary key autoincrement,
  sku         text not null,
  name        text not null,
  category_id integer references categories(id),
  price_cents integer not null default 0,             -- 以「分」存储，避免浮点误差
  stock       integer not null default 0,
  status      integer not null default 1,             -- 1 上架 / 0 下架
  description text default '',
  created_by  text, created_at text,
  updated_by  text, updated_at text,
  deleted     integer not null default 0
);
create index if not exists idx_products_cat on products(category_id);

create table if not exists orders (
  id           integer primary key autoincrement,
  order_no     text not null,
  customer     text not null,
  phone        text default '',
  total_cents  integer not null default 0,
  item_count   integer not null default 0,
  status       text not null default 'pending',       -- pending|paid|shipped|done|cancelled
  remark       text default '',
  created_by   text, created_at text,
  updated_by   text, updated_at text,
  deleted      integer not null default 0
);

create table if not exists audit_log (
  id         integer primary key autoincrement,
  actor      text,
  action     text not null,
  target     text,
  detail     text,
  ip         text,
  created_at text not null
);
create index if not exists idx_audit_time on audit_log(created_at desc);
`);

/** 统一的时间戳（本地时间，便于和上一版的 create_time 对照） */
export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** 写审计日志（所有写操作都会调用，监控面板也能看到） */
export function audit(actor, action, target, detail, ip) {
  db.prepare('insert into audit_log(actor,action,target,detail,ip,created_at) values (?,?,?,?,?,?)')
    .run(actor ?? 'system', action, target ?? '', detail ?? '', ip ?? '', now());
}

/** 统计各表行数（监控面板用） */
export function tableCounts() {
  const out = {};
  for (const t of ['users', 'sessions', 'categories', 'products', 'orders', 'audit_log']) {
    out[t] = db.prepare(`select count(*) as c from ${t}`).get().c;
  }
  return out;
}

/** 数据库文件体积（KB） */
export function dbSizeKB() {
  try {
    return Math.round(statSync(DB_FILE).size / 1024);
  } catch {
    return 0;
  }
}

export { DB_FILE };
