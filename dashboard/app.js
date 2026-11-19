// Token Radar dashboard — reads window.RADAR (written by main.ts) and
// renders the board, the live-token view, and one detail drawer per row.
// The drawer re-prices the protocol from the live comps with the same
// kernel the model uses, so the number it shows is recomputed in the page,
// not copied from the board: when it matches, the drawer says so.

(function () {
  var D = window.RADAR;
  var root = document.getElementById('board');
  root.setAttribute('aria-busy', 'false');

  var money = function (n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  };
  var moneyShort = function (n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(n / 1e3) + 'k';
  };
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var bySlug = {};
  D.rows.forEach(function (r) { bySlug[r.slug] = r; });

  // The kernel, mirrored from the model: Gaussian on ln(TVL) distance,
  // bandwidth 1.0, same-category comps weigh 1.0, others 0.35.
  function kernelMultiple(row) {
    var q = Math.log(row.tvl_usd);
    var pts = D.comps.map(function (c) {
      var d = q - Math.log(c.tvl_usd);
      var w = Math.exp(-(d * d) / 2) * (c.category === row.category ? 1.0 : 0.35);
      return { logRatio: Math.log(c.mcap_usd / c.tvl_usd), weight: w };
    }).sort(function (a, b) { return a.logRatio - b.logRatio; });
    var total = pts.reduce(function (s, p) { return s + p.weight; }, 0);
    var acc = 0;
    for (var i = 0; i < pts.length; i++) {
      acc += pts[i].weight;
      if (acc >= total / 2) return Math.exp(pts[i].logRatio);
    }
    return 0.25;
  }

  function growthMult(row) {
    var g = row.change_7d === null ? 0 : Math.min(120, Math.max(-60, row.change_7d));
    return 1 + (g / 100) * 0.5;
  }
  function maturityMult(row) {
    var age = row.age_days === null ? 365 : row.age_days;
    return 0.6 + (Math.min(age, 1095) / 1095) * 0.4;
  }
  function recomputed(row) {
    var mult = Math.min(5, Math.max(0.02, kernelMultiple(row)));
    return Math.max(1, Math.round(row.tvl_usd * mult * growthMult(row) * maturityMult(row)));
  }

  var state = { tab: 'board', watchOnly: false, query: '', cat: '', sort: 'rank', dir: 1 };
  var cats = [];
  D.rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();

  function visibleRows() {
    var rows = D.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.query) {
        var q = state.query.toLowerCase();
        if (r.slug.indexOf(q) < 0 && r.name.toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    rows.sort(function (a, b) {
      var d = 0;
      if (key === 'rank') d = a.rank - b.rank;
      else if (key === 'implied') d = b.implied_value_usd - a.implied_value_usd;
      else if (key === 'tvl') d = b.tvl_usd - a.tvl_usd;
      else if (key === 'multiple') d = b.multiple - a.multiple;
      else if (key === 'age') d = (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days);
      return d * state.dir;
    });
    return rows;
  }

  function sortBtn(label, key) {
    var arrow = state.sort === key ? (state.dir === 1 ? ' ▲' : ' ▼') : '';
    return '<button data-sort="' + key + '">' + label + arrow + '</button>';
  }

  function render() {
    var v = D.validation;
    var html = '<div class="wrap">';
    html += '<header class="top"><h1>Token Radar: <em>what would the token be worth?</em></h1>';
    html += '<p class="lede">The watchlist is the floor: every protocol with at least <b>' + money(D.floor_usd) + '</b> of TVL and no token on record. '
      + 'The early radar adds <b>' + D.early_size + ' rankable pre-token protocols</b> below that floor, every other rankable one the snapshot records. '
      + D.excluded_pre_token + ' of the ' + D.pre_token_total + ' pre-token records are set aside as wrapped, staked, bridged or versioned products. '
      + 'Implied value is a model, not a promise.</p></header>';
    html += '<div class="stats">'
      + '<div class="stat"><div class="n">' + D.board_size + '</div><div class="l">Ranked protocols</div></div>'
      + '<div class="stat"><div class="n">' + D.watchlist_size + '</div><div class="l">Watchlist</div></div>'
      + '<div class="stat"><div class="n">' + D.live_total + '</div><div class="l">Live-token comps</div></div>'
      + '<div class="stat"><div class="n">' + esc(D.rows[0].name) + '</div><div class="l">Rank 1 · ' + moneyShort(D.rows[0].implied_value_usd) + '</div></div>'
      + '</div>';
    html += '<section class="panel"><h2>How the number is made — model ' + esc(D.model_version) + '</h2>'
      + '<p>Implied value = TVL × <code>multiple</code> × growth × maturity. The multiple is the kernel-weighted median of '
      + 'log(market cap / TVL) over the ' + v.comps + ' live-token comps: a Gaussian kernel on log-TVL distance (bandwidth 1.0), '
      + 'same-category comps weigh 1.0, others 0.35, clamped to [0.02, 5.0]. Growth is 1 + clamped 7-day change × 0.5; '
      + 'maturity is 0.6 + up to 0.4 for three years running with no token. No protocol name is special-cased.</p>'
      + '<p><b>Out-of-sample check, leave-one-out over the ' + v.comps + ' comps.</b> Full board formula (clamp, growth and maturity included — '
      + 'the formula the board actually uses): median absolute log error <b>' + v.fullFormula.medianAbsLogError + '</b> (' + v.fullFormula.medianAbsPctError + '%), '
      + 'against a flat 0.25× baseline of ' + v.fullFormula.baselineMedianAbsLogError + ' (' + v.fullFormula.baselineMedianAbsPctError + '%); '
      + 'the kernel wins ' + v.fullFormula.wins + ' of ' + v.comps + ' hold-outs. The multiple alone scores '
      + v.multipleOnly.medianAbsLogError + ' (' + v.multipleOnly.medianAbsPctError + '%) against a baseline of '
      + v.multipleOnly.baselineMedianAbsLogError + ' — that is the multiple\'s check, not the whole model\'s.</p>'
      + '<p>Error is wide: a median miss near 3× either way is normal for this ratio. Read the range on each row, not just the point value.</p></section>';
    html += '<div class="tabs" role="tablist">'
      + '<button role="tab" aria-selected="' + (state.tab === 'board') + '" data-tab="board">Board · ' + D.board_size + '</button>'
      + '<button role="tab" aria-selected="' + (state.tab === 'live') + '" data-tab="live">Live-token protocols shown · ' + D.live_shown + ' of ' + D.live_total + '</button>'
      + '</div>';
    if (state.tab === 'board') {
      html += '<div class="controls"><input type="search" id="q" placeholder="Search name or slug…" value="' + esc(state.query) + '">'
        + '<select id="cat"><option value="">All categories</option>'
        + cats.map(function (c) { return '<option' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('')
        + '</select>'
        + '<label class="toggle"><input type="checkbox" id="watch" ' + (state.watchOnly ? 'checked' : '') + '> Watchlist only</label>'
        + '<span class="count" id="count"></span></div>';
      html += '<table class="board"><thead><tr><th>' + sortBtn('Rank', 'rank') + '</th><th>Protocol</th>'
        + '<th class="num">' + sortBtn('Implied value', 'implied') + '</th><th class="num">' + sortBtn('TVL', 'tvl') + '</th>'
        + '<th class="num">' + sortBtn('Multiple', 'multiple') + '</th><th class="num">' + sortBtn('Age', 'age') + '</th></tr></thead><tbody id="rows"></tbody></table>';
    } else {
      html += '<section class="panel note"><p>These protocols already have a token, so the board does not rank them: their market cap is the market\'s own number, not a model\'s. '
        + 'They are the comparison set the model is fitted on — the top ' + D.live_shown + ' of ' + D.live_total + ' by market cap.</p></section>';
      html += '<table class="board"><thead><tr><th>Protocol</th><th class="num">Market cap</th><th class="num">TVL</th><th class="num">Mcap / TVL</th></tr></thead><tbody>';
      D.live.forEach(function (p) {
        html += '<tr><td><b>' + esc(p.name) + '</b><div class="cat">' + esc(p.category || '—') + ' · ' + esc(p.chains.join(', ')) + '</div></td>'
          + '<td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + moneyShort(p.tvl_usd) + '</td>'
          + '<td class="num">' + (p.mcap_usd / p.tvl_usd).toFixed(2) + '×</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '<footer>Snapshot ' + esc(D.as_of) + ' · ' + esc(D.source) + ' · ' + D.board_size + ' rows · model ' + esc(D.model_version)
      + ' · each farm plan is generated from the protocol\'s own record and promises no airdrop or reward.</footer>';
    html += '</div><div id="drawer-host"></div>';
    root.innerHTML = html;
    bind();
    if (state.tab === 'board') paintRows();
  }

  function paintRows() {
    var rows = visibleRows();
    var tb = document.getElementById('rows');
    var count = document.getElementById('count');
    if (count) count.textContent = rows.length + ' rows shown';
    tb.innerHTML = rows.map(function (r) {
      var age = r.age_days === null ? '—' : (r.age_days >= 365 ? (r.age_days / 365).toFixed(1) + 'y' : r.age_days + 'd');
      return '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td>'
        + '<td><b>' + esc(r.name) + '</b>' + (r.watchlist ? '<span class="badge">watchlist</span>' : '')
        + '<div class="cat">' + esc(r.category || '—') + ' · ' + esc(r.chains.join(', ')) + '</div></td>'
        + '<td class="num"><b>' + money(r.implied_value_usd) + '</b><div class="range">' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</div></td>'
        + '<td class="num">' + moneyShort(r.tvl_usd) + '</td>'
        + '<td class="num">' + r.multiple.toFixed(4) + '×</td>'
        + '<td class="num">' + age + '</td></tr>';
    }).join('');
  }

  function openDrawer(slug) {
    var r = bySlug[slug];
    if (!r) return;
    var again = recomputed(r);
    var same = again === r.implied_value_usd;
    var age = r.age_days === null ? 'not listed' : r.age_days + ' days';
    var host = document.getElementById('drawer-host');
    var h = '<aside class="drawer" role="dialog" aria-label="Detail for ' + esc(r.name) + '">'
      + '<button class="close" id="close-drawer">Close ×</button>'
      + '<h2>' + esc(r.name) + '</h2>'
      + '<p class="sub">Rank ' + r.rank + ' of ' + D.board_size + (r.watchlist ? ' · on the watchlist' : ' · early radar') + ' · ' + esc(r.category || '—') + ' · ' + esc(r.chains.join(', ')) + '</p>'
      + '<dl><dt>Implied value</dt><dd><b>' + money(r.implied_value_usd) + '</b></dd>'
      + '<dt>Range</dt><dd>' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</dd>'
      + '<dt>TVL</dt><dd>' + money(r.tvl_usd) + '</dd>'
      + '<dt>Multiple</dt><dd>' + r.multiple.toFixed(4) + '×</dd>'
      + '<dt>Growth ×</dt><dd>' + r.growth_multiplier.toFixed(4) + '</dd>'
      + '<dt>Maturity ×</dt><dd>' + r.maturity_multiplier.toFixed(4) + '</dd>'
      + '<dt>Age</dt><dd>' + age + '</dd>'
      + '<dt>7-day TVL change</dt><dd>' + (r.change_7d === null ? 'not reported' : r.change_7d + '%') + '</dd></dl>'
      + '<h3>Nearest live comps</h3><p>' + r.nearest_comps.map(function (c) { return esc(c.name) + ' (' + c.multiple.toFixed(2) + '×)'; }).join(', ') + '</p>'
      + '<h3>Recomputed in this page</h3><p>The drawer re-prices this protocol from the live comps with the same kernel and gets <b>' + money(again) + '</b> — '
      + (same ? '<span class="same">the same number board.json carries.</span>' : '<span>different from board.json (' + money(r.implied_value_usd) + ').</span>') + '</p>'
      + '<h3>Farm plan — 6 steps</h3><ol>'
      + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('')
      + '</ol></aside>';
    host.innerHTML = h;
    document.getElementById('close-drawer').addEventListener('click', function () { host.innerHTML = ''; });
  }

  function bind() {
    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); render(); });
    });
    root.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = 1; }
        render();
      });
    });
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.query = q.value; paintRows(); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.cat = cat.value; paintRows(); });
    var w = document.getElementById('watch');
    if (w) w.addEventListener('change', function () { state.watchOnly = w.checked; paintRows(); });
    // Delegated: paintRows() rewrites the rows, so per-row listeners set
    // here would be destroyed by the next repaint. One listener on the
    // root survives every repaint.
    if (!root._drawerBound) {
      root._drawerBound = true;
      root.addEventListener('click', function (e) {
        var tr = e.target && e.target.closest ? e.target.closest('tr[data-slug]') : null;
        if (tr) openDrawer(tr.getAttribute('data-slug'));
      });
    }
  }

  render();
  window.RADAR_READY = true;
})();
