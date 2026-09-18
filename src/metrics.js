/**
 * 实时指标 —— 内存环形缓冲 + SSE 广播 + Prometheus 文本输出。
 *
 * 这是这一版最值得现场演示的部分：每一次 HTTP 请求都会进这里，
 * 面板通过 /api/system/stream（SSE）每秒收到一次聚合结果，同时还能看到实时日志流。
 *
 * 采集口径（都写清楚，避免"看着像监控其实算错"）：
 *   · QPS        = 最近 10 秒窗口内的请求数 / 10
 *   · 错误率     = 最近 60 秒窗口内 4xx/5xx 占比
 *   · 延迟分位   = 最近 500 次请求耗时的 p50 / p95 / p99
 *   · 慢接口 Top = 最近 500 次里按「平均耗时 × 次数」排序
 */
import { performance } from 'node:perf_hooks';

const MAX_SAMPLES = 500;
const samples = [];              // { t, ms, status, method, path }
const counters = { total: 0, ok: 0, clientErr: 0, serverErr: 0 };
const recentLogs = [];           // { t, level, method, path, status, ms, actor, note }
const MAX_LOGS = 200;
const sseClients = new Set();
const startedAt = Date.now();

export function recordRequest({ method, path, status, ms, actor, note }) {
  const t = Date.now();
  samples.push({ t, ms, status, method, path });
  if (samples.length > MAX_SAMPLES) samples.shift();
  counters.total += 1;
  if (status >= 500) counters.serverErr += 1;
  else if (status >= 400) counters.clientErr += 1;
  else counters.ok += 1;

  pushLog({
    t, level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    method, path, status, ms: Math.round(ms * 10) / 10, actor: actor ?? '-', note: note ?? '',
  });
}

export function pushLog(entry) {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  broadcast({ type: 'log', entry });
}

function windowSamples(ms) {
  const from = Date.now() - ms;
  return samples.filter((s) => s.t >= from);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 当前指标快照 */
export function snapshot() {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const last10 = windowSamples(10_000);
  const last60 = windowSamples(60_000);
  const err60 = last60.filter((s) => s.status >= 400).length;

  // 慢接口 Top5
  const byPath = new Map();
  for (const s of samples) {
    const key = `${s.method} ${s.path}`;
    const cur = byPath.get(key) ?? { key, n: 0, sum: 0, max: 0 };
    cur.n += 1; cur.sum += s.ms; cur.max = Math.max(cur.max, s.ms);
    byPath.set(key, cur);
  }
  const slowest = [...byPath.values()]
    .map((v) => ({ path: v.key, count: v.n, avgMs: Math.round((v.sum / v.n) * 10) / 10, maxMs: Math.round(v.max * 10) / 10 }))
    .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
    .slice(0, 5);

  const mem = process.memoryUsage();

  return {
    ts: Date.now(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    qps: Math.round((last10.length / 10) * 10) / 10,
    rps60: last60.length,
    errorRate: last60.length ? Math.round((err60 / last60.length) * 1000) / 10 : 0,
    latency: {
      p50: Math.round(percentile(sorted, 50) * 10) / 10,
      p95: Math.round(percentile(sorted, 95) * 10) / 10,
      p99: Math.round(percentile(sorted, 99) * 10) / 10,
      max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    },
    counters: { ...counters },
    rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    heapMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    slowest,
    // 给前端画折线用的近 60 秒每秒请求数
    series: series60(),
  };
}

function series60() {
  const out = new Array(60).fill(0);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const s of samples) {
    const sec = Math.floor(s.t / 1000);
    const idx = 59 - (nowSec - sec);
    if (idx >= 0 && idx < 60) out[idx] += 1;
  }
  return out;
}

export function recentLogEntries(limit = 60) {
  return recentLogs.slice(-limit).reverse();
}

// ────────────────────────── SSE ──────────────────────────
export function addSseClient(res) {
  sseClients.add(res);
  res.write(`retry: 3000\n\n`);
  res.write(`event: metrics\ndata: ${JSON.stringify(snapshot())}\n\n`);
  return () => sseClients.delete(res);
}

export function broadcast(payload) {
  const chunk = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(chunk); } catch { sseClients.delete(res); }
  }
}

/** 每秒推送一次指标快照（enrich 用于补齐需要查库的字段：会话数、DB 体积、Node 版本等） */
export function startMetricsTicker(intervalMs = 1000, enrich = () => ({})) {
  const timer = setInterval(() => {
    if (!sseClients.size) return;
    let extra = {};
    try { extra = enrich(); } catch { extra = {}; }
    broadcast({ type: 'metrics', ...snapshot(), ...extra });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const sseClientCount = () => sseClients.size;

// ────────────────────────── Prometheus 文本格式 ──────────────────────────
export function prometheusText() {
  const s = snapshot();
  const lines = [
    '# HELP furniture_admin_requests_total 累计请求数',
    '# TYPE furniture_admin_requests_total counter',
    `furniture_admin_requests_total{result="ok"} ${s.counters.ok}`,
    `furniture_admin_requests_total{result="client_error"} ${s.counters.clientErr}`,
    `furniture_admin_requests_total{result="server_error"} ${s.counters.serverErr}`,
    '# HELP furniture_admin_qps 最近 10 秒的每秒请求数',
    '# TYPE furniture_admin_qps gauge',
    `furniture_admin_qps ${s.qps}`,
    '# HELP furniture_admin_error_rate_percent 最近 60 秒错误率',
    '# TYPE furniture_admin_error_rate_percent gauge',
    `furniture_admin_error_rate_percent ${s.errorRate}`,
    '# HELP furniture_admin_latency_ms 请求耗时分位数',
    '# TYPE furniture_admin_latency_ms gauge',
    `furniture_admin_latency_ms{quantile="0.5"} ${s.latency.p50}`,
    `furniture_admin_latency_ms{quantile="0.95"} ${s.latency.p95}`,
    `furniture_admin_latency_ms{quantile="0.99"} ${s.latency.p99}`,
    '# HELP furniture_admin_rss_bytes 进程常驻内存',
    '# TYPE furniture_admin_rss_bytes gauge',
    `furniture_admin_rss_bytes ${Math.round(s.rssMB * 1024 * 1024)}`,
    '# HELP furniture_admin_uptime_seconds 运行时长',
    '# TYPE furniture_admin_uptime_seconds counter',
    `furniture_admin_uptime_seconds ${s.uptimeSec}`,
  ];
  return lines.join('\n') + '\n';
}

/** 计时助手：包住一个 handler，自动记录耗时 */
export function timed(handler, meta = {}) {
  return async (ctx) => {
    const t0 = performance.now();
    let status = 200;
    try {
      const r = await handler(ctx);
      status = r?.status ?? 200;
      return r;
    } catch (err) {
      status = err?.status ?? 500;
      throw err;
    } finally {
      recordRequest({
        method: ctx.req.method,
        path: meta.path ?? ctx.path,
        status,
        ms: performance.now() - t0,
        actor: ctx.user?.username,
        note: meta.note,
      });
    }
  };
}
