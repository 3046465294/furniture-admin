// AURUM 家居商城 前台 —— 原生 ES 模块，零依赖
const $ = (id) => document.getElementById(id);
const main = $('main');
const state = { user: null, cats: [], cart: null, listQuery: { q: '', category: 0, sort: 'new', page: 1 } };

// ────────── 请求封装（变更类请求带 CSRF 自定义头，与后台一致）──────────
/** 缓存治理：GET 请求追加时间戳，绕开浏览器启发式缓存（服务端已设 no-store，这里是双保险） */
const bustPath = (p, method) => (method === 'GET' ? p + (p.includes('?') ? '&' : '?') + '_=' + Date.now() : p);

async function api(path, { method = 'GET', body } = {}) {
  const o = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  if (method !== 'GET') o.headers['X-Requested-With'] = 'fetch';
  const res = await fetch(bustPath(path, method), o);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '¥' + Number(n || 0).toFixed(2);
const initial = (name) => esc(String(name || '?').trim().slice(0, 1));
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ────────── 顶栏购物车角标 ──────────
function renderCartBadge() {
  const n = state.cart?.count ?? 0;
  const b = $('cartN');
  b.textContent = n; b.hidden = n === 0;
}

// ────────── 视图 ──────────
async function viewHome() {
  const [cats, hot, fresh, stats] = await Promise.all([
    api('/api/shop/categories'),
    api('/api/shop/products?size=8&sort=hot'),
    api('/api/shop/products?size=4&sort=new'),
    api('/api/shop/health'),
  ]);
  state.cats = cats.rows;
  const promises = [
    { t: '真实库存', d: '每笔加购都校验当前规格库存，售罄自动禁止下单' },
    { t: '按规格计价', d: '同一商品不同颜色尺寸独立价格与库存，下单锁定对应规格' },
    { t: '订单可追溯', d: '每次库存变动与订单状态流转都留痕，后台可查审计' },
  ];
  main.innerHTML = `
    <section class="hero">
      <div class="hero-badge">AURUM · 家居商城</div>
      <h1>把一件家具，安放进你的生活</h1>
      <p>沙发 · 床类 · 餐桌椅 · 衣柜 · 储物收纳 · 户外家具。从浏览到签收的完整链路：选规格 → 加购 → 结算 → 生成订单 → 支付 → 发货 → 完成。</p>
      <div class="row" style="gap:10px;margin:18px 0 8px">
        <a class="btn primary" href="#/list">开始选购</a>
        <a class="btn ghost" href="#/orders">我的订单</a>
      </div>
      <div class="hero-stats">
        <span><b>${stats.products}</b>件在售</span>
        <span><b>${cats.rows.length}</b>个分类</span>
        <span><b>${stats.orders}</b>笔订单</span>
        <span><b>0</b>第三方依赖</span>
      </div>
    </section>
    <div class="promise">
      ${promises.map((p) => `<div class="promise-item"><b>${esc(p.t)}</b><span>${esc(p.d)}</span></div>`).join('')}
    </div>
    <div class="chips">
      <a class="chip on" href="#/list">全部商品</a>
      ${cats.rows.map((c) => `<a class="chip" href="#/list?category=${c.id}">${esc(c.name)} <span class="dim">${c.count}</span></a>`).join('')}
    </div>
    <div class="floor-head"><h2>分类直达</h2><span class="muted">按分类浏览，数量为当前在售件数</span></div>
    <div class="tiles">
      ${cats.rows.map((c) => `<a class="tile" href="#/list?category=${c.id}"><span class="tile-name">${esc(c.name)}</span><span class="tile-n">${c.count} 件在售</span></a>`).join('')}
    </div>
    <div class="floor-head"><h2>新品上架</h2><a class="muted" href="#/list?sort=new">查看全部 →</a></div>
    <div class="grid">${fresh.rows.map(card).join('')}</div>
    <div class="floor-head"><h2>热销推荐</h2><a class="muted" href="#/list?sort=hot">查看全部 →</a></div>
    <p class="muted" style="margin:-6px 0 14px">按累计销量排序 —— 数据来自订单明细的真实汇总。</p>
    <div class="grid">${hot.rows.map(card).join('')}</div>`;
}

function card(p) {
  return `<article class="pcard">
    <a href="#/p/${p.id}" class="thumb" aria-label="${esc(p.name)}"><span>${initial(p.name)}</span></a>
    <div class="info">
      <h3><a href="#/p/${p.id}" style="color:inherit">${esc(p.name)}</a></h3>
      <div class="meta"><span>${esc(p.category ?? '未分类')}</span><span>已售 ${p.sold}</span>${p.rating > 0 ? `<span>★ ${p.rating}</span>` : ''}</div>
      <div class="price">${money(p.price)}<small>库存 ${p.stock}</small></div>
      <div class="acts">
        <button class="btn-primary btn-sm" data-add="${p.id}">加入购物车</button>
        <a class="btn-ghost btn-sm" href="#/p/${p.id}">详情</a>
      </div>
    </div>
  </article>`;
}

async function viewList(params) {
  const q = new URLSearchParams(params);
  state.listQuery = {
    q: q.get('q') ?? '', category: Number(q.get('category') ?? 0),
    sort: q.get('sort') ?? 'new', page: Number(q.get('page') ?? 1),
  };
  const qs = new URLSearchParams({ size: 12, page: state.listQuery.page, sort: state.listQuery.sort });
  if (state.listQuery.q) qs.set('q', state.listQuery.q);
  if (state.listQuery.category) qs.set('category', state.listQuery.category);
  const r = await api('/api/shop/products?' + qs);
  if (!state.cats.length) state.cats = (await api('/api/shop/categories')).rows;
  const pages = Math.max(1, Math.ceil(r.total / r.size));
  main.innerHTML = `
    <div class="row-between" style="margin:6px 0 14px">
      <h2 style="font-size:20px;margin:0">${state.listQuery.q ? '搜索：' + esc(state.listQuery.q) : '全部商品'} <span class="dim">共 ${r.total} 件</span></h2>
      <div class="row">
        <select id="sortSel" style="width:auto">
          <option value="new" ${state.listQuery.sort === 'new' ? 'selected' : ''}>最新上架</option>
          <option value="hot" ${state.listQuery.sort === 'hot' ? 'selected' : ''}>销量优先</option>
          <option value="price_asc" ${state.listQuery.sort === 'price_asc' ? 'selected' : ''}>价格从低到高</option>
          <option value="price_desc" ${state.listQuery.sort === 'price_desc' ? 'selected' : ''}>价格从高到低</option>
        </select>
      </div>
    </div>
    <div class="chips">
      <a class="chip ${state.listQuery.category ? '' : 'on'}" href="#/list${state.listQuery.q ? '?q=' + encodeURIComponent(state.listQuery.q) : ''}">全部</a>
      ${state.cats.map((c) => `<a class="chip ${state.listQuery.category === c.id ? 'on' : ''}" href="#/list?category=${c.id}">${esc(c.name)}</a>`).join('')}
    </div>
    ${r.rows.length ? `<div class="grid">${r.rows.map(card).join('')}</div>` : '<div class="empty-state"><b>没有找到匹配的商品</b>换个关键词或分类试试</div>'}
    ${pages > 1 ? `<div class="row" style="justify-content:center;margin-top:22px">
      ${Array.from({ length: pages }, (_, i) => i + 1).map((n) => `<a class="chip ${n === r.page ? 'on' : ''}" href="#/list?page=${n}${state.listQuery.category ? '&category=' + state.listQuery.category : ''}${state.listQuery.q ? '&q=' + encodeURIComponent(state.listQuery.q) : ''}">${n}</a>`).join('')}
    </div>` : ''}`;
  $('sortSel').addEventListener('change', (e) => {
    const p = new URLSearchParams();
    p.set('sort', e.target.value);
    if (state.listQuery.category) p.set('category', state.listQuery.category);
    if (state.listQuery.q) p.set('q', state.listQuery.q);
    location.hash = '#/list?' + p;
  });
}

async function viewProduct(id) {
  const { product: p, reviews, skus, images } = await api('/api/shop/products/' + id);
  main.innerHTML = `
    <div class="steps"><a href="#/" class="muted">首页</a> / <span>${esc(p.category ?? '未分类')}</span> / <b>${esc(p.name)}</b></div>
    <div class="detail panel">
      <div>
        <div class="big" id="galleryMain">${images && images.length ? `<img src="${esc(images[0])}" alt="${esc(p.name)} 示意图" loading="lazy">` : initial(p.name)}</div>
        ${images && images.length > 1 ? `<div class="thumbs" id="gallery">${images.map((u, i) => `<button class="thumb ${i === 0 ? 'on' : ''}" data-img="${esc(u)}"><img src="${esc(u)}" alt="视图 ${i + 1}" loading="lazy"></button>`).join('')}</div>` : ''}
      </div>
      <div>
        <h1>${esc(p.name)}</h1>
        <div class="row" style="margin-bottom:12px">
          <span class="dim">SKU ${esc(p.sku)}</span><span class="dim">已售 ${p.sold}</span>
          ${p.rating > 0 ? `<span class="dim">★ ${p.rating}（${p.reviewCount} 条评价）</span>` : '<span class="dim">暂无评价</span>'}
        </div>
        <div class="price-lg" id="skuPrice">${money(p.price)}</div>
        ${skus && skus.length > 1 ? `<div class="row" id="skuBox" style="margin:14px 0;gap:8px;flex-wrap:wrap">
          <span class="dim">规格</span>
          ${skus.map((k, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-sku="${k.id}" data-price="${k.priceCents}" data-stock="${k.stock}" data-code="${esc(k.skuCode || '')}">${esc(k.spec)}${k.stock <= 0 ? '（缺货）' : ''}</button>`).join('')}
          <span class="muted" id="skuMeta"></span>
        </div>` : ''}
        <dl>
          <dt>分类</dt><dd>${esc(p.category ?? '未分类')}</dd>
          <dt>库存</dt><dd>${p.stock > 0 ? p.stock + ' 件' : '<span style="color:var(--err)">已售罄</span>'}</dd>
          <dt>描述</dt><dd>${esc(p.description || '—')}</dd>
        </dl>
        <div class="row" style="margin:16px 0">
          <div class="qty"><button data-q="-1">−</button><input id="qtyIn" value="1" inputmode="numeric" aria-label="购买数量"><button data-q="1">＋</button></div>
          <span class="muted" id="qtyHint"></span>
          <button class="btn-primary" id="addBtn" ${p.stock <= 0 ? 'disabled' : ''}>加入购物车</button>
          <button class="btn-ghost" id="buyNow" ${p.stock <= 0 ? 'disabled' : ''}>立即购买</button>
        </div>
        <hr class="hr">
        <h3 style="font-size:15px;margin:0 0 8px">商品评价</h3>
        ${reviews.length ? reviews.map((r) => `<div style="border-bottom:1px solid rgba(255,244,216,.08);padding:9px 0">
            <div class="row-between"><b style="font-size:13.5px">${esc(r.username)}</b><span class="dim">${esc(r.created_at)}</span></div>
            <div style="color:var(--gold-2);font-size:13px">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
            <div class="muted">${esc(r.content || '（未填写评价内容）')}</div></div>`).join('')
          : '<p class="muted">还没有评价 —— 购买后可在「我的订单」里评价。</p>'}
      </div>
    </div>`;
  // 数量上限 = 当前所选规格的库存（选规格前用商品级库存兜底）
  const maxQtyOf = () => {
    const b = document.querySelector('#skuBox [data-sku].on');
    const n = b ? Number(b.dataset.stock) : Number(p.stock);
    return Math.max(1, Math.min(99, Number.isFinite(n) ? n : 1));
  };
  const qty = () => Math.max(1, Math.min(maxQtyOf(), Number($('qtyIn').value) || 1));
  const syncQtyLimit = () => { $('qtyIn').value = qty(); $('qtyHint').textContent = '最多 ' + maxQtyOf() + ' 件'; };
  main.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
    $('qtyIn').value = Math.max(1, Math.min(maxQtyOf(), qty() + Number(b.dataset.q)));
    $('qtyHint').textContent = '最多 ' + maxQtyOf() + ' 件';
  }));
  // 规格选择：切换后联动价格、库存、SKU 编码；缺货自动禁用加购
  // 图画廊：点缩略图切换主图
  const gallery = $('gallery');
  if (gallery) {
    gallery.addEventListener('click', (e) => {
      const b = e.target.closest('[data-img]');
      if (!b) return;
      gallery.querySelectorAll('[data-img]').forEach((x) => x.classList.toggle('on', x === b));
      const main = $('galleryMain');
      if (main) main.innerHTML = '<img src="' + b.dataset.img + '" alt="' + esc(p.name) + ' 示意图">';
    });
  }

  let chosenSku = skus && skus.length ? skus[0].id : null;
  const skuBox = $('skuBox');
  if (skuBox) {
    const meta = $('skuMeta');
    const syncSku = () => {
      const b = skuBox.querySelector('[data-sku].on');
      if (!b) return;
      chosenSku = Number(b.dataset.sku);
      $('skuPrice').innerHTML = money(Number(b.dataset.price) / 100) + '<small>库存 ' + b.dataset.stock + '</small>';
      meta.textContent = 'SKU ' + (b.dataset.code || '—');
      const out = Number(b.dataset.stock) <= 0;
      $('addBtn').disabled = out;
      if ($('qtyHint')) { $('qtyIn').value = Math.max(1, Math.min(Number(b.dataset.stock) || 1, Number($('qtyIn').value) || 1)); syncQtyLimit(); }
      $('buyNow').disabled = out;
    };
    skuBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sku]');
      if (!b) return;
      skuBox.querySelectorAll('[data-sku]').forEach((x) => x.classList.toggle('on', x === b));
      syncSku();
    });
    syncSku();
  }
  $('addBtn').addEventListener('click', async () => { await addToCart(p.id, qty(), false, chosenSku); });
  $('buyNow').addEventListener('click', async () => {
    if (await addToCart(p.id, qty(), true, chosenSku)) location.hash = '#/cart';
  });
}

async function addToCart(productId, qty, silent, skuId) {
  if (!state.user) { toast('请先登录后再加购'); location.hash = '#/account'; return false; }
  try {
    state.cart = await api('/api/shop/cart', { method: 'POST', body: skuId ? { productId, skuId, qty } : { productId, qty } });
    renderCartBadge(); renderCartDrawer();
    if (!silent) { toast('已加入购物车'); openDrawer(); }
    return true;
  } catch (e) { toast(e.message); return false; }
}

// ────────── 购物车 ──────────
function renderCartDrawer() {
  const c = state.cart;
  if (!c) return;
  $('drawerTotal').textContent = money(c.total);
  $('drawerBody').innerHTML = c.items.length ? c.items.map((i) => `
    <div class="citem">
      <div class="mini">${initial(i.name)}</div>
      <div>
        <div class="nm">${esc(i.name)}</div>
        <div class="dim">${esc(i.sku)} · ${money(i.price)}</div>
        <div class="qty" style="margin-top:6px">
          <button data-cq="${i.id}:-1">−</button><input value="${i.qty}" readonly><button data-cq="${i.id}:1">＋</button>
        </div>
      </div>
      <div style="text-align:right">
        <div class="sub">${money(i.subtotal)}</div>
        <button class="btn-ghost btn-sm" style="margin-top:8px" data-cd="${i.id}">删除</button>
      </div>
    </div>`).join('') : '<div class="empty-state"><b>购物车是空的</b>去挑几件家具吧</div>';
  $('drawerBody').querySelectorAll('[data-cq]').forEach((b) => b.addEventListener('click', async () => {
    const [id, d] = b.dataset.cq.split(':');
    const item = state.cart.items.find((x) => x.id === Number(id));
    try { state.cart = await api('/api/shop/cart/' + id, { method: 'PUT', body: { qty: item.qty + Number(d) } }); renderCartBadge(); renderCartDrawer(); if (location.hash.startsWith('#/cart')) viewCart(); }
    catch (e) { toast(e.message); }
  }));
  $('drawerBody').querySelectorAll('[data-cd]').forEach((b) => b.addEventListener('click', async () => {
    state.cart = await api('/api/shop/cart/' + b.dataset.cd, { method: 'DELETE' });
    renderCartBadge(); renderCartDrawer(); if (location.hash.startsWith('#/cart')) viewCart();
  }));
}
const openDrawer = () => { $('drawer').hidden = false; $('scrim').hidden = false; };
const closeDrawer = () => { $('drawer').hidden = true; $('scrim').hidden = true; };
$('drawerClose').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('toCheckout').addEventListener('click', () => { closeDrawer(); location.hash = '#/cart'; });

async function viewCart() {
  if (!state.user) return viewAccount('请先登录后查看购物车');
  state.cart = await api('/api/shop/cart');
  renderCartBadge();
  const c = state.cart;
  main.innerHTML = `
    <h2 style="font-size:20px;margin:6px 0 16px">购物车 <span class="dim">${c.count} 件</span></h2>
    <div class="panel">
      ${c.items.length ? c.items.map((i) => `
        <div class="citem">
          <div class="mini">${initial(i.name)}</div>
          <div><div class="nm">${esc(i.name)}</div><div class="dim">${esc(i.sku)} · 单价 ${money(i.price)} · 库存 ${i.stock}</div></div>
          <div style="text-align:right">
            <div class="qty"><button data-cq="${i.id}:-1">−</button><input value="${i.qty}" readonly><button data-cq="${i.id}:1">＋</button></div>
            <div class="sub" style="margin-top:6px">${money(i.subtotal)}</div>
            <button class="btn-ghost btn-sm" style="margin-top:8px" data-cd="${i.id}">删除</button>
          </div>
        </div>`).join('') : '<div class="empty-state"><b>购物车是空的</b><a href="#/list">去逛逛</a></div>'}
      <div class="row-between" style="margin-top:18px">
        <div>合计 <b style="color:var(--gold-2);font-size:20px">${money(c.total)}</b></div>
        <div class="row">
          <a class="btn-ghost" href="#/list">继续购物</a>
          <button class="btn-primary" id="goCheckout" ${c.items.length ? '' : 'disabled'}>去结算</button>
        </div>
      </div>
    </div>`;
  main.querySelectorAll('[data-cq]').forEach((b) => b.addEventListener('click', async () => {
    const [id, d] = b.dataset.cq.split(':');
    const item = c.items.find((x) => x.id === Number(id));
    try { state.cart = await api('/api/shop/cart/' + id, { method: 'PUT', body: { qty: item.qty + Number(d) } }); renderCartBadge(); viewCart(); }
    catch (e) { toast(e.message); }
  }));
  main.querySelectorAll('[data-cd]').forEach((b) => b.addEventListener('click', async () => {
    state.cart = await api('/api/shop/cart/' + b.dataset.cd, { method: 'DELETE' }); renderCartBadge(); viewCart();
  }));
  $('goCheckout')?.addEventListener('click', () => (location.hash = '#/checkout'));
}

// ────────── 结算 ──────────
async function viewCheckout() {
  if (!state.user) return viewAccount('请先登录后结算');
  const [cart, addr] = await Promise.all([api('/api/shop/cart'), api('/api/shop/addresses')]);
  if (!cart.items.length) { location.hash = '#/cart'; return; }
  const def = addr.rows.find((a) => a.is_default) ?? addr.rows[0];
  main.innerHTML = `
    <div class="row-between" style="margin:6px 0 16px">
      <h2 style="font-size:20px;margin:0">确认订单</h2>
      <a class="muted" href="#/cart">← 返回购物车</a>
    </div>
    <div class="detail">
      <div class="stack">
        <div class="panel">
          <div class="row-between" style="margin-bottom:12px">
            <h3 style="margin:0;font-size:15px">收货地址</h3>
            <button class="btn-ghost btn-sm" id="toggleAddr">+ 新增地址</button>
          </div>
          <div class="stack" id="addrList">
            ${addr.rows.length ? addr.rows.map((a) => `
              <label class="addr ${def && a.id === def.id ? 'on' : ''}" data-addr="${a.id}">
                <input type="radio" name="addr" value="${a.id}" ${def && a.id === def.id ? 'checked' : ''} style="width:auto;margin-right:10px">
                <span class="addr-body">
                  <span class="addr-line"><b>${esc(a.receiver)}</b> <span class="muted">${esc(a.phone)}</span>${a.is_default ? ' <span class="badge ok">默认</span>' : ''}</span>
                  <span class="addr-line muted">${esc(a.region)} ${esc(a.detail)}</span>
                </span>
              </label>`).join('') : '<p class="muted" style="margin:0">还没有收货地址，请先新增一个</p>'}
          </div>
          <div id="addrForm" hidden style="margin-top:14px;border-top:1px solid rgba(255,244,216,.1);padding-top:14px">
            <div class="row" style="margin-bottom:10px">
              <input id="aReceiver" placeholder="收货人" style="flex:1;min-width:120px">
              <input id="aPhone" placeholder="手机号" style="flex:1;min-width:130px">
            </div>
            <div class="row" style="margin-bottom:10px">
              <input id="aRegion" placeholder="省 / 市 / 区" style="flex:1;min-width:140px">
              <input id="aDetail" placeholder="详细地址（街道、门牌）" style="flex:2;min-width:180px">
            </div>
            <div class="row">
              <button class="btn primary btn-sm" id="saveAddr">保存并使用</button>
              <button class="btn-ghost btn-sm" id="cancelAddr">取消</button>
              <span class="muted" id="addrMsg"></span>
            </div>
          </div>
        </div>
        <div class="panel stack">
          <h3 style="margin:0;font-size:15px">配送与备注</h3>
          <div class="row">
            <span class="dim" style="width:72px">送达时间</span>
            <select id="deliverPref" style="width:auto">
              <option value="">任意时间</option>
              <option value="仅工作日送达">仅工作日送达</option>
              <option value="仅周末送达">仅周末送达</option>
              <option value="需提前电话联系">需提前电话联系</option>
            </select>
          </div>
          <div class="row">
            <span class="dim" style="width:72px">订单备注</span>
            <input id="remark" placeholder="如：需要上门安装 / 放门口即可" style="flex:1">
          </div>
          <p class="muted" style="margin:0">配送偏好会合并写入订单备注，后台订单列表可直接看到。</p>
        </div>
      </div>
      <div class="panel">
        <h3 style="margin:0 0 12px;font-size:15px">商品清单</h3>
        ${cart.items.map((i) => `<div class="citem">
          <div class="mini">${initial(i.name)}</div>
          <div><div class="nm">${esc(i.name)}</div><div class="dim">${esc(i.spec || '默认')} · ${money(i.price)} × ${i.qty}</div></div>
          <div class="sub">${money(i.subtotal)}</div></div>`).join('')}
        <hr class="hr">
        <div class="row-between"><span class="muted">商品合计</span><b id="goodsAmt">${money(cart.total)}</b></div>
        <div class="row-between" style="margin-top:8px"><span class="muted">运费</span><span id="shipAmt" class="muted">计算中…</span></div>
        <div class="row-between" style="margin:14px 0 16px"><span>应付金额</span><b id="payAmt" style="color:var(--gold-2);font-size:22px">${money(cart.total)}</b></div>
        <button class="btn-primary btn-block" id="submitOrder">提交订单</button>
        <p class="muted" style="margin:12px 0 0">提交后生成「待付款」订单，可在「我的订单」完成模拟支付。演示环境不接入真实支付渠道。</p>
      </div>
    </div>`;

  const sel = () => Number(document.querySelector('input[name=addr]:checked')?.value ?? 0);
  const addrList = $('addrList');
  addrList.addEventListener('change', () => {
    addrList.querySelectorAll('.addr').forEach((el) => el.classList.toggle('on', String(sel()) === el.dataset.addr));
    refreshShipping();
  });
  // 运费实时报价：服务端算钱，前端只展示；接口不可用时优雅回退（不报错、不白屏）
  const refreshShipping = async () => {
    const el = $('shipAmt'), pay = $('payAmt'), goods = $('goodsAmt');
    if (!el) return;
    const addressId = sel();
    if (!addressId) { el.textContent = '选择地址后计算'; return; }
    try {
      const q = await api('/api/shop/shipping/quote', { method: 'POST', body: { addressId } });
      goods.textContent = money(q.goods);
      const fee = Number(q.shipping) || 0;
      el.textContent = (fee > 0 ? money(fee) : '免运费') + (q.template ? ' · ' + q.template : '') + (q.freeApplied ? '（已满额包邮）' : '');
      el.className = fee > 0 ? '' : 'gold';
      pay.textContent = money(q.payable);
    } catch (e) {
      // 后端还没上线运费接口时走这里（当前线上实例即为旧代码）
      el.textContent = '免运费（演示环境）';
      el.className = 'muted';
    }
  };
  await refreshShipping();

  $('toggleAddr').addEventListener('click', () => { const f = $('addrForm'); f.hidden = !f.hidden; });
  $('cancelAddr').addEventListener('click', () => { $('addrForm').hidden = true; });
  $('saveAddr').addEventListener('click', async () => {
    const receiver = $('aReceiver').value.trim();
    const phone = $('aPhone').value.trim();
    if (!receiver) return ($('addrMsg').textContent = '请填写收货人');
    if (!/^\\d{6,20}$/.test(phone.replace(/[^0-9]/g, ''))) return ($('addrMsg').textContent = '手机号格式不正确');
    try {
      await api('/api/shop/addresses', { method: 'POST', body: { receiver, phone, region: $('aRegion').value, detail: $('aDetail').value, isDefault: true } });
      toast('地址已保存'); viewCheckout();
    } catch (e) { $('addrMsg').textContent = e.message; }
  });
  $('submitOrder').addEventListener('click', async () => {
    const addressId = sel();
    if (!addressId) { toast('请选择收货地址'); return; }
    const btn = $('submitOrder');
    if (btn.disabled) return;                       // 防重复提交
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const pref = $('deliverPref').value;
      const note = $('remark').value.trim();
      const remark = [pref, note].filter(Boolean).join(' / ');
      const r = await api('/api/shop/checkout', { method: 'POST', body: { addressId, remark } });
      state.cart = await api('/api/shop/cart'); renderCartBadge();
      location.hash = '#/order/' + r.orderNo;
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '提交订单'; }
  });
}

// ────────── 我的订单 ──────────
const STATUS_TONE = { pending: 'warn', paid: 'ok', shipped: 'warn', done: 'ok', cancelled: 'off' };
async function viewOrders() {
  if (!state.user) return viewAccount('请先登录后查看订单');
  const { rows } = await api('/api/shop/orders');
  main.innerHTML = `
    <h2 style="font-size:20px;margin:6px 0 16px">我的订单 <span class="dim">${rows.length} 笔</span></h2>
    ${rows.length ? `<div class="stack">${rows.map((o) => `
      <div class="panel">
        <div class="row-between">
          <div><b>${esc(o.order_no)}</b> <span class="badge ${STATUS_TONE[o.status] ?? ''}">${esc(o.statusText)}</span></div>
          <div class="dim">${esc(o.created_at)}</div>
        </div>
        <div class="muted" style="margin:8px 0">${esc(o.items ?? '')}</div>
        <div class="row-between">
          <div>共 ${o.item_count} 件 · 合计 <b style="color:var(--gold-2)">${money(o.total)}</b></div>
          <div class="row">
            <a class="btn-ghost btn-sm" href="#/order/${o.order_no}">查看详情</a>
            ${o.status === 'pending' ? `<button class="btn-primary btn-sm" data-pay="${o.id}">模拟支付</button><button class="btn-ghost btn-sm" data-cancel="${o.id}">取消订单</button>` : ''}
          </div>
        </div>
      </div>`).join('')}</div>`
      : '<div class="empty-state"><b>还没有订单</b><a href="#/list">去挑几件家具</a></div>'}`;
  main.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api(`/api/shop/orders/${b.dataset.pay}/pay`, { method: 'POST' }); toast('支付成功（模拟）· 流水号 ' + r.tradeNo); viewOrders(); }
    catch (e) { toast(e.message); }
  }));
  main.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确认取消该订单？库存会自动回补。')) return;
    try { await api(`/api/shop/orders/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('订单已取消，库存已回补'); viewOrders(); }
    catch (e) { toast(e.message); }
  }));
}

