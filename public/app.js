// 至尊家居 · 现代化后台 —— 前端（原生 ES 模块，零依赖）
window.__faLoaded = 'v2.0.2';           // 探针：便于确认模块是否执行（诊断用，可保留）
console.log('[app.js] loaded');
const $ = (id) => document.getElementById(id);
const state = { user: null, pPage: 1, pSize: 10, oPage: 1, oSize: 10, editing: null, cats: [], series: [] };

// ────────── 请求封装 ──────────
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (method !== 'GET') opts.headers['X-Requested-With'] = 'fetch';   // CSRF 防护：服务端要求这个头
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  // 注意：登录接口自己会用 401 表示「口令错误」，不能当成会话过期处理，
  // 否则会把服务端的具体提示吞掉，用户只看到「未登录」（这是踩过的坑）。
  if (res.status === 401 && !path.startsWith('/api/auth/login')) { showLogin(); throw new Error('会话已过期，请重新登录'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ────────── 登录 / 登出 ──────────
function showLogin() { $('login').hidden = false; $('app').hidden = true; }
function showApp() { $('login').hidden = true; $('app').hidden = false; }

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').hidden = true;
  $('loginBtn').disabled = true;
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { username: $('username').value, password: $('password').value } });
    state.user = r.user;
    await boot();
  } catch (err) {
    $('loginErr').textContent = err.message;
    $('loginErr').hidden = false;
  } finally { $('loginBtn').disabled = false; }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  state.user = null;
  showLogin();
});

// ────────── 视图切换 ──────────
document.querySelectorAll('.navbtn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.navbtn').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + b.dataset.view));
  if (b.dataset.view === 'products') loadProducts();
  if (b.dataset.view === 'categories') loadCategories();
  if (b.dataset.view === 'orders') loadOrders();
  if (b.dataset.view === 'system') loadSystem();
}));

// ────────── 实时监控（SSE）──────────
// 演示重置倒计时（服务端每 10 分钟把业务数据恢复为种子状态——登录页上的承诺，界面上要看得见）
const resetEl = document.createElement('span');
resetEl.className = 'live';
resetEl.id = 'resetIn';
resetEl.title = '演示数据每 10 分钟自动重置为种子数据';
document.querySelector('.topbar .right')?.prepend(resetEl);
function tickReset() {
  if (!state.nextResetAt) return;
  const left = Math.max(0, Math.round((state.nextResetAt - Date.now()) / 1000));
  resetEl.innerHTML = `<i></i>重置倒计时 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}
setInterval(tickReset, 1000);

function connectStream() {
  const es = new EventSource('/api/system/stream');
  const dot = $('liveDot');
  es.addEventListener('open', () => { dot.classList.add('on'); dot.classList.remove('off'); $('liveText').textContent = '实时连接'; });
  es.addEventListener('error', () => { dot.classList.remove('on'); dot.classList.add('off'); $('liveText').textContent = '重连中…'; });
  es.addEventListener('reset', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      state.nextResetAt = d.nextResetAt;
      tickReset();
      const view = document.querySelector('.navbtn.on')?.dataset.view;
      if (view === 'products') loadProducts();          // 正在看商品就把数据刷新过来
      resetEl.animate?.([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 900 });
      console.log('[demo] 数据已重置', d.counts);
    } catch {}
  });
  es.addEventListener('metrics', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.nextResetAt) { state.nextResetAt = m.nextResetAt; tickReset(); }
    $('kpiQps').textContent = m.qps;
    $('kpiP95').innerHTML = m.latency.p95 + '<small>ms</small>';
    $('kpiErr').innerHTML = m.errorRate + '<small>%</small>';
    $('kpiSessions').textContent = m.sessions ?? '-';
    $('kpiRss').innerHTML = m.rssMB + '<small>MB</small>';
    $('kpiDb').innerHTML = (m.dbKB ?? 0) + '<small>KB</small>';
    window.__faRenderAlerts?.(m.alerts);   // 活跃告警横幅（由 adminPanel 提供渲染函数）
    drawSpark(m.series ?? []);
    const tb = $('slowBody');
    tb.innerHTML = (m.slowest ?? []).length
      ? m.slowest.map((s) => `<tr><td>${esc(s.path)}</td><td>${s.count}</td><td>${s.avgMs} ms</td><td>${s.maxMs} ms</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">暂无数据</td></tr>';
    $('kvBox').innerHTML = kv([
      ['运行时长', fmtUptime(m.uptimeSec)], ['累计请求', m.counters.total],
      ['成功 / 4xx / 5xx', `${m.counters.ok} / ${m.counters.clientErr} / ${m.counters.serverErr}`],
      ['P50 / P99 延迟', `${m.latency.p50} / ${m.latency.p99} ms`],
      ['堆内存', m.heapMB + ' MB'], ['SSE 订阅者', m.sseClients ?? 0], ['Node', m.node ?? ''],
    ]);
  });
  es.addEventListener('log', (ev) => {
    const e = JSON.parse(ev.data).entry;
    const box = $('logStream');
    const cls = e.status >= 500 ? 's5' : e.status >= 400 ? 's4' : 's2';
    const div = document.createElement('div');
    div.innerHTML = `<span class="t">${new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })}</span>`
      + `<span class="${cls}">${e.status}</span><span class="p">${esc(e.method + ' ' + e.path)}</span>`
      + `<span class="t">${e.ms}ms</span><span class="t">${esc(e.actor || '-')}</span>`;
    box.prepend(div);
    while (box.childElementCount > 120) box.lastElementChild.remove();
    $('logCount').textContent = `（已收到 ${box.childElementCount} 条）`;
  });
}

