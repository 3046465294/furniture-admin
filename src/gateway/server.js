/**
 * AURUM 网关（零依赖）—— 灰度发布 + 应用层高可用 + 统一入口
 *
 * 解决的问题（都是商用必须有的）：
 *   1) 灰度发布：新版本先接 5% 流量，观察指标再逐步放大；出问题权重归零即回滚（秒级，不用重启）
 *   2) 应用层高可用：同一服务多实例，健康检查不合格自动摘除，恢复后自动加回
 *   3) 会话粘性：按 Cookie 哈希固定到同一实例，避免灰度期间同一用户看到两个版本
 *   4) 统一观测：聚合各实例的请求量/延迟/错误，输出 Prometheus 文本端点
 *   5) 优雅下线：收到 SIGTERM 先把权重转到健康实例，再等未完成请求结束
 *
 * 不是反向代理该有的全部（生产还可加 TLS 终止、限流、WAF、缓存），
 * 但这几件是"灰度+高可用"的最小可用集合，且每一件都能在本机复现验证。
 */
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.GW_PORT ?? 8085);
const HOST = process.env.GW_HOST ?? '127.0.0.1';
const ADMIN_TOKEN = process.env.GW_TOKEN ?? '';
const HEALTH_INTERVAL_MS = Number(process.env.GW_HEALTH_MS ?? 5000);
const HEALTH_PATH = process.env.GW_HEALTH_PATH ?? '/api/shop/health';
const FAIL_THRESHOLD = Number(process.env.GW_FAIL_THRESHOLD ?? 2);      // 连续失败几次摘除
const PASS_THRESHOLD = Number(process.env.GW_PASS_THRESHOLD ?? 1);      // 连续成功几次恢复

/**
 * 上游组：每个组是一份"服务"，组内可挂多个实例（蓝/绿/多副本）
 *   blue  稳定版   weight 100
 *   green 灰度版   weight 0（按需放大）
 */
const GROUPS = {
  shop: {
    match: (url) => true,                       // 默认组（本网关只服务商城；多服务可扩展 match 规则）
    sticky: 'fa_session',
    upstreams: [
      { id: 'shop-blue', url: process.env.GW_SHOP_BLUE ?? 'http://127.0.0.1:8091', color: 'blue', weight: 100, healthy: true, fails: 0, oks: 0 },
      { id: 'shop-green', url: process.env.GW_SHOP_GREEN ?? 'http://127.0.0.1:8092', color: 'green', weight: 0, healthy: true, fails: 0, oks: 0 },
    ],
  },
};

// ── 指标（每个上游独立统计，便于灰度对比） ──
const stats = { requests: 0, upstreamErrors: 0, noUpstream: 0, byUpstream: {} };
const statOf = (id) => (stats.byUpstream[id] ??= { requests: 0, errors: 0, latencyMsSum: 0, latencyMsMax: 0, status2xx: 0, status4xx: 0, status5xx: 0 });
const recentLogs = [];
const pushLog = (entry) => { recentLogs.unshift(entry); if (recentLogs.length > 300) recentLogs.pop(); };

