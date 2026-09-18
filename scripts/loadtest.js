/**
 * 零依赖压测脚本 —— 用真实并发打自己的接口，验证监控面板上的数字不是摆设。
 *
 * 用法：
 *   node scripts/loadtest.js --base https://furniture.shijia.cyou --user admin --pass 'xxx' \
 *        --concurrency 20 --duration 15
 *
 * 它做的事：
 *   1. 登录拿 Cookie
 *   2. 起 N 个并发 worker，持续 duration 秒混合调用读接口
 *   3. 输出总请求数、QPS、成功率、P50/P95/P99、状态码分布
 * 同时打开监控面板，就能看到 QPS 曲线抬起来、延迟分位变化、慢接口 Top5 刷新。
 */
import { createHmac, randomUUID } from 'node:crypto';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};

const BASE = arg('base', 'http://127.0.0.1:8090');
const USER = arg('user', 'admin');
const PASS = arg('pass', process.env.FA_PASS ?? '');
const CONCURRENCY = Number(arg('concurrency', 10));
const DURATION = Number(arg('duration', 10));
const PATHS = (arg('paths', '/api/products?page=1&size=10,/api/categories,/api/orders,/api/system/metrics,/api/system/health')).split(',');

if (!PASS) { console.error('缺少 --pass（或环境变量 FA_PASS）'); process.exit(1); }

const stats = { total: 0, ok: 0, err: 0, statuses: {}, latencies: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) throw new Error('登录失败：HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function worker(cookie, until) {
  let i = 0;
  while (Date.now() < until) {
    const p = PATHS[i++ % PATHS.length];
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + p, { headers: { cookie } });
      await res.arrayBuffer();                       // 读干净 body，避免连接被提前复用
      const ms = performance.now() - t0;
      stats.total++; stats.latencies.push(ms);
      stats.statuses[res.status] = (stats.statuses[res.status] ?? 0) + 1;
      if (res.ok) stats.ok++; else stats.err++;
    } catch {
      stats.total++; stats.err++;
      stats.statuses['network_error'] = (stats.statuses['network_error'] ?? 0) + 1;
    }
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const main = async () => {
  console.log(`== 压测目标 ${BASE}`);
  console.log(`== 并发 ${CONCURRENCY} · 时长 ${DURATION}s · 接口 ${PATHS.length} 个`);
  const cookie = await login();
  console.log('== 已登录，开始压测…');
  const t0 = Date.now();
  const until = t0 + DURATION * 1000;
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(cookie, until)));
  const elapsed = (Date.now() - t0) / 1000;
  const r = (x) => Math.round(x * 10) / 10;
  console.log('\n================ 结果 ================');
  console.log(`总请求数    ${stats.total}`);
  console.log(`实际 QPS    ${r(stats.total / elapsed)}`);
  console.log(`成功率      ${r((stats.ok / Math.max(1, stats.total)) * 100)}%   （失败 ${stats.err}）`);
  console.log(`延迟 P50    ${r(pct(stats.latencies, 50))} ms`);
  console.log(`延迟 P95    ${r(pct(stats.latencies, 95))} ms`);
  console.log(`延迟 P99    ${r(pct(stats.latencies, 99))} ms`);
  console.log(`最大延迟    ${r(Math.max(0, ...stats.latencies))} ms`);
  console.log(`状态码分布  ${JSON.stringify(stats.statuses)}`);
  console.log('=====================================');
  console.log('（此刻打开监控面板，能看到 QPS 曲线与慢接口 Top5 同步变化）');
};

main().catch((e) => { console.error('压测失败：', e.message); process.exit(1); });