/** 手写 canvas 折线（不引入图表库，符合 CSP 且零依赖） */
function drawSpark(series) {
  const cv = $('spark');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 18;
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(1, ...series);
  // 网格
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--line');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad + ((H - pad * 2) / 3) * i;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  }
  // 折线
  const step = (W - pad * 2) / Math.max(1, series.length - 1);
  const pts = series.map((v, i) => [pad + i * step, H - pad - (v / max) * (H - pad * 2)]);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(110,168,254,.45)'); grad.addColorStop(1, 'rgba(110,168,254,0)');
  ctx.beginPath(); ctx.moveTo(pts[0][0], H - pad);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(pts[pts.length - 1][0], H - pad); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = '#6ea8fe'; ctx.lineWidth = 2; ctx.stroke();
  // 峰值标注
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--sub');
  ctx.font = '12px system-ui';
  ctx.fillText('峰值 ' + max + ' req/s', pad, pad - 4);
}

// ────────── 商品 ──────────
async function loadProducts() {
  const q = new URLSearchParams({ page: state.pPage, size: state.pSize });
  if ($('pQ').value) q.set('q', $('pQ').value);
  if ($('pCat').value) q.set('category', $('pCat').value);
  if ($('pStatus').value !== '') q.set('status', $('pStatus').value);
  const r = await api('/api/products?' + q);
  $('pBody').innerHTML = r.rows.length ? r.rows.map((p) => `
    <tr>
      <td>${p.id}</td><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.categoryName || '—')}</td>
      <td class="num">¥${p.price.toFixed(2)}</td><td class="num">${p.stock}</td>
      <td><span class="badge ${p.status ? 'ok' : 'off'}">${p.status ? '上架' : '下架'}</span></td>
      <td class="dim">${esc(p.updatedBy || '')}</td>
      <td><div class="tools">
        <button data-edit="${p.id}">编辑</button>
        <button data-del="${p.id}">删除</button>
      </div></td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">没有匹配的商品</td></tr>';
  const from = r.total ? (r.page - 1) * r.size + 1 : 0;
  $('pInfo').textContent = `第 ${from} 到 ${Math.min(r.page * r.size, r.total)} 条，共 ${r.total} 条记录`;
  $('pBody').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openModal(Number(b.dataset.edit))));
  $('pBody').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delProduct(Number(b.dataset.del))));
}

$('pSearch').addEventListener('click', () => { state.pPage = 1; loadProducts(); });
$('pQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.pPage = 1; loadProducts(); } });
$('pPrev').addEventListener('click', () => { if (state.pPage > 1) { state.pPage--; loadProducts(); } });
$('pNext').addEventListener('click', () => { state.pPage++; loadProducts(); });
$('pAdd').addEventListener('click', () => openModal(null));

function fillCatSelects() {
  const opts = '<option value="">未分类</option>' + state.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('fCat').innerHTML = opts;
  $('pCat').innerHTML = '<option value="">全部分类</option>' + state.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

function openModal(id) {
  state.editing = id;
  $('mTitle').textContent = id ? `编辑商品 #${id}` : '新增商品';
  $('mErr').hidden = true;
  if (id) {
    const tr = $('pBody').querySelector(`[data-edit="${id}"]`).closest('tr');
    const [pid, sku, name, , price, stock, , , ] = [...tr.children].map((td) => td.textContent);
    $('fSku').value = sku; $('fName').value = name;
    $('fPrice').value = price.replace('¥', ''); $('fStock').value = stock;
    $('fStatus').value = tr.querySelector('.badge').textContent === '上架' ? '1' : '0';
    $('fCat').value = ''; $('fDesc').value = '';
  } else {
    $('fSku').value = ''; $('fName').value = ''; $('fPrice').value = ''; $('fStock').value = '0'; $('fDesc').value = '';
  }
  $('modal').hidden = false;
}
$('mCancel').addEventListener('click', () => { $('modal').hidden = true; });
$('mSave').addEventListener('click', async () => {
  $('mErr').hidden = true;
  const body = {
    sku: $('fSku').value, name: $('fName').value, categoryId: Number($('fCat').value) || undefined,
    price: Number($('fPrice').value), stock: Number($('fStock').value), status: Number($('fStatus').value),
    description: $('fDesc').value,
  };
  try {
    if (state.editing) {
      body.sku = undefined;
      await api('/api/products/' + state.editing, { method: 'PUT', body });
    } else {
      await api('/api/products', { method: 'POST', body });
    }
    $('modal').hidden = true;
    loadProducts();
  } catch (err) { $('mErr').textContent = err.message; $('mErr').hidden = false; }
});

async function delProduct(id) {
  if (!confirm(`确认下架并删除商品 #${id}？（软删除，数据仍可追溯）`)) return;
  try { await api('/api/products/' + id, { method: 'DELETE' }); loadProducts(); }
  catch (err) { alert(err.message); }
}

// ────────── 分类 ──────────
async function loadCategories() {
  const r = await api('/api/categories');
  state.cats = r.rows;
  fillCatSelects();
  $('cList').innerHTML = r.rows.length ? r.rows.map((c) => `
    <div class="catcard">
      <b>${esc(c.name)}</b>
      <div class="meta">排序 ${c.sort} · ${c.productCount} 个商品 · ${c.status ? '启用' : '停用'}</div>
      <div class="meta">创建人 ${esc(c.createdBy || '-')}</div>
      <button data-delc="${c.id}">删除分类</button>
    </div>`).join('') : '<p class="dim">还没有分类</p>';
  $('cList').querySelectorAll('[data-delc]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/api/categories/' + b.dataset.delc, { method: 'DELETE' }); loadCategories(); }
    catch (err) { alert(err.message); }
  }));
}
$('cAdd').addEventListener('click', async () => {
  if (!$('cName').value.trim()) return;
  try {
    await api('/api/categories', { method: 'POST', body: { name: $('cName').value, sort: Number($('cSort').value) || 0 } });
    $('cName').value = '';
    loadCategories();
  } catch (err) { alert(err.message); }
});

