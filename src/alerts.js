/**
 * 告警规则与状态机
 *
 * 设计取舍：
 *  · 规则可配置（放数据库，界面能改），默认四条覆盖「错误率 / 延迟 / 内存 / QPS 突增」
 *  · 只在「状态发生变化」时产生事件（firing / resolved），避免每秒刷屏——这是监控系统的基本要求
 *  · 每次状态变化都写进 alerts 表，事后可追溯；同时通过 SSE 推给面板
 *  · 不引入任何依赖：阈值比较就是几行代码，没必要为此背一个告警框架
 */
import { db, now } from './db.js';

const MAX_HISTORY = 100;
const active = new Map();      // ruleId -> { since, peak, value }
const history = [];            // { ts, ruleId, name, state, value, threshold, unit }
let onChange = () => {};

db.exec(`
create table if not exists alert_rules (
  id         text primary key,
  name       text not null,
  metric     text not null,
  op         text not null default '>',
  threshold  real not null,
  unit       text not null default '',
  enabled    integer not null default 1,
  updated_at text
);
create table if not exists alerts (
  id          integer primary key autoincrement,
  rule_id     text not null,
  name        text not null,
  state       text not null,          -- firing | resolved
  value       real,
  threshold   real,
  unit        text,
  started_at  text,
  resolved_at text,
  created_at  text not null
);
create index if not exists idx_alerts_time on alerts(created_at desc);
`);

export const DEFAULT_RULES = [
  { id: 'error_rate', name: '错误率过高', metric: 'errorRate', op: '>', threshold: 5, unit: '%' },
  { id: 'p95_latency', name: 'P95 延迟过高', metric: 'p95', op: '>', threshold: 300, unit: 'ms' },
  { id: 'rss_memory', name: '内存占用过高', metric: 'rssMB', op: '>', threshold: 512, unit: 'MB' },
  { id: 'qps_spike', name: 'QPS 突增', metric: 'qps', op: '>', threshold: 200, unit: 'req/s' },
  { id: 'low_stock', name: '低库存商品', metric: 'lowStockCount', op: '>', threshold: 0, unit: '件' },
];

/** 首次启动写入默认规则 */
export function ensureAlertRules() {
  // 幂等补齐：像新增「低库存商品」这类规则，必须能补进已经跑起来的库
  // （踩过的坑：原来只在表为空时写入，导致新规则永远进不去）
  const exists = db.prepare('select id from alert_rules where id = ?');
  const ins = db.prepare('insert into alert_rules(id,name,metric,op,threshold,unit,enabled,updated_at) values (?,?,?,?,?,?,1,?)');
  for (const r of DEFAULT_RULES) {
    if (!exists.get(r.id)) ins.run(r.id, r.name, r.metric, r.op, r.threshold, r.unit, now());
  }
}

export function getRules() {
  return db.prepare('select * from alert_rules order by id').all();
}

export function setRule(id, patch) {
  const cur = db.prepare('select * from alert_rules where id = ?').get(id);
  if (!cur) return null;
  const threshold = patch.threshold === undefined ? cur.threshold : Number(patch.threshold);
  const enabled = patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0);
  if (!Number.isFinite(threshold)) return null;
  db.prepare('update alert_rules set threshold = ?, enabled = ?, updated_at = ? where id = ?').run(threshold, enabled, now(), id);
  // 规则改了，先清掉该规则的活跃状态，避免"改了阈值但还在报警"的错觉
  if (active.has(id)) { active.delete(id); }
  return db.prepare('select * from alert_rules where id = ?').get(id);
}

const readMetric = (snap, metric) => {
  if (metric === 'p95') return snap.latency?.p95 ?? 0;
  if (metric === 'lowStockCount') return snap.lowStockCount ?? 0;   // 业务指标：低库存商品数
  return snap[metric] ?? 0;
};

/** 每秒调用一次：比较阈值，处理状态迁移 */
export function evaluateAlerts(snap) {
  const rules = getRules();
  const events = [];
  for (const r of rules) {
    const value = readMetric(snap, r.metric);
    const breached = r.enabled ? compare(value, r.op, r.threshold) : false;
    const cur = active.get(r.id);

    if (breached && !cur) {
      active.set(r.id, { since: Date.now(), peak: value, value });
      events.push(record(r, 'firing', value));
    } else if (breached && cur) {
      cur.value = value;
      cur.peak = Math.max(cur.peak, value);
    } else if (!breached && cur) {
      active.delete(r.id);
      events.push(record(r, 'resolved', value));
    }
  }
  return events;
}

function compare(a, op, b) {
  switch (op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    default: return false;
  }
}

function record(rule, state, value) {
  const startedAt = active.get(rule.id)?.since;
  db.prepare(`insert into alerts(rule_id,name,state,value,threshold,unit,started_at,resolved_at,created_at)
              values (?,?,?,?,?,?,?,?,?)`)
    .run(rule.id, rule.name, state, Math.round(value * 10) / 10, rule.threshold, rule.unit,
      state === 'firing' ? now() : (startedAt ? new Date(startedAt).toISOString().replace('T', ' ').slice(0, 19) : null),
      state === 'resolved' ? now() : null, now());

  const ev = {
    ts: Date.now(), ruleId: rule.id, name: rule.name, state,
    value: Math.round(value * 10) / 10, threshold: rule.threshold, unit: rule.unit,
    durationSec: state === 'resolved' && startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
  };
  history.unshift(ev);
  if (history.length > MAX_HISTORY) history.pop();
  try { onChange(ev); } catch {}
  return ev;
}

export function activeAlerts() {
  const out = [];
  const rules = new Map(getRules().map((r) => [r.id, r]));
  for (const [id, st] of active) {
    const r = rules.get(id);
    out.push({
      ruleId: id, name: r?.name ?? id, metric: r?.metric, unit: r?.unit,
      threshold: r?.threshold, value: Math.round(st.value * 10) / 10, peak: Math.round(st.peak * 10) / 10,
      sinceSec: Math.round((Date.now() - st.since) / 1000),
    });
  }
  return out;
}

export function alertHistory(limit = 30) {
  return db.prepare('select * from alerts order by id desc limit ?').all(limit);
}

export const evaluateHistory = () => history.slice(0, 30);

/** 注册状态变化回调（服务端用来推 SSE + 写实时日志） */
export function onAlertChange(fn) { onChange = fn; }