async function viewOrderDetail(orderNo) {
  if (!state.user) return viewAccount('请先登录');
  const { order: o, items, payment } = await api('/api/shop/orders/' + encodeURIComponent(orderNo));
  main.innerHTML = `
    <div class="steps"><a href="#/orders" class="muted">我的订单</a> / <b>${esc(o.orderNo)}</b></div>
    <div class="panel">
      <div class="row-between"><h2 style="font-size:19px;margin:0">订单 ${esc(o.orderNo)} <span class="badge ${STATUS_TONE[o.status] ?? ''}">${esc(o.statusText)}</span></h2>
        <span class="dim">下单时间 ${esc(o.createdAt)}</span></div>
      <hr class="hr">
      ${items.map((i) => `<div class="citem"><div class="mini">${initial(i.name)}</div>
        <div><div class="nm">${esc(i.name)}</div><div class="dim">SKU ${esc(i.sku)} · ${money(i.price)} × ${i.qty}</div></div>
        <div class="sub">${money(i.subtotal)}</div></div>`).join('')}
      <div class="row-between" style="margin-top:16px"><span>合计</span><b style="color:var(--gold-2);font-size:20px">${money(o.total)}</b></div>
      <hr class="hr">
      <dl style="display:grid;grid-template-columns:96px 1fr;gap:7px 12px;color:var(--sub);font-size:13.5px;margin:0">
        <dt class="dim">收货人</dt><dd>${esc(o.receiver)} ${esc(o.phone)}</dd>
        <dt class="dim">地址 / 备注</dt><dd>${esc(o.remark || '—')}</dd>
        <dt class="dim">支付</dt><dd>${payment ? `${esc(payment.channel)} · ${esc(payment.status)}${payment.tradeNo ? ' · ' + esc(payment.tradeNo) : ''}` : '—'}</dd>
      </dl>
      <div class="row" style="margin-top:18px">
        ${o.status === 'pending' ? `<button class="btn-primary" id="dPay">模拟支付</button><button class="btn-ghost" id="dCancel">取消订单</button>` : ''}
        ${['paid', 'shipped', 'done'].includes(o.status) ? `<button class="btn-ghost" id="dReview">评价商品</button>` : ''}
        <a class="btn-ghost" href="#/orders">返回列表</a>
      </div>
    </div>`;
  $('dPay')?.addEventListener('click', async () => { try { await api(`/api/shop/orders/${o.id}/pay`, { method: 'POST' }); toast('支付成功（模拟）'); viewOrderDetail(orderNo); } catch (e) { toast(e.message); } });
  $('dCancel')?.addEventListener('click', async () => { try { await api(`/api/shop/orders/${o.id}/cancel`, { method: 'POST' }); toast('已取消'); viewOrderDetail(orderNo); } catch (e) { toast(e.message); } });
  // 评价：订单明细里的 SKU 是商品编码 → 用搜索接口反查商品 id → 提交评价
  $('dReview')?.addEventListener('click', async () => {
    const btn = $('dReview');
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      for (const it of items) {
        const found = await api('/api/shop/products?q=' + encodeURIComponent(it.sku));
        const target = found.rows && found.rows[0];
        if (!target) { toast('找不到商品 ' + it.sku + '，跳过'); continue }
        const rating = Number(prompt('给「' + it.name + '」打分（1-5）', '5') || 5);
        if (!Number.isFinite(rating) || rating < 1) continue;
        const content = prompt('写点评价（可留空）', '') ?? '';
        await api('/api/shop/reviews', { method: 'POST', body: { productId: target.id, orderId: o.id, rating: Math.min(5, Math.max(1, rating)), content } });
        toast('已提交「' + it.name + '」的评价');
      }
      viewOrderDetail(orderNo);
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '评价商品'; }
  });
}