// ────────── 订单 ──────────
const ORDER_STATUS = { pending: '待付款', paid: '已付款', shipped: '已发货', done: '已完成', cancelled: '已取消' };
// 与服务端 ORDER_FLOW 保持一致的前端镜像（仅用于渲染可选动作，真正的校验在服务端）
const ORDER_FLOW = { pending: ['paid', 'cancelled'], paid: ['shipped', 'cancelled'], shipped: ['done'], done: [], cancelled: [] };
async function loadOrders() {
  const q = new URLSearchParams({ page: state.oPage, size: state.oSize });
  if ($('oStatus').value) q.set('status', $('oStatus').value);
  const r = await api('/api/orders?' + q);
  $('oBody').innerHTML = r.rows.length ? r.rows.map((o) => `
    <tr><td>${esc(o.orderNo)}</td><td>${esc(o.customer)}</td><td>${esc(o.phone)}</td>
    <td class="num">¥${o.total.toFixed(2)}</td><td class="num">${o.itemCount}</td>
    <td><span class="badge ${o.status === 'done' ? 'ok' : o.status === 'cancelled' ? 'off' : 'warn'}">${ORDER_STATUS[o.status] ?? o.status}</span>
      <span class="tools" style="margin-left:8px">${(ORDER_FLOW[o.status] ?? []).map((s) => `<button data-ost="${o.id}:${s}" title="流转到「${ORDER_STATUS[s]}」">→ ${ORDER_STATUS[s]}</button>`).join('') || '<span class="dim">—</span>'}</span></td>
    <td class="dim">${esc(o.createdAt)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">暂无订单</td></tr>';
  $('oInfo').textContent = `共 ${r.total} 条`;
}
$('oSearch').addEventListener('click', () => { state.oPage = 1; loadOrders(); });
$('oPrev').addEventListener('click', () => { if (state.oPage > 1) { state.oPage--; loadOrders(); } });
$('oNext').addEventListener('click', () => { state.oPage++; loadOrders(); });

// ────────── 系统 ──────────
async function loadSystem() {
  const h = await api('/api/system/health');
  $('sysBox').innerHTML = kv([
    ['版本', h.version], ['Node 运行时', h.node], ['运行时长', fmtUptime(h.uptimeSec)],
    ['在线会话', h.sessions], ['数据库体积', h.dbKB + ' KB'], ['接口', 'REST + SSE + Prometheus'],
  ]);
  $('tableBox').innerHTML = kv(Object.entries(h.tables).map(([k, v]) => [k, v]));
  const a = await api('/api/system/audit');
  $('auditBody').innerHTML = a.rows.length ? a.rows.map((r) => `
    <tr><td class="dim">${esc(r.created_at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td>
    <td>${esc(r.target)}</td><td>${esc(r.detail).slice(0, 60)}</td><td class="dim">${esc(r.ip)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">暂无记录</td></tr>';
  const prom = await fetch('/api/system/metrics.prom', { credentials: 'same-origin' });
  $('promPreview').textContent = (await prom.text()).split('\n').slice(0, 18).join('\n') + '\n…';
}

// ────────── 工具 ──────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kv = (pairs) => pairs.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
const fmtUptime = (s) => s < 60 ? s + ' 秒' : s < 3600 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';

// ══════════ 二期/三期界面：用户与权限 · 会话 · 告警规则 · 导出（动态注入，避免改动 index.html）══════════
(function adminPanel() {
  const nav = document.querySelector('.topbar nav');
  const app = document.getElementById('app');
  if (!nav || !app) return;

  const btn = document.createElement('button');
  btn.className = 'navbtn'; btn.dataset.view = 'adminpanel'; btn.textContent = '用户与告警';
  nav.appendChild(btn);

  const view = document.createElement('main');
  view.className = 'view'; view.id = 'view-adminpanel'; view.hidden = true;
  view.innerHTML = `
    <h2>用户与告警</h2>
    <p class="sub">二期：RBAC 用户管理与会话吊销；三期：告警规则（阈值可现场改，改了立刻生效）、状态变化历史、CSV 导出。</p>
    <div class="kpis" id="apKpis"></div>
    <div class="grid2">
      <div class="card">
        <h3>告警规则 <span class="dim">改完点保存，服务端每秒按新阈值判定</span></h3>
        <table class="data"><thead><tr><th>规则</th><th>指标</th><th class="num">阈值</th><th>启用</th><th>操作</th></tr></thead>
          <tbody id="apRules"></tbody></table>
      </div>
      <div class="card">
        <h3>告警历史 <span class="dim">只记录状态变化（触发/恢复），不刷屏</span></h3>
        <table class="mini"><thead><tr><th>时间</th><th>规则</th><th>状态</th><th>值</th></tr></thead>
          <tbody id="apHistory"></tbody></table>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <h3>用户与权限</h3>
        <div class="toolbar" style="margin-bottom:12px">
          <input id="apNewUser" placeholder="用户名（3-20 位）" style="width:150px">
          <input id="apNewPass" placeholder="口令（≥8 位）" style="width:150px" type="password">
          <select id="apNewRole"><option value="viewer">只读 viewer</option><option value="operator">运营 operator</option><option value="admin">管理员 admin</option></select>
          <button class="primary" id="apAddUser">+ 新建用户</button>
        </div>
        <table class="data"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
          <tbody id="apUsers"></tbody></table>
      </div>
      <div class="card">
        <h3>在线会话 <span class="dim">可强制吊销</span></h3>
        <table class="data"><thead><tr><th>用户</th><th>IP</th><th>剩余</th><th>操作</th></tr></thead>
          <tbody id="apSessions"></tbody></table>
        <div class="toolbar" style="margin-top:14px">
          <a class="btn" href="/api/export/products.csv" download>导出商品 CSV</a>
          <a class="btn ghost" href="/api/export/orders.csv" download>导出订单 CSV</a>
        </div>
      </div>
    </div>`;
  app.appendChild(view);

  btn.addEventListener('click', () => {
    document.querySelectorAll('.navbtn').forEach((x) => x.classList.toggle('on', x === btn));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-adminpanel'));
    loadAdmin();
  });

  // 订单状态流转（表格里的 → 按钮，事件委托）
  $('oBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ost]');
    if (!b) return;
    const [id, status] = b.dataset.ost.split(':');
    b.disabled = true;
    try {
      await api(`/api/orders/${id}/status`, { method: 'PUT', body: { status } });
      loadOrders();
    } catch (err) {
      alert(err.message);          // 服务端会返回「不允许从 X 直接变成 Y」并附可选状态
      loadOrders();
    }
  });

  const RULE_LABEL = { error_rate: '错误率过高', p95_latency: 'P95 延迟过高', rss_memory: '内存占用过高', qps_spike: 'QPS 突增' };

  async function loadAdmin() {
    const [alerts, users, sessions] = await Promise.all([
      api('/api/system/alerts'), api('/api/users'), api('/api/sessions'),
    ]);

    $('apKpis').innerHTML = `
      <div class="kpi"><span>活跃告警</span><b>${alerts.active.length}</b></div>
      <div class="kpi"><span>规则总数</span><b>${alerts.rules.length}</b></div>
      <div class="kpi"><span>已启用规则</span><b>${alerts.rules.filter((r) => r.enabled).length}</b></div>
      <div class="kpi"><span>用户 / 在线会话</span><b>${users.rows.length}<small> / ${sessions.rows.length}</small></b></div>`;

    $('apRules').innerHTML = alerts.rules.map((r) => `
      <tr>
        <td>${esc(RULE_LABEL[r.id] ?? r.name)}${alerts.active.some((a) => a.ruleId === r.id) ? ' <span class="badge warn">告警中</span>' : ''}</td>
        <td class="dim">${esc(r.metric)}</td>
        <td class="num"><input data-th="${r.id}" value="${r.threshold}" type="number" style="width:90px;text-align:right"> ${esc(r.unit)}</td>
        <td><input data-en="${r.id}" type="checkbox" ${r.enabled ? 'checked' : ''} style="width:auto"></td>
        <td><button data-save="${r.id}">保存</button></td>
      </tr>`).join('');

    $('apHistory').innerHTML = alerts.history.length ? alerts.history.map((h) => `
      <tr><td class="dim">${esc(h.created_at)}</td><td>${esc(RULE_LABEL[h.rule_id] ?? h.name)}</td>
      <td><span class="badge ${h.state === 'firing' ? 'warn' : 'ok'}">${h.state === 'firing' ? '触发' : '恢复'}</span></td>
      <td class="num">${h.value}${esc(h.unit)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">还没有告警记录</td></tr>';

    $('apUsers').innerHTML = users.rows.map((u) => `
      <tr>
        <td>${esc(u.username)}<span class="dim"> ${esc(u.displayName)}</span></td>
        <td><select data-urole="${u.id}">
          ${['admin', 'operator', 'viewer'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select></td>
        <td><span class="badge ${u.active ? 'ok' : 'off'}">${u.active ? '启用' : '停用'}</span></td>
        <td class="dim">${esc(u.lastLoginAt ?? '—')}</td>
        <td><div class="tools">
          <button data-usave="${u.id}">保存</button>
          <button data-utoggle="${u.id}:${u.active ? 0 : 1}">${u.active ? '停用' : '启用'}</button>
          <button data-upass="${u.id}">重置口令</button>
        </div></td>
      </tr>`).join('');

    $('apSessions').innerHTML = sessions.rows.length ? sessions.rows.map((s) => `
      <tr><td>${esc(s.username)}</td><td class="dim">${esc(s.ip)}</td><td class="num">${s.expiresInMin} 分钟</td>
      <td><button data-srev="${esc(s.fullId)}">吊销</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">没有活跃会话</td></tr>';

    view.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.save;
      const threshold = Number(view.querySelector(`[data-th="${id}"]`).value);
      const enabled = view.querySelector(`[data-en="${id}"]`).checked;
      try { await api('/api/system/alerts/' + id, { method: 'PUT', body: { threshold, enabled } }); loadAdmin(); }
      catch (err) { alert(err.message); }
    }));

    view.querySelectorAll('[data-usave]').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.usave);
      const role = view.querySelector(`[data-urole="${id}"]`).value;
      try { await api('/api/users/' + id, { method: 'PUT', body: { role } }); loadAdmin(); }
      catch (err) { alert(err.message); }
    }));
    view.querySelectorAll('[data-utoggle]').forEach((b) => b.addEventListener('click', async () => {
      const [id, active] = b.dataset.utoggle.split(':');
      try { await api('/api/users/' + id, { method: 'PUT', body: { active: active === '1' } }); loadAdmin(); }
      catch (err) { alert(err.message); }
    }));
    view.querySelectorAll('[data-upass]').forEach((b) => b.addEventListener('click', async () => {
      const pwd = prompt('输入新口令（至少 8 位）');
      if (!pwd) return;
      try { await api('/api/users/' + b.dataset.upass, { method: 'PUT', body: { password: pwd } }); alert('口令已重置，该用户的其它会话已被吊销'); loadAdmin(); }
      catch (err) { alert(err.message); }
    }));
    view.querySelectorAll('[data-srev]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/api/sessions/' + b.dataset.srev, { method: 'DELETE' }); loadAdmin(); }
      catch (err) { alert(err.message); }
    }));
  }

  $('apAddUser').addEventListener('click', async () => {
    try {
      await api('/api/users', { method: 'POST', body: {
        username: $('apNewUser').value, password: $('apNewPass').value, role: $('apNewRole').value,
      } });
      $('apNewUser').value = ''; $('apNewPass').value = '';
      loadAdmin();
    } catch (err) { alert(err.message); }
  });

  // 活跃告警横幅：SSE 推送里带 alerts 字段
  window.__faRenderAlerts = (list) => {
    let bar = document.getElementById('alertBar');
    if (!list?.length) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'alertBar';
      bar.className = 'card';
      bar.style.cssText = 'max-width:1240px;margin:14px auto 0;border-left:5px solid var(--warn);background:#2a1f10';
      document.getElementById('app').prepend(bar);
    }
    bar.innerHTML = '<b style="color:var(--warn)">⚠ 活跃告警</b> ' + list.map((a) =>
      `<span class="badge warn" style="margin-left:8px">${esc(a.name)} ${a.value}${esc(a.unit)} > ${a.threshold}${esc(a.unit)} · 持续 ${a.sinceSec}s</span>`).join('');
  };
})();

// ────────── 启动 ──────────
async function boot() {
  showApp();
  $('whoami').textContent = `${state.user.displayName || state.user.username}（${state.user.role}）`;
  const c = await api('/api/categories');
  state.cats = c.rows;
  fillCatSelects();
  await loadProducts();
  connectStream();
}

(async () => {
  try {
    const me = await api('/api/auth/me');
    if (me.user) { state.user = me.user; await boot(); } else showLogin();
  } catch { showLogin(); }
})();
