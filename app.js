(async function(){
  "use strict";

  // ---------- Load external JSON data ----------
  async function loadJson(path){
    const response = await fetch(path);
    if(!response.ok) throw new Error(`Gagal memuat ${path}: HTTP ${response.status}`);
    return response.json();
  }

  const [MEI, JUN, JUL] = await Promise.all([
    loadJson('data-mei2026.json'),
    loadJson('data-jun.json'),
    loadJson('data-jul.json')
  ]);
  // fields: t=ticker, i=issuer, n=investor name, c=classification, lf=local/foreign, sh=shares, p=percentage

  // ---------- Name normalization (mirrors the offline analysis) ----------
  function normalize(name){
    if(!name) return '';
    let n = String(name).toUpperCase();
    n = n.replace(/\(.*?\)/g, '');
    n = n.replace(/[.,]/g, '');
    n = n.replace(/\bTBK\b/g, '');
    n = n.replace(/\bPT\b/g, '');
    n = n.replace(/\bPERSERO\b/g, '');
    n = n.replace(/\s+/g, ' ').trim();
    return n;
  }

  // ---------- Build lookup structures ----------
  // by ticker -> array of rows
  const meiByTicker = {};
  const junByTicker = {};
  const julByTicker = {};
  const allTickers = new Set();
  const issuerByTicker = {};

  MEI.forEach(r => {
    r.norm = normalize(r.n);
    (meiByTicker[r.t] = meiByTicker[r.t] || []).push(r);
    allTickers.add(r.t);
    issuerByTicker[r.t] = r.i;
  });
  JUN.forEach(r => {
    r.norm = normalize(r.n);
    (junByTicker[r.t] = junByTicker[r.t] || []).push(r);
    allTickers.add(r.t);
    issuerByTicker[r.t] = r.i;
  });
  JUL.forEach(r => {
    r.norm = normalize(r.n);
    (julByTicker[r.t] = julByTicker[r.t] || []).push(r);
    allTickers.add(r.t);
    issuerByTicker[r.t] = r.i;
  });

  // Investor index: normalized name -> list of {t, mei_row, jun_row, jul_row}
  // We'll compute per-ticker diffs on demand and cache.
  const diffCache = {};

  function periodStatus(previous, current, renamed){
    if(renamed) return 'ganti_nama';
    if(previous && current){
      const delta = +(current.p - previous.p).toFixed(2);
      return Math.abs(delta) < 0.005 ? 'tetap' : (delta > 0 ? 'naik' : 'turun');
    }
    if(!previous && current) return 'baru';
    if(previous && !current) return 'keluar';
    return null;
  }

  function periodDelta(previous, current){
    return previous && current ? +(current.p - previous.p).toFixed(2) : null;
  }

  function uniqueSamePercentage(rows, percentage, usedNorms){
    const candidates = rows.filter(r =>
      !usedNorms.has(r.norm) && r.p.toFixed(2) === percentage.toFixed(2)
    );
    return candidates.length === 1 ? candidates[0] : null;
  }

  function getTickerDiff(ticker){
    if(diffCache[ticker]) return diffCache[ticker];
    const meiRows = (meiByTicker[ticker] || []).slice().sort((a,b)=>b.p-a.p);
    const junRows = (junByTicker[ticker] || []).slice().sort((a,b)=>b.p-a.p);
    const julRows = (julByTicker[ticker] || []).slice().sort((a,b)=>b.p-a.p);
    const meiByNorm = {};
    const junByNorm = {};
    meiRows.forEach(r => meiByNorm[r.norm] = r);
    junRows.forEach(r => junByNorm[r.norm] = r);
    const usedJunNorms = new Set();
    const entities = [];

    // Bentuk entitas utama dari Juli, lalu cocokkan ke Juni.
    julRows.forEach(jul => {
      let jun = junByNorm[jul.norm] || null;
      let renamedJunJul = false;
      if(!jun){
        jun = uniqueSamePercentage(junRows, jul.p, usedJunNorms);
        renamedJunJul = Boolean(jun);
      }
      if(jun) usedJunNorms.add(jun.norm);
      entities.push({ jul, jun, may:null, renamedJunJul, renamedMayJun:false });
    });

    // Investor yang masih ada di Juni tetapi tidak ada di Juli.
    junRows.forEach(jun => {
      if(!usedJunNorms.has(jun.norm)){
        usedJunNorms.add(jun.norm);
        entities.push({ jul:null, jun, may:null, renamedJunJul:false, renamedMayJun:false });
      }
    });

    // Cocokkan setiap entitas ke data Mei.
    const usedMeiNorms = new Set();
    entities.forEach(entity => {
      const referenceNorm = entity.jun ? entity.jun.norm : entity.jul.norm;
      let may = meiByNorm[referenceNorm] || null;
      if(may && usedMeiNorms.has(may.norm)) may = null;
      if(!may && entity.jun){
        may = uniqueSamePercentage(meiRows, entity.jun.p, usedMeiNorms);
        entity.renamedMayJun = Boolean(may);
      }
      if(may){
        usedMeiNorms.add(may.norm);
        entity.may = may;
      }
    });

    // Investor yang hanya tercatat pada Mei tetap ditampilkan sebagai riwayat.
    meiRows.forEach(may => {
      if(!usedMeiNorms.has(may.norm)){
        entities.push({ jul:null, jun:null, may, renamedJunJul:false, renamedMayJun:false });
      }
    });

    const merged = entities.map(entity => {
      const display = entity.jul || entity.jun || entity.may;
      const deltaMayJun = periodDelta(entity.may, entity.jun);
      const deltaJunJul = periodDelta(entity.jun, entity.jul);
      const statusMayJun = periodStatus(entity.may, entity.jun, entity.renamedMayJun);
      const statusJunJul = periodStatus(entity.jun, entity.jul, entity.renamedJunJul);
      return {
        name: display.n,
        classification: display.c,
        lf: display.lf,
        mayPct: entity.may ? entity.may.p : null,
        junPct: entity.jun ? entity.jun.p : null,
        julPct: entity.jul ? entity.jul.p : null,
        deltaMayJun,
        deltaJunJul,
        statusMayJun,
        statusJunJul,
        // Alias berikut mempertahankan kompatibilitas ringkasan/screening terbaru.
        delta: deltaJunJul,
        status: statusJunJul,
        shares: display.sh
      };
    });

    merged.sort((a,b) =>
      (b.julPct ?? b.junPct ?? b.mayPct ?? -1) -
      (a.julPct ?? a.junPct ?? a.mayPct ?? -1)
    );
    const result = { ticker, issuer: issuerByTicker[ticker], rows: merged };
    diffCache[ticker] = result;
    return result;
  }

  // ---------- Precompute market-wide movers (for ticker tape + overview) ----------
  let marketStats = null;
  function computeMarketStats(){
    if(marketStats) return marketStats;
    let newCount=0, exitCount=0, changedCount=0;
    const bigNew = [], bigExit = [], bigChange = [];
    allTickers.forEach(t => {
      const d = getTickerDiff(t);
      d.rows.forEach(r => {
        if(r.status==='baru'){ newCount++; bigNew.push({t, issuer:d.issuer, name:r.name, pct:r.julPct}); }
        else if(r.status==='keluar'){ exitCount++; bigExit.push({t, issuer:d.issuer, name:r.name, pct:r.junPct}); }
        else if((r.status==='naik'||r.status==='turun') && Math.abs(r.delta) >= 0.5){
          changedCount++; bigChange.push({t, issuer:d.issuer, name:r.name, delta:r.delta, julPct:r.julPct});
        }
      });
    });
    bigNew.sort((a,b)=>b.pct-a.pct);
    bigExit.sort((a,b)=>b.pct-a.pct);
    bigChange.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
    marketStats = {
      newCount, exitCount, changedCount,
      newTickers: [...allTickers].filter(t=>!junByTicker[t] && julByTicker[t]).sort(),
      goneTickers: [...allTickers].filter(t=>junByTicker[t] && !julByTicker[t]).sort(),
      bigNew, bigExit, bigChange
    };
    return marketStats;
  }

  // ---------- Per-ticker screening aggregates ----------
  let screenData = null;
  function computeScreenData(){
    if(screenData) return screenData;
    screenData = [...allTickers].map(t => {
      const d = getTickerDiff(t);
      let newC=0, upC=0, downC=0, exitC=0, flatC=0;
      d.rows.forEach(r=>{
        if(r.status==='baru') newC++;
        else if(r.status==='keluar') exitC++;
        else if(r.status==='naik') upC++;
        else if(r.status==='turun') downC++;
        else flatC++;
      });
      return {
        ticker:t, issuer:d.issuer,
        newC, upC, downC, exitC, flatC,
        totalHolders: d.rows.filter(r=>r.julPct!=null).length
      };
    });
    return screenData;
  }

  const SCREEN_COLS = [
    { key:'newC',   label:'Investor Baru',    cls:'cell-new'  },
    { key:'upC',    label:'Nambah Kepemilikan', cls:'cell-up'   },
    { key:'downC',  label:'Kurangi Kepemilikan', cls:'cell-down' },
    { key:'exitC',  label:'Investor Keluar',  cls:'cell-exit' },
    { key:'totalHolders', label:'Total Pemegang &gt;1%', cls:'', hideMobile:true },
  ];
  let screenSortKey = 'newC';
  let screenSortDir = 'desc';
  let screenShowAll = false;

  // ---------- Rendering helpers ----------
  const mainArea = document.getElementById('mainArea');
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearBtn');
  const hintRow = document.getElementById('hintRow');
  const tabBtns = document.querySelectorAll('.tab-btn');
  let mode = 'saham';

  function fmtPct(p){ return p==null ? '—' : p.toFixed(2)+'%'; }
  function fmtDelta(d){
    if(d==null) return '';
    const sign = d>0 ? '+' : '';
    return sign+d.toFixed(2)+' pp';
  }
  function deltaClass(d){
    if(d==null) return 'delta-flat';
    if(Math.abs(d) < 0.005) return 'delta-flat';
    return d>0 ? 'delta-up' : 'delta-down';
  }
  function statusChip(status){
    switch(status){
      case 'baru': return '<span class="status-chip status-baru">BARU</span>';
      case 'keluar': return '<span class="status-chip status-keluar">KELUAR</span>';
      case 'naik': return '<span class="status-chip status-naik">▲ naik</span>';
      case 'turun': return '<span class="status-chip status-turun">▼ turun</span>';
      case 'ganti_nama': return '<span class="status-chip status-tetap">ganti nama</span>';
      case 'tetap': return '<span class="status-chip status-tetap">tetap</span>';
      default: return '<span class="status-chip status-tetap">—</span>';
    }
  }

  function transitionCell(delta, status){
    if(!status) return statusChip(null);
    if(status==='baru' || status==='keluar' || status==='ganti_nama'){
      return statusChip(status);
    }
    return fmtDelta(delta)+' '+statusChip(status);
  }

  function renderTickerCard(ticker){
    const d = getTickerDiff(ticker);
    if(!d.rows.length) return '';
    const newN = d.rows.filter(r=>r.statusJunJul==='baru').length;
    const exitN = d.rows.filter(r=>r.statusJunJul==='keluar').length;
    let badges = '';
    if(newN) badges += `<span class="badge badge-new">+${newN} BARU DI JULI</span>`;
    if(exitN) badges += `<span class="badge badge-exit">-${exitN} KELUAR DI JULI</span>`;

    let rows = d.rows.map(r => {
      const rowClass = r.statusJunJul==='baru' ? 'row-new' : (r.statusJunJul==='keluar' ? 'row-exit' : '');
      return `<tr class="${rowClass}">
        <td><div class="r-name">${escapeHtml(r.name)}</div></td>
        <td class="r-class">${escapeHtml(r.classification||'—')}${r.lf?` &middot; ${r.lf==='L'?'Lokal':'Asing'}`:''}</td>
        <td class="r-pct">${fmtPct(r.mayPct)}</td>
        <td class="r-pct">${fmtPct(r.junPct)}</td>
        <td class="r-pct">${fmtPct(r.julPct)}</td>
        <td class="r-delta ${deltaClass(r.deltaMayJun)}">${transitionCell(r.deltaMayJun, r.statusMayJun)}</td>
        <td class="r-delta ${deltaClass(r.deltaJunJul)}">${transitionCell(r.deltaJunJul, r.statusJunJul)}</td>
      </tr>`;
    }).join('');

    return `<div class="result-card">
      <div class="result-head">
        <div>
          <div class="rh-ticker">${ticker}</div>
          <div class="rh-issuer">${escapeHtml(d.issuer||'')}</div>
        </div>
        <div class="rh-badges">${badges}</div>
      </div>
      <div style="overflow-x:auto;">
      <table class="hold-table">
        <thead><tr>
          <th>Investor</th><th class="r-class">Klasifikasi</th><th style="text-align:right">Mei 2026</th><th style="text-align:right">Juni 2026</th><th style="text-align:right">Juli 2026</th><th style="text-align:right">Mei→Juni</th><th style="text-align:right">Juni→Juli</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>`;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderOverview(){
    const s = computeMarketStats();
    const tickerCount = allTickers.size;
    let html = `
      <div class="section-title">Ringkasan Periode Terbaru (Juni → Juli 2026)</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${tickerCount}</div><div class="stat-label">Total saham tercakup</div></div>
        <div class="stat-card"><div class="stat-num gold">${s.newCount}</div><div class="stat-label">Investor baru (&gt;1%)</div></div>
        <div class="stat-card"><div class="stat-num neg">${s.exitCount}</div><div class="stat-label">Investor keluar</div></div>
        <div class="stat-card"><div class="stat-num">${s.changedCount}</div><div class="stat-label">Perubahan signifikan (&ge;0.5pp)</div></div>
      </div>
      <div class="section-title">Pergerakan Terbesar</div>
      <div class="mover-grid">
        <div class="mover-card new">
          <h3>⬤ Investor Baru Terbesar</h3>
          ${s.bigNew.slice(0,8).map(m=>`
            <div class="mover-row" data-ticker="${m.t}">
              <div class="mover-left">
                <div class="mover-ticker">${m.t}</div>
                <div class="mover-name">${escapeHtml(m.name)}</div>
              </div>
              <div class="mover-pct" style="color:var(--positive)">${fmtPct(m.pct)}</div>
            </div>`).join('')}
        </div>
        <div class="mover-card exit">
          <h3>⬤ Investor Keluar Terbesar</h3>
          ${s.bigExit.slice(0,8).map(m=>`
            <div class="mover-row" data-ticker="${m.t}">
              <div class="mover-left">
                <div class="mover-ticker">${m.t}</div>
                <div class="mover-name">${escapeHtml(m.name)}</div>
              </div>
              <div class="mover-pct" style="color:var(--negative)">${fmtPct(m.pct)}</div>
            </div>`).join('')}
        </div>
      </div>
      ${s.newTickers.length ? `
      <div class="section-title">Saham Baru Muncul di Juli</div>
      <div class="mover-card new">
        ${s.newTickers.map(t=>`
          <div class="mover-row" data-ticker="${t}">
            <div class="mover-left">
              <div class="mover-ticker">${t}</div>
              <div class="mover-name">${escapeHtml(issuerByTicker[t]||'')}</div>
            </div>
            <div class="mover-pct" style="color:var(--gold)">lihat →</div>
          </div>`).join('')}
      </div>` : ''}
      <p class="foot-note">Tabel detail menampilkan data berurutan dari Mei, Juni, lalu Juli 2026. Ringkasan, screening, dan ticker pergerakan menggunakan perbandingan periode terbaru, yaitu Juni → Juli 2026. Nama investor dinormalisasi (menghapus "PT", "Tbk", tanda baca, dan kata dalam kurung) agar variasi penulisan nama tidak keliru dihitung sebagai investor baru. Data: KSEI, pemegang saham &gt;1%, Mei–Juli 2026.</p>
    `;
    mainArea.innerHTML = html;
    mainArea.querySelectorAll('.mover-row[data-ticker]').forEach(el=>{
      el.addEventListener('click', ()=>{
        searchInput.value = el.getAttribute('data-ticker');
        mode = 'saham';
        setActiveTab();
        runSearch();
      });
    });
  }

  function renderTickerResults(query){
    const q = query.trim().toUpperCase();
    let matches = [...allTickers].filter(t => t.includes(q) || (issuerByTicker[t]||'').toUpperCase().includes(q));
    matches.sort((a,b)=>{
      const aExact = a===q ? 0 : 1, bExact = b===q ? 0 : 1;
      if(aExact!==bExact) return aExact-bExact;
      return a.localeCompare(b);
    });
    if(!matches.length){
      mainArea.innerHTML = emptyState('Tidak ada saham yang cocok dengan "'+escapeHtml(query)+'".');
      return;
    }
    matches = matches.slice(0, 25);
    mainArea.innerHTML = `<div class="section-title">${matches.length} saham ditemukan</div>` + matches.map(renderTickerCard).join('');
  }

  function renderInvestorResults(query){
    const q = normalize(query);
    if(!q){
      mainArea.innerHTML = emptyState('Ketik nama investor untuk mulai pencarian, mis. "TASPEN" atau "BAKRIE".');
      return;
    }
    // gather all normalized names matching across all three months
    const namesMap = {}; // norm -> display name
    MEI.forEach(r=>{ if(r.norm.includes(q)) namesMap[r.norm]=r.n; });
    JUN.forEach(r=>{ if(r.norm.includes(q)) namesMap[r.norm]=r.n; });
    JUL.forEach(r=>{ if(r.norm.includes(q)) namesMap[r.norm]=r.n; });
    const normNames = Object.keys(namesMap);
    if(!normNames.length){
      mainArea.innerHTML = emptyState('Tidak ada investor yang cocok dengan "'+escapeHtml(query)+'".');
      return;
    }
    let html = `<div class="section-title">${normNames.length} investor cocok</div>`;
    normNames.slice(0,15).forEach(norm=>{
      const meiRows = MEI.filter(r=>r.norm===norm);
      const junRows = JUN.filter(r=>r.norm===norm);
      const julRows = JUL.filter(r=>r.norm===norm);
      const tickers = new Set([
        ...meiRows.map(r=>r.t),
        ...junRows.map(r=>r.t),
        ...julRows.map(r=>r.t)
      ]);
      const rows = [...tickers].sort().map(t=>{
        const mr = meiRows.find(r=>r.t===t);
        const jr = junRows.find(r=>r.t===t);
        const jl = julRows.find(r=>r.t===t);
        const statusMayJun = periodStatus(mr, jr, false);
        const statusJunJul = periodStatus(jr, jl, false);
        const latestStatus = statusJunJul || statusMayJun;
        return `<div class="investor-ticker-row" data-ticker="${t}">
          <div>
            <div class="mover-ticker">${t}</div>
            <div class="mover-name" style="max-width:100%">${escapeHtml(issuerByTicker[t]||'')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:14px;">
            <span class="r-pct" style="font-family:var(--font-mono)">${fmtPct(mr?mr.p:null)} → ${fmtPct(jr?jr.p:null)} → ${fmtPct(jl?jl.p:null)}</span>
            ${statusChip(latestStatus)}
          </div>
        </div>`;
      }).join('');
      html += `<div class="result-card">
        <div class="result-head"><div><div class="rh-ticker" style="font-size:16px;">${escapeHtml(namesMap[norm])}</div>
        <div class="rh-issuer">terdaftar sebagai pemegang &gt;1% di ${tickers.size} saham</div></div></div>
        ${rows}
      </div>`;
    });
    mainArea.innerHTML = html;
    mainArea.querySelectorAll('.investor-ticker-row[data-ticker]').forEach(el=>{
      el.addEventListener('click', ()=>{
        searchInput.value = el.getAttribute('data-ticker');
        mode='saham'; setActiveTab(); runSearch();
      });
    });
  }

  function emptyState(msg){
    return `<div class="empty-state">
      <img class="empty-icon" src="search.svg" alt="" width="40" height="40">
      <p>${msg}</p>
    </div>`;
  }

  function setActiveTab(){
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.mode===mode));
    if(mode==='saham') searchInput.placeholder = 'Ketik kode saham, mis. BBCA, AWAN, PKPK...';
    else if(mode==='investor') searchInput.placeholder = 'Ketik nama investor, mis. TASPEN, BAKRIE...';
    else searchInput.placeholder = 'Filter kode saham atau nama emiten (opsional)...';
    renderHints();
  }

  function renderHints(){
    if(mode==='screening'){
      const opts = [
        {label:'Investor baru terbanyak', key:'newC'},
        {label:'Paling banyak nambah kepemilikan', key:'upC'},
        {label:'Paling banyak kurangi kepemilikan', key:'downC'},
        {label:'Investor keluar terbanyak', key:'exitC'},
      ];
      hintRow.innerHTML = opts.map(o=>`<span class="hint-chip" data-key="${o.key}">${o.label}</span>`).join('');
      hintRow.querySelectorAll('.hint-chip').forEach(el=>{
        el.addEventListener('click', ()=>{
          screenSortKey = el.dataset.key; screenSortDir = 'desc'; screenShowAll = false;
          runSearch();
        });
      });
      return;
    }
    const chips = mode==='saham'
      ? ['AWAN','PKPK','DATA','BNBR','MAPI','BACH']
      : ['TASPEN','BAKRIE','VICTORIA','SAMUEL TUMBUH BERSAMA'];
    hintRow.innerHTML = chips.map(c=>`<span class="hint-chip" data-val="${c}">${c}</span>`).join('');
    hintRow.querySelectorAll('.hint-chip').forEach(el=>{
      el.addEventListener('click', ()=>{ searchInput.value = el.dataset.val; runSearch(); });
    });
  }

  function runSearch(){
    const q = searchInput.value.trim();
    if(mode==='screening'){ renderScreening(q); return; }
    if(!q){ renderOverview(); return; }
    if(mode==='saham') renderTickerResults(q);
    else renderInvestorResults(q);
  }

  function renderScreening(filterQuery){
    let rows = computeScreenData();
    const q = (filterQuery||'').trim().toUpperCase();
    if(q){
      rows = rows.filter(r => r.ticker.includes(q) || (r.issuer||'').toUpperCase().includes(q));
    }
    rows = rows.slice().sort((a,b)=>{
      const diff = (b[screenSortKey] - a[screenSortKey]);
      return screenSortDir==='desc' ? diff : -diff;
    });
    const total = rows.length;
    const shown = screenShowAll ? rows : rows.slice(0, 50);

    const headHtml = SCREEN_COLS.map(c => {
      const sorted = c.key===screenSortKey;
      const arrow = sorted ? (screenSortDir==='desc' ? '▼' : '▲') : '';
      return `<th data-key="${c.key}" class="${sorted?'sorted':''}${c.hideMobile?' th-hide-mobile':''}">${c.label}<span class="arrow">${arrow}</span></th>`;
    }).join('');

    const bodyHtml = shown.map(r => {
      const cells = SCREEN_COLS.map(c=>{
        const val = r[c.key];
        const cellCls = val>0 ? c.cls : 'cell-zero';
        return `<td class="${cellCls}${c.hideMobile?' td-hide-mobile':''}">${val}</td>`;
      }).join('');
      return `<tr data-ticker="${r.ticker}">
        <td class="td-label">
          <div class="st-ticker">${r.ticker}</div>
          <div class="st-issuer">${escapeHtml(r.issuer||'')}</div>
        </td>
        ${cells}
      </tr>`;
    }).join('');

    mainArea.innerHTML = `
      <div class="section-title">Screening Saham</div>
      <div class="screen-toolbar">
        <div class="screen-count">Menampilkan <b>${shown.length}</b> dari <b>${total}</b> saham &middot; diurutkan berdasarkan <b>${SCREEN_COLS.find(c=>c.key===screenSortKey).label}</b> (${screenSortDir==='desc'?'terbesar → terkecil':'terkecil → terbesar'})</div>
      </div>
      <div class="screen-card">
        <div style="overflow-x:auto; max-height:640px; overflow-y:auto;">
          <table class="screen-table">
            <thead><tr><th class="th-label">Saham</th>${headHtml}</tr></thead>
            <tbody>${bodyHtml || `<tr><td colspan="6" style="text-align:center; color:var(--text-faint); font-family:var(--font-body);">Tidak ada hasil.</td></tr>`}</tbody>
          </table>
        </div>
        ${!screenShowAll && total>50 ? `<button class="show-more-btn" id="showMoreBtn">TAMPILKAN SEMUA (${total})</button>` : ''}
      </div>
      <p class="foot-note">Klik judul kolom untuk mengurutkan dari terbesar atau terkecil. Klik baris untuk melihat detail pemegang saham. Screening memakai perubahan periode terbaru, yaitu Juni → Juli 2026. Tabel detail tetap menampilkan urutan lengkap Mei → Juni → Juli 2026.</p>
    `;

    mainArea.querySelectorAll('table.screen-table th[data-key]').forEach(th=>{
      th.addEventListener('click', ()=>{
        const key = th.getAttribute('data-key');
        if(screenSortKey===key) screenSortDir = screenSortDir==='desc' ? 'asc' : 'desc';
        else { screenSortKey = key; screenSortDir = 'desc'; }
        renderScreening(searchInput.value.trim());
      });
    });
    mainArea.querySelectorAll('table.screen-table tr[data-ticker]').forEach(tr=>{
      tr.addEventListener('click', ()=>{
        searchInput.value = tr.getAttribute('data-ticker');
        mode='saham'; setActiveTab(); runSearch();
        window.scrollTo({top:0, behavior:'smooth'});
      });
    });
    const showMoreBtn = document.getElementById('showMoreBtn');
    if(showMoreBtn) showMoreBtn.addEventListener('click', ()=>{ screenShowAll = true; renderScreening(searchInput.value.trim()); });
  }

  // ---------- Ticker tape ----------
  function renderTape(){
    const s = computeMarketStats();
    const items = [];
    s.bigChange.slice(0,10).forEach(m=>{
      items.push(`<span class="tape-item" data-ticker="${m.t}"><b>${m.t}</b> ${escapeHtml(m.name)} <span class="${m.delta>0?'tape-up':'tape-down'}">${m.delta>0?'▲':'▼'} ${Math.abs(m.delta).toFixed(2)}pp</span></span>`);
    });
    s.bigNew.slice(0,8).forEach(m=>{
      items.push(`<span class="tape-item" data-ticker="${m.t}"><b>${m.t}</b> <span class="tape-new">BARU</span> ${escapeHtml(m.name)} ${fmtPct(m.pct)}</span>`);
    });
    const html = items.join('') || '<span class="tape-item">Tidak ada pergerakan signifikan periode ini.</span>';
    const track = document.getElementById('tapeTrack');
    track.innerHTML = html + html; // duplicate for seamless loop
    track.querySelectorAll('.tape-item[data-ticker]').forEach(el=>{
      el.addEventListener('click', ()=>{
        searchInput.value = el.getAttribute('data-ticker');
        mode='saham'; setActiveTab(); runSearch();
        window.scrollTo({top:0, behavior:'smooth'});
      });
    });
  }

  // ---------- Wire up events ----------
  tabBtns.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      mode = btn.dataset.mode;
      setActiveTab();
      runSearch();
    });
  });
  searchInput.addEventListener('input', debounce(runSearch, 150));
  clearBtn.addEventListener('click', ()=>{ searchInput.value=''; runSearch(); searchInput.focus(); });

  function debounce(fn, ms){
    let t;
    return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
  }

  // ---------- Init ----------
  setActiveTab();
  renderTape();
  renderOverview();

})().catch(error => {
  console.error(error);
  const mainArea = document.getElementById('mainArea');
  if(!mainArea) return;
  mainArea.textContent = '';
  const message = document.createElement('div');
  message.className = 'empty-state';
  message.textContent = 'Data JSON tidak dapat dimuat. Jalankan aplikasi melalui web server atau layanan hosting.';
  mainArea.appendChild(message);
});