// ────────── 账号 ──────────
async function viewAccount(hint) {
  main.innerHTML = `
    <div class="detail" style="grid-template-columns:minmax(0,420px) minmax(0,1fr)">
      <div class="panel">
        <h2 style="font-size:19px;margin:0 0 14px">登录 / 注册</h2>
        ${hint ? `<p class="muted" style="margin-top:0">${esc(hint)}</p>` : ''}
        <div class="stack">
          <input id="uName" placeholder="用户名（3-20 位字母数字下划线）" autocomplete="username">
          <input id="uPass" type="password" placeholder="密码（至少 8 位）" autocomplete="current-password">
          <input id="uNick" placeholder="昵称（注册时可选）">
          <div class="row">
            <button class="btn-primary" id="doLogin">登录</button>
            <button class="btn-ghost" id="doRegister">注册新账号</button>
          </div>
          <p class="muted" style="margin:0" id="accMsg"></p>
        </div>
      </div>
      <div class="panel">
        <h3 style="font-size:15px;margin:0 0 10px">为什么需要账号</h3>
        <p class="muted" style="margin:0 0 10px">购物车、收货地址、订单都是<b>按账号</b>存储的；账号体系与后台管理系统共用同一张 users 表，只是角色不同（customer / admin）。</p>
        <p class="muted" style="margin:0">演示环境请勿使用真实密码；后台管理员账号也可登录前台（用于自查）。</p>
      </div>
    </div>`;
  const run = async (fn) => {
    try { await fn(); } catch (e) { $('accMsg').textContent = e.message; }
  };
  $('doLogin').addEventListener('click', () => run(async () => {
    const r = await api('/api/shop/login', { method: 'POST', body: { username: $('uName').value, password: $('uPass').value } });
    state.user = r.user; toast('欢迎回来，' + r.user.nickname);
    await bootCart(); location.hash = '#/';
  }));
  $('doRegister').addEventListener('click', () => run(async () => {
    const r = await api('/api/shop/register', { method: 'POST', body: { username: $('uName').value, password: $('uPass').value, nickname: $('uNick').value } });
    state.user = { username: $('uName').value, nickname: $('uNick').value || $('uName').value };
    toast('注册成功，已自动登录');
    await bootCart(); location.hash = '#/';
  }));
}