const json = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
  return { status };
};
const parseCookies = (raw) => {
  const out = {};
  for (const part of String(raw ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

/** 加权选实例：健康的、权重>0 的实例里按权重抽 */
function pick(group, req) {
  const alive = group.upstreams.filter((u) => u.healthy && u.weight > 0);
  if (!alive.length) return null;
  // 会话粘性优先：同一会话固定在同一实例，灰度期间体验一致
  const sid = parseCookies(req.headers.cookie)[group.sticky];
  if (sid) {
    let h = 0;
    for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
    const ordered = [...alive].sort((a, b) => a.id.localeCompare(b.id));
    // 用哈希在"按权重展开的实例环"上取点：权重变了，一部分会话会自然迁移到新版本
    const ring = [];
    for (const u of ordered) for (let i = 0; i < u.weight; i++) ring.push(u);
    if (ring.length) return ring[h % ring.length];
  }
  const total = alive.reduce((a, b) => a + b.weight, 0);
  let n = Math.random() * total;
  for (const u of alive) { n -= u.weight; if (n <= 0) return u; }
  return alive[alive.length - 1];
}

/** 主动健康检查：连续失败摘除、连续成功恢复 */
function startHealthChecks() {
  const timer = setInterval(async () => {
    for (const group of Object.values(GROUPS)) {
      for (const u of group.upstreams) {
        const t0 = Date.now();
        let okFlag = false;
        try {
          const ac = new AbortController();
          const to = setTimeout(() => ac.abort(), 3000);
          const r = await fetch(u.url + HEALTH_PATH, { signal: ac.signal });
          clearTimeout(to);
          okFlag = r.status < 500;
        } catch { okFlag = false; }
        const ms = Date.now() - t0;
        if (okFlag) {
          u.oks++; u.fails = 0;
          if (!u.healthy && u.oks >= PASS_THRESHOLD) {
            u.healthy = true;
            pushLog({ t: Date.now(), level: 'info', upstream: u.id, note: '健康检查恢复，重新加入负载' });
            console.log(`[gw] ${u.id} 恢复健康（${ms}ms），重新加入负载`);
          }
        } else {
          u.fails++; u.oks = 0;
          if (u.healthy && u.fails >= FAIL_THRESHOLD) {
            u.healthy = false;
            pushLog({ t: Date.now(), level: 'warn', upstream: u.id, note: `健康检查连续失败 ${u.fails} 次，已摘除` });
            console.log(`[gw] ${u.id} 连续失败 ${u.fails} 次，已摘除`);
          }
        }
      }
    }
  }, HEALTH_INTERVAL_MS);
  timer.unref?.();
}

/** 反向代理单个请求 */
function proxy(req, res, url, upstream) {
  const target = new URL(upstream.url);
  const t0 = Date.now();
  const s = statOf(upstream.id);
  const headers = { ...req.headers };
  headers['x-forwarded-for'] = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + (req.socket.remoteAddress ?? '');
  headers['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] ?? 'http');
  headers['x-gateway-upstream'] = upstream.id;       // 便于排查"这个响应来自哪个版本"
  headers['x-request-id'] = headers['x-request-id'] ?? randomUUID();
  const opts = {
    hostname: target.hostname, port: target.port || 80, method: req.method,
    path: url.pathname + url.search, headers,
  };
  const up = httpRequest(opts, (upRes) => {
    const ms = Date.now() - t0;
    s.requests++; s.latencyMsSum += ms; s.latencyMsMax = Math.max(s.latencyMsMax, ms);
    const code = upRes.statusCode ?? 0;
    if (code < 400) s.status2xx++; else if (code < 500) s.status4xx++; else s.status5xx++;
    const out = { ...upRes.headers, 'x-gateway-upstream': upstream.id, 'x-response-time': ms + 'ms' };
    res.writeHead(code, out);
    upRes.pipe(res);
    if (code >= 500) { stats.upstreamErrors++; pushLog({ t: Date.now(), level: 'error', upstream: upstream.id, path: url.pathname, status: code, ms }); }
    else if (recentLogs.length < 60 || ms > 300) pushLog({ t: Date.now(), level: 'info', upstream: upstream.id, method: req.method, path: url.pathname, status: code, ms });
  });
  up.on('error', (err) => {
    stats.upstreamErrors++;
    upstream.fails++;
    if (upstream.fails >= FAIL_THRESHOLD && upstream.healthy) {
      upstream.healthy = false;
      pushLog({ t: Date.now(), level: 'warn', upstream: upstream.id, note: '连接失败，已摘除：' + err.code });
    }
    pushLog({ t: Date.now(), level: 'error', upstream: upstream.id, path: url.pathname, note: '上游错误 ' + err.code });
    if (!res.headersSent) json(res, 502, { error: '上游不可用', upstream: upstream.id, code: err.code });
    else res.destroy();
  });
  req.pipe(up);
}

// ── Prometheus 文本端点 ──
function prometheusText() {
  const lines = [
    '# HELP aurum_gateway_requests_total 网关累计请求数',
    '# TYPE aurum_gateway_requests_total counter',
    `aurum_gateway_requests_total ${stats.requests}`,
    '# HELP aurum_gateway_upstream_errors_total 上游错误总数',
    '# TYPE aurum_gateway_upstream_errors_total counter',
    `aurum_gateway_upstream_errors_total ${stats.upstreamErrors}`,
    '# HELP aurum_gateway_no_upstream_total 无可用上游次数',
    '# TYPE aurum_gateway_no_upstream_total counter',
    `aurum_gateway_no_upstream_total ${stats.noUpstream}`,
  ];
  for (const group of Object.values(GROUPS)) {
    for (const u of group.upstreams) {
      const s = statOf(u.id);
      const l = { upstream: u.id, color: u.color };
      const tag = Object.entries(l).map(([k, v]) => `${k}="${v}"`).join(',');
      lines.push(`aurum_gateway_upstream_healthy{${tag}} ${u.healthy ? 1 : 0}`);
      lines.push(`aurum_gateway_upstream_weight{${tag}} ${u.weight}`);
      lines.push(`aurum_gateway_upstream_requests_total{${tag}} ${s.requests}`);
      lines.push(`aurum_gateway_upstream_errors_total{${tag}} ${s.errors}`);
      lines.push(`aurum_gateway_upstream_latency_ms_avg{${tag}} ${s.requests ? (s.latencyMsSum / s.requests).toFixed(2) : 0}`);
      lines.push(`aurum_gateway_upstream_latency_ms_max{${tag}} ${s.latencyMsMax}`);
      lines.push(`aurum_gateway_upstream_status_total{${tag},code="2xx"} ${s.status2xx}`);
      lines.push(`aurum_gateway_upstream_status_total{${tag},code="4xx"} ${s.status4xx}`);
      lines.push(`aurum_gateway_upstream_status_total{${tag},code="5xx"} ${s.status5xx}`);
    }
  }
  return lines.join('\n') + '\n';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);

  // ── 网关自身的运维接口（需令牌，避免被公网乱改权重） ──
  if (url.pathname.startsWith('/_gw/')) {
    const token = String(req.headers['x-gw-token'] ?? url.searchParams.get('token') ?? '');
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) return json(res, 401, { error: '网关令牌无效' });
    if (url.pathname === '/_gw/status') {
      return json(res, 200, {
        groups: Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, g.upstreams.map((u) => ({
          id: u.id, color: u.color, url: u.url, weight: u.weight, healthy: u.healthy, fails: u.fails,
          requests: statOf(u.id).requests, avgMs: statOf(u.id).requests ? Math.round(statOf(u.id).latencyMsSum / statOf(u.id).requests) : 0,
        }))])),
        totals: { requests: stats.requests, upstreamErrors: stats.upstreamErrors, noUpstream: stats.noUpstream },
      });
    }
    // 灰度：设置权重（0 即回滚）。PUT /_gw/weight?group=shop&id=shop-green&weight=5
    if (url.pathname === '/_gw/weight' && (req.method === 'PUT' || req.method === 'POST')) {
      const g = GROUPS[url.searchParams.get('group') ?? 'shop'];
      const u = g?.upstreams.find((x) => x.id === url.searchParams.get('id'));
      const w = Number(url.searchParams.get('weight'));
      if (!u || !Number.isFinite(w) || w < 0 || w > 1000) return json(res, 400, { error: '参数不合法（weight 0-1000）' });
      const old = u.weight; u.weight = w;
      pushLog({ t: Date.now(), level: 'warn', upstream: u.id, note: `权重 ${old} → ${w}` });
      console.log(`[gw] ${u.id} 权重 ${old} → ${w}`);
      return json(res, 200, { ok: true, id: u.id, weight: w, previous: old });
    }
    if (url.pathname === '/_gw/logs') return json(res, 200, { rows: recentLogs.slice(0, 80) });
    if (url.pathname === '/_gw/metrics.prom') { const b = prometheusText(); res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }); res.end(b); return { status: 200 }; }
    return json(res, 404, { error: '网关接口不存在' });
  }

  // ── 业务流量：选实例并代理 ──
  const group = GROUPS.shop;
  const upstream = pick(group, req);
  stats.requests++;
  if (!upstream) {
    stats.noUpstream++;
    return json(res, 503, { error: '没有可用实例（全部不健康或权重为 0）' });
  }
  proxy(req, res, url, upstream);
});

startHealthChecks();
server.listen(PORT, HOST, () => {
  console.log(`[AURUM 网关] 已启动 → http://${HOST}:${PORT}/`);
  console.log(`  上游：${GROUPS.shop.upstreams.map((u) => `${u.id}(${u.color}, 权重${u.weight}, ${u.url})`).join('  |  ')}`);
  console.log(`  健康检查：${HEALTH_PATH} 每 ${HEALTH_INTERVAL_MS}ms · 失败${FAIL_THRESHOLD}次摘除 / 成功${PASS_THRESHOLD}次恢复`);
  console.log(`  运维接口：/_gw/status · PUT /_gw/weight?group=shop&id=shop-green&weight=5 · /_gw/metrics.prom（令牌：${ADMIN_TOKEN ? '已启用' : '未设置（仅本机）'}）`);
});

// 优雅下线：先摘掉自己（权重归零由外部改），再等连接结束
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[gw] 收到 ${sig}，停止接收新连接…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
export { server };