// ────────── 路由 ──────────
function markNav(hash) {
  const map = { '#/': 0, '#/list': 1, '#/cart': 2, '#/orders': 3, '#/account': 4 };
  const key = hash.split('?')[0];
  document.querySelectorAll('#topNav .navbtn').forEach((a, i) => a.classList.toggle('on', map[key] === i));
}
/** 骨架屏：每次视图切换先占位，数据回来再替换（比"正在加载…"体面，也避免布局跳动） */
function skeleton(kind) {
  if (kind === 'detail') {
    main.innerHTML = `<div class="detail">
      <div class="skel skel-big"></div>
      <div><div class="skel skel-title"></div><div class="skel skel-line"></div><div class="skel skel-line" style="width:60%"></div><div class="skel skel-block"></div></div>
    </div>`;
    return;
  }
  main.innerHTML = `<div class="skel-wrap">
    <div class="skel skel-title"></div><div class="skel skel-line"></div>
    <div class="skel-grid">${Array.from({ length: 6 }, () => '<div class="skel skel-card"></div>').join('')}</div>
  </div>`;
}

async function route() {
  const hash = location.hash || '#/';
  const [path, query] = hash.slice(1).split('?');
  markNav(hash);
  skeleton(path.startsWith('/p/') ? 'detail' : 'list');
  try {
    if (path.startsWith('/p/')) await viewProduct(path.slice(3));
    else if (path === '/list') await viewList(query ?? '');
    else if (path === '/cart') await viewCart();
    else if (path === '/checkout') await viewCheckout();
    else if (path === '/orders') await viewOrders();
    else if (path.startsWith('/order/')) await viewOrderDetail(decodeURIComponent(path.slice(7)));
    else if (path === '/account') await viewAccount();
    else await viewHome();
  } catch (e) {
    main.innerHTML = `<div class="empty-state"><b>出错了</b>${esc(e.message)}</div>`;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 委托：卡片加购（踩过的坑——原来只在详情页绑了事件，列表卡片上的按钮点了没反应也不报错）
main.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  e.preventDefault();
  b.disabled = true;
  await addToCart(Number(b.dataset.add), 1);
  b.disabled = false;
});

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  location.hash = '#/list?q=' + encodeURIComponent($('q').value.trim());
});
$('navAccount').addEventListener('click', (e) => {
  if (state.user) { e.preventDefault(); if (confirm('退出登录？')) logout(); }
});

async function logout() {
  await api('/api/shop/logout', { method: 'POST' }).catch(() => {});
  state.user = null; state.cart = null; renderCartBadge();
  $('navAccount').textContent = '登录';
  toast('已退出登录'); location.hash = '#/';
}
async function bootCart() {
  $('navAccount').textContent = state.user ? (state.user.nickname || state.user.username) + ' · 退出' : '登录';
  try { state.cart = await api('/api/shop/cart'); } catch { state.cart = null; }
  renderCartBadge();
}
window.addEventListener('hashchange', route);
(async () => {
  try { const me = await api('/api/shop/me'); state.user = me.user; } catch {}
  await bootCart();
  await route();
})();
