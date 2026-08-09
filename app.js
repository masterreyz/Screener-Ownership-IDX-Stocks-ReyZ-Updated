(async function () {
  "use strict";

  // =========================================================
  // KONFIGURASI PERIODE
  // Untuk menambah bulan berikutnya, tambahkan satu objek baru di sini.
  // Semua tabel, perubahan antarbulan, screening, dan sort akan mengikuti.
  // =========================================================
  const PERIODS = [
    { key: "feb", label: "Februari 2026", short: "Februari", file: "data-feb2026.json" },
    { key: "mar", label: "Maret 2026", short: "Maret", file: "data-mar2026.json" },
    { key: "apr", label: "April 2026", short: "April", file: "data-apr2026.json" },
    { key: "may", label: "Mei 2026", short: "Mei", file: "data-mei2026.json" },
    { key: "jun", label: "Juni 2026", short: "Juni", file: "data-jun2026.json" },
    { key: "jul", label: "Juli 2026", short: "Juli", file: "data-jul2026.json" },
  ];

  const TRANSITIONS = PERIODS.slice(1).map((current, index) => {
    const previous = PERIODS[index];
    const suffix = capitalize(previous.key) + capitalize(current.key);
    return {
      key: previous.key + current.key,
      suffix,
      previous,
      current,
      label: `${previous.label} → ${current.label}`,
      shortLabel: `${previous.short} → ${current.short}`,
    };
  });

  const LATEST_PERIOD = PERIODS[PERIODS.length - 1];
  const LATEST_TRANSITION = TRANSITIONS[TRANSITIONS.length - 1];

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  async function loadJson(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Gagal memuat ${path}: HTTP ${response.status}`);
    }
    return response.json();
  }

  const loadedData = await Promise.all(PERIODS.map((period) => loadJson(period.file)));
  PERIODS.forEach((period, index) => {
    period.data = loadedData[index];
    period.byTicker = Object.create(null);
    period.byNorm = Object.create(null);
  });

  // fields JSON: t=ticker, i=issuer, n=investor name,
  // c=classification, lf=local/foreign, sh=shares, p=percentage.
  function normalize(name) {
    if (!name) return "";
    return String(name)
      .toUpperCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[.,]/g, "")
      .replace(/\bTBK\b/g, "")
      .replace(/\bPT\b/g, "")
      .replace(/\bPERSERO\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const allTickers = new Set();
  const issuerByTicker = Object.create(null);

  PERIODS.forEach((period) => {
    period.data.forEach((row) => {
      row.norm = normalize(row.n);
      (period.byTicker[row.t] ||= []).push(row);
      (period.byNorm[row.norm] ||= []).push(row);
      allTickers.add(row.t);
      issuerByTicker[row.t] = row.i;
    });
  });

  function periodStatus(previous, current, renamed = false, metric = "p") {
    if (renamed) return "ganti_nama";
    if (previous && current) {
      const delta = Number(current[metric]) - Number(previous[metric]);
      const tolerance = metric === "p" ? 0.005 : 0;
      return Math.abs(delta) < tolerance || delta === 0
        ? "tetap"
        : delta > 0
          ? "naik"
          : "turun";
    }
    if (!previous && current) return "baru";
    if (previous && !current) return "keluar";
    return null;
  }

  function periodDelta(previous, current, metric = "p") {
    if (!previous || !current) return null;
    const delta = Number(current[metric]) - Number(previous[metric]);
    return metric === "p" ? Number(delta.toFixed(2)) : delta;
  }

  function uniqueSamePercentage(rows, percentage, usedRows) {
    const candidates = rows.filter(
      (row) => !usedRows.has(row) && row.p.toFixed(2) === percentage.toFixed(2),
    );
    return candidates.length === 1 ? candidates[0] : null;
  }

  // =========================================================
  // PENGGABUNGAN INVESTOR PER SAHAM UNTUK ENAM PERIODE
  // Dimulai dari bulan terbaru lalu bergerak mundur.
  // =========================================================
  const diffCache = Object.create(null);

  function getTickerDiff(ticker) {
    if (diffCache[ticker]) return diffCache[ticker];

    const rowsByPeriod = Object.fromEntries(
      PERIODS.map((period) => [
        period.key,
        (period.byTicker[ticker] || []).slice().sort((a, b) => b.p - a.p),
      ]),
    );

    const latestRows = rowsByPeriod[LATEST_PERIOD.key];
    const entities = latestRows.map((row) => ({
      rows: { [LATEST_PERIOD.key]: row },
      renamed: Object.create(null),
    }));

    for (let periodIndex = PERIODS.length - 2; periodIndex >= 0; periodIndex -= 1) {
      const period = PERIODS[periodIndex];
      const nextPeriod = PERIODS[periodIndex + 1];
      const currentRows = rowsByPeriod[period.key];
      const currentByNorm = Object.create(null);
      currentRows.forEach((row) => {
        (currentByNorm[row.norm] ||= []).push(row);
      });
      const usedRows = new Set();

      entities.forEach((entity) => {
        const nextRow = entity.rows[nextPeriod.key];
        const nearestLaterRow = nextRow || PERIODS.slice(periodIndex + 1)
          .map((candidate) => entity.rows[candidate.key])
          .find(Boolean);
        if (!nearestLaterRow) return;

        let matched = (currentByNorm[nearestLaterRow.norm] || []).find(
          (row) => !usedRows.has(row),
        );
        let renamed = false;

        // Deteksi variasi/ganti nama hanya untuk pasangan bulan yang bersebelahan.
        if (!matched && nextRow) {
          matched = uniqueSamePercentage(currentRows, nextRow.p, usedRows);
          renamed = Boolean(matched);
        }

        if (matched) {
          entity.rows[period.key] = matched;
          usedRows.add(matched);
          if (renamed) entity.renamed[period.key + nextPeriod.key] = true;
        }
      });

      currentRows.forEach((row) => {
        if (!usedRows.has(row)) {
          entities.push({ rows: { [period.key]: row }, renamed: Object.create(null) });
        }
      });
    }

    const merged = entities.map((entity) => {
      const display = PERIODS.slice().reverse()
        .map((period) => entity.rows[period.key])
        .find(Boolean);
      const result = {
        name: display.n,
        classification: display.c,
        lf: display.lf,
      };

      PERIODS.forEach((period) => {
        const row = entity.rows[period.key];
        result[`${period.key}Pct`] = row ? row.p : null;
        result[`${period.key}Shares`] = row ? row.sh : null;
      });

      TRANSITIONS.forEach((transition) => {
        const previous = entity.rows[transition.previous.key];
        const current = entity.rows[transition.current.key];
        const renamed = Boolean(entity.renamed[transition.key]);
        result[`delta${transition.suffix}`] = periodDelta(previous, current, "p");
        result[`status${transition.suffix}`] = periodStatus(previous, current, renamed, "p");
        result[`shareDelta${transition.suffix}`] = periodDelta(previous, current, "sh");
        result[`shareStatus${transition.suffix}`] = periodStatus(previous, current, renamed, "sh");
      });

      // Alias periode terbaru dipakai oleh ringkasan dan ticker tape.
      result.status = result[`status${LATEST_TRANSITION.suffix}`];
      result.delta = result[`delta${LATEST_TRANSITION.suffix}`];
      return result;
    });

    const latestPctKey = `${LATEST_PERIOD.key}Pct`;
    merged.sort((a, b) => {
      const aValue = PERIODS.slice().reverse()
        .map((period) => a[`${period.key}Pct`])
        .find((value) => value != null) ?? -1;
      const bValue = PERIODS.slice().reverse()
        .map((period) => b[`${period.key}Pct`])
        .find((value) => value != null) ?? -1;
      return (b[latestPctKey] ?? bValue) - (a[latestPctKey] ?? aValue);
    });

    const result = { ticker, issuer: issuerByTicker[ticker], rows: merged };
    diffCache[ticker] = result;
    return result;
  }

  // =========================================================
  // RINGKASAN PASAR: memakai pasangan periode terbaru.
  // =========================================================
  let marketStats = null;

  function computeMarketStats() {
    if (marketStats) return marketStats;
    let newCount = 0;
    let exitCount = 0;
    let changedCount = 0;
    const bigNew = [];
    const bigExit = [];
    const bigChange = [];
    const latestPctKey = `${LATEST_PERIOD.key}Pct`;
    const previousPctKey = `${LATEST_TRANSITION.previous.key}Pct`;

    allTickers.forEach((ticker) => {
      const detail = getTickerDiff(ticker);
      detail.rows.forEach((row) => {
        if (row.status === "baru") {
          newCount += 1;
          bigNew.push({ ticker, name: row.name, pct: row[latestPctKey] });
        } else if (row.status === "keluar") {
          exitCount += 1;
          bigExit.push({ ticker, name: row.name, pct: row[previousPctKey] });
        } else if (
          (row.status === "naik" || row.status === "turun") &&
          Math.abs(row.delta) >= 0.5
        ) {
          changedCount += 1;
          bigChange.push({ ticker, name: row.name, delta: row.delta });
        }
      });
    });

    bigNew.sort((a, b) => b.pct - a.pct);
    bigExit.sort((a, b) => b.pct - a.pct);
    bigChange.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const previousByTicker = LATEST_TRANSITION.previous.byTicker;
    const latestByTicker = LATEST_PERIOD.byTicker;
    marketStats = {
      newCount,
      exitCount,
      changedCount,
      bigNew,
      bigExit,
      bigChange,
      newTickers: [...allTickers].filter(
        (ticker) => !previousByTicker[ticker] && latestByTicker[ticker],
      ).sort(),
    };
    return marketStats;
  }

  // =========================================================
  // SCREENING: enam total bulanan + empat metrik per transisi.
  // =========================================================
  const totalField = (period) => `total${capitalize(period.key)}`;
  const metricField = (metric, transition) => `${metric}${transition.suffix}`;

  const SCREEN_GROUPS = [];
  PERIODS.forEach((period, index) => {
    SCREEN_GROUPS.push({
      label: period.label,
      cols: [{
        key: totalField(period),
        label: "Total >1%",
        sortLabel: `Total pemegang >1% ${period.label}`,
        cls: "cell-total",
      }],
    });
    if (index < TRANSITIONS.length) {
      const transition = TRANSITIONS[index];
      SCREEN_GROUPS.push({
        label: `Perubahan ${transition.shortLabel}`,
        cols: [
          { key: metricField("new", transition), label: "Baru", sortLabel: `Investor baru ${transition.current.label}`, cls: "cell-new" },
          { key: metricField("up", transition), label: "Nambah", sortLabel: `Nambah kepemilikan ${transition.label}`, cls: "cell-up" },
          { key: metricField("down", transition), label: "Kurangi", sortLabel: `Kurangi kepemilikan ${transition.label}`, cls: "cell-down" },
          { key: metricField("exit", transition), label: "Keluar", sortLabel: `Investor keluar ${transition.current.label}`, cls: "cell-exit" },
        ],
      });
    }
  });
  const SCREEN_COLS = SCREEN_GROUPS.flatMap((group) => group.cols);
  let screenSortKey = totalField(LATEST_PERIOD);
  let screenSortDir = "desc";
  let screenShowAll = false;
  let screenData = null;

  function computeScreenData() {
    if (screenData) return screenData;
    screenData = [...allTickers].map((ticker) => {
      const detail = getTickerDiff(ticker);
      const result = { ticker, issuer: detail.issuer };
      PERIODS.forEach((period) => {
        result[totalField(period)] = detail.rows.filter(
          (row) => row[`${period.key}Pct`] != null,
        ).length;
      });
      TRANSITIONS.forEach((transition) => {
        const statusKey = `status${transition.suffix}`;
        result[metricField("new", transition)] = 0;
        result[metricField("up", transition)] = 0;
        result[metricField("down", transition)] = 0;
        result[metricField("exit", transition)] = 0;
        detail.rows.forEach((row) => {
          if (row[statusKey] === "baru") result[metricField("new", transition)] += 1;
          else if (row[statusKey] === "naik") result[metricField("up", transition)] += 1;
          else if (row[statusKey] === "turun") result[metricField("down", transition)] += 1;
          else if (row[statusKey] === "keluar") result[metricField("exit", transition)] += 1;
        });
      });
      return result;
    });
    return screenData;
  }

  // =========================================================
  // STATE DAN HELPER TAMPILAN
  // =========================================================
  const tickerSortState = Object.create(null);
  const investorSortState = Object.create(null);
  const mainArea = document.getElementById("mainArea");
  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("clearBtn");
  const hintRow = document.getElementById("hintRow");
  const tabBtns = document.querySelectorAll(".tab-btn");
  let mode = "saham";

  const integerFormatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

  function fmtPct(value) {
    return value == null ? "—" : `${value.toFixed(2)}%`;
  }

  function fmtShares(value) {
    return value == null ? "—" : `${integerFormatter.format(value)} saham`;
  }

  function fmtDelta(value) {
    if (value == null) return "";
    return `${value > 0 ? "+" : ""}${value.toFixed(2)} pp`;
  }

  function fmtShareDelta(value) {
    if (value == null) return "";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${integerFormatter.format(Math.abs(value))} saham`;
  }

  function deltaClass(value) {
    if (value == null || Math.abs(value) < 0.005) return "delta-flat";
    return value > 0 ? "delta-up" : "delta-down";
  }

  function statusChip(status) {
    switch (status) {
      case "baru": return '<span class="status-chip status-baru">BARU</span>';
      case "keluar": return '<span class="status-chip status-keluar">KELUAR</span>';
      case "naik": return '<span class="status-chip status-naik">▲ naik</span>';
      case "turun": return '<span class="status-chip status-turun">▼ turun</span>';
      case "ganti_nama": return '<span class="status-chip status-tetap">ganti nama</span>';
      case "tetap": return '<span class="status-chip status-tetap">tetap</span>';
      default: return '<span class="status-chip status-tetap">—</span>';
    }
  }

  function transitionCell(delta, status, sharesView = false) {
    if (!status) return statusChip(null);
    if (status === "baru" || status === "keluar" || status === "ganti_nama") {
      return statusChip(status);
    }
    const formatted = sharesView ? fmtShareDelta(delta) : fmtDelta(delta);
    return `${formatted} ${statusChip(status)}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function sortRowsByNumber(rows, key, direction) {
    return rows.slice().sort((a, b) => {
      const aValue = a[key];
      const bValue = b[key];
      const aEmpty = aValue == null || Number.isNaN(aValue);
      const bEmpty = bValue == null || Number.isNaN(bValue);
      if (aEmpty && bEmpty) return String(a.name).localeCompare(String(b.name), "id");
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const difference = direction === "desc" ? bValue - aValue : aValue - bValue;
      return difference || String(a.name).localeCompare(String(b.name), "id");
    });
  }

  function getTickerSortState(ticker) {
    return tickerSortState[ticker] || { key: `${LATEST_PERIOD.key}Pct`, dir: "desc" };
  }

  function getInvestorSortState(norm, view) {
    const stateKey = `${view}:${norm}`;
    const suffix = view === "shares" ? "Shares" : "Pct";
    return investorSortState[stateKey] || {
      key: `${LATEST_PERIOD.key}${suffix}`,
      dir: "desc",
    };
  }

  function sortHeader({ owner, ownerValue, key, label, state, view = "percentage" }) {
    const sorted = state.key === key;
    const arrow = sorted ? (state.dir === "desc" ? "▼" : "▲") : "↕";
    const ariaSort = sorted ? (state.dir === "desc" ? "descending" : "ascending") : "none";
    const ownerAttribute = owner === "ticker"
      ? `data-ticker="${ownerValue}"`
      : `data-investor-key="${encodeURIComponent(ownerValue)}" data-view="${view}"`;
    const buttonClass = owner === "ticker" ? "ticker-sort-btn" : "investor-sort-btn";
    return `<th class="text-right${sorted ? " sorted" : ""}" scope="col" aria-sort="${ariaSort}">
      <button type="button" class="table-sort-btn ${buttonClass}" ${ownerAttribute} data-key="${key}" aria-label="Urutkan ${escapeHtml(label)}">
        <span>${escapeHtml(label)}</span><span class="arrow" aria-hidden="true">${arrow}</span>
      </button>
    </th>`;
  }

  // =========================================================
  // CARI SAHAM
  // =========================================================
  function renderTickerCard(ticker) {
    const detail = getTickerDiff(ticker);
    if (!detail.rows.length) return "";
    const latestStatusKey = `status${LATEST_TRANSITION.suffix}`;
    const newCount = detail.rows.filter((row) => row[latestStatusKey] === "baru").length;
    const exitCount = detail.rows.filter((row) => row[latestStatusKey] === "keluar").length;
    const badges = [
      newCount ? `<span class="badge badge-new">+${newCount} BARU DI ${LATEST_PERIOD.short.toUpperCase()}</span>` : "",
      exitCount ? `<span class="badge badge-exit">-${exitCount} KELUAR DI ${LATEST_PERIOD.short.toUpperCase()}</span>` : "",
    ].join("");

    const sortState = getTickerSortState(ticker);
    const rows = sortRowsByNumber(detail.rows, sortState.key, sortState.dir)
      .map((row) => {
        const latestStatus = row[latestStatusKey];
        const rowClass = latestStatus === "baru" ? "row-new" : latestStatus === "keluar" ? "row-exit" : "";
        const periodCells = PERIODS.map(
          (period) => `<td class="r-pct">${fmtPct(row[`${period.key}Pct`])}</td>`,
        ).join("");
        const transitionCells = TRANSITIONS.map((transition) => {
          const delta = row[`delta${transition.suffix}`];
          const status = row[`status${transition.suffix}`];
          return `<td class="r-delta ${deltaClass(delta)}">${transitionCell(delta, status)}</td>`;
        }).join("");
        return `<tr class="${rowClass}">
          <td><div class="r-name">${escapeHtml(row.name)}</div></td>
          <td class="r-class">${escapeHtml(row.classification || "—")}${row.lf ? ` &middot; ${row.lf === "L" ? "Lokal" : "Asing"}` : ""}</td>
          ${periodCells}${transitionCells}
        </tr>`;
      }).join("");

    const periodHeaders = PERIODS.map((period) => sortHeader({
      owner: "ticker",
      ownerValue: ticker,
      key: `${period.key}Pct`,
      label: period.label,
      state: sortState,
    })).join("");
    const transitionHeaders = TRANSITIONS.map((transition) => sortHeader({
      owner: "ticker",
      ownerValue: ticker,
      key: `delta${transition.suffix}`,
      label: transition.label,
      state: sortState,
    })).join("");

    return `<div class="result-card">
      <div class="result-head">
        <div><div class="rh-ticker">${ticker}</div><div class="rh-issuer">${escapeHtml(detail.issuer || "")}</div></div>
        <div class="rh-badges">${badges}</div>
      </div>
      <div class="table-scroll" role="region" aria-label="Tabel kepemilikan ${ticker}" tabindex="0">
        <table class="hold-table ticker-hold-table">
          <thead><tr><th>Investor</th><th class="r-class">Klasifikasi</th>${periodHeaders}${transitionHeaders}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  function wireTickerSortControls() {
    mainArea.querySelectorAll(".ticker-sort-btn[data-ticker][data-key]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const ticker = button.dataset.ticker;
        const key = button.dataset.key;
        const current = getTickerSortState(ticker);
        tickerSortState[ticker] = {
          key,
          dir: current.key === key && current.dir === "desc" ? "asc" : "desc",
        };
        renderTickerResults(searchInput.value.trim());
      });
    });
  }

  function renderTickerResults(query) {
    const normalizedQuery = query.trim().toUpperCase();
    let matches = [...allTickers].filter(
      (ticker) => ticker.includes(normalizedQuery) ||
        (issuerByTicker[ticker] || "").toUpperCase().includes(normalizedQuery),
    );
    matches.sort((a, b) => {
      const exactDifference = (a === normalizedQuery ? 0 : 1) - (b === normalizedQuery ? 0 : 1);
      return exactDifference || a.localeCompare(b);
    });
    if (!matches.length) {
      mainArea.innerHTML = emptyState(`Tidak ada saham yang cocok dengan "${escapeHtml(query)}".`);
      return;
    }
    matches = matches.slice(0, 25);
    mainArea.innerHTML = `<div class="section-title">${matches.length} saham ditemukan</div>${matches.map(renderTickerCard).join("")}`;
    wireTickerSortControls();
  }

  // =========================================================
  // CARI INVESTOR: PERCENTAGE DAN TOTAL HOLDING SHARES
  // =========================================================
  function buildInvestorHoldings(norm) {
    const rowsForPeriod = Object.fromEntries(
      PERIODS.map((period) => [period.key, period.byNorm[norm] || []]),
    );
    const tickers = new Set(
      PERIODS.flatMap((period) => rowsForPeriod[period.key].map((row) => row.t)),
    );
    const holdings = [...tickers].map((ticker) => {
      const result = {
        name: ticker,
        ticker,
        issuer: issuerByTicker[ticker] || "",
      };
      const matchedRows = Object.create(null);
      PERIODS.forEach((period) => {
        const row = rowsForPeriod[period.key].find((candidate) => candidate.t === ticker);
        matchedRows[period.key] = row || null;
        result[`${period.key}Pct`] = row ? row.p : null;
        result[`${period.key}Shares`] = row ? row.sh : null;
      });
      TRANSITIONS.forEach((transition) => {
        const previous = matchedRows[transition.previous.key];
        const current = matchedRows[transition.current.key];
        result[`delta${transition.suffix}`] = periodDelta(previous, current, "p");
        result[`status${transition.suffix}`] = periodStatus(previous, current, false, "p");
        result[`shareDelta${transition.suffix}`] = periodDelta(previous, current, "sh");
        result[`shareStatus${transition.suffix}`] = periodStatus(previous, current, false, "sh");
      });
      return result;
    });
    return { holdings, tickerCount: tickers.size };
  }

  function renderInvestorResults(query, view = "percentage") {
    const sharesView = view === "shares";
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) {
      mainArea.innerHTML = emptyState('Ketik nama investor, misalnya "TASPEN" atau "BAKRIE".');
      return;
    }

    const namesMap = Object.create(null);
    PERIODS.forEach((period) => {
      period.data.forEach((row) => {
        if (row.norm.includes(normalizedQuery)) namesMap[row.norm] = row.n;
      });
    });
    const normNames = Object.keys(namesMap);
    if (!normNames.length) {
      mainArea.innerHTML = emptyState(`Tidak ada investor yang cocok dengan "${escapeHtml(query)}".`);
      return;
    }

    const metricName = sharesView ? "total holding shares" : "persentase kepemilikan";
    const modeTitle = sharesView ? "Investor by Shares" : "Cari Investor";
    let html = `<div class="section-title">${normNames.length} investor cocok · ${modeTitle}</div>
      <p class="investor-search-note">Klik salah satu dari 11 header angka untuk mengurutkan ${metricName}: enam periode bulanan dan lima perubahan antarbulan. Klik lagi header yang sama untuk membalik urutan. Nilai kosong selalu berada di bawah.${sharesView ? " Jumlah saham memakai pemisah ribuan format Indonesia." : " Perubahan persentase ditampilkan dalam percentage point (pp)."}</p>`;

    normNames.slice(0, 15).forEach((norm) => {
      const { holdings, tickerCount } = buildInvestorHoldings(norm);
      const sortState = getInvestorSortState(norm, view);
      const sortedHoldings = sortRowsByNumber(holdings, sortState.key, sortState.dir);
      const latestStatusKey = sharesView
        ? `shareStatus${LATEST_TRANSITION.suffix}`
        : `status${LATEST_TRANSITION.suffix}`;

      const rows = sortedHoldings.map((holding) => {
        const latestStatus = holding[latestStatusKey];
        const rowClass = latestStatus === "baru" ? "row-new" : latestStatus === "keluar" ? "row-exit" : "";
        const periodCells = PERIODS.map((period) => {
          const value = holding[`${period.key}${sharesView ? "Shares" : "Pct"}`];
          return `<td class="r-pct investor-period-cell${sharesView ? " share-cell" : ""}">${sharesView ? fmtShares(value) : fmtPct(value)}</td>`;
        }).join("");
        const transitionCells = TRANSITIONS.map((transition) => {
          const delta = holding[`${sharesView ? "shareDelta" : "delta"}${transition.suffix}`];
          const status = holding[`${sharesView ? "shareStatus" : "status"}${transition.suffix}`];
          return `<td class="r-delta ${deltaClass(delta)}${sharesView ? " share-delta-cell" : ""}">${transitionCell(delta, status, sharesView)}</td>`;
        }).join("");
        return `<tr class="investor-stock-row ${rowClass}" data-ticker="${holding.ticker}" tabindex="0" role="button" aria-label="Buka detail saham ${holding.ticker}">
          <td class="investor-stock-cell"><div class="mover-ticker">${holding.ticker}</div><div class="mover-name mover-name-full">${escapeHtml(holding.issuer)}</div></td>
          ${periodCells}${transitionCells}
        </tr>`;
      }).join("");

      const periodHeaders = PERIODS.map((period) => sortHeader({
        owner: "investor",
        ownerValue: norm,
        key: `${period.key}${sharesView ? "Shares" : "Pct"}`,
        label: period.label,
        state: sortState,
        view,
      })).join("");
      const transitionHeaders = TRANSITIONS.map((transition) => sortHeader({
        owner: "investor",
        ownerValue: norm,
        key: `${sharesView ? "shareDelta" : "delta"}${transition.suffix}`,
        label: transition.label,
        state: sortState,
        view,
      })).join("");

      html += `<div class="result-card">
        <div class="result-head">
          <div><div class="rh-ticker investor-name">${escapeHtml(namesMap[norm])}</div><div class="rh-issuer">terdaftar sebagai pemegang &gt;1% di ${tickerCount} saham pada setidaknya satu periode</div></div>
          ${sharesView ? '<div class="rh-badges"><span class="badge badge-shares">TOTAL HOLDING SHARES</span></div>' : ""}
        </div>
        <div class="table-scroll investor-table-scroll" role="region" aria-label="Riwayat ${metricName} ${escapeHtml(namesMap[norm])}" tabindex="0">
          <table class="hold-table investor-hold-table${sharesView ? " shares-view" : ""}">
            <thead><tr><th scope="col">Saham</th>${periodHeaders}${transitionHeaders}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    });

    mainArea.innerHTML = html;
    mainArea.querySelectorAll(".investor-sort-btn[data-investor-key][data-view][data-key]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const norm = decodeURIComponent(button.dataset.investorKey);
        const currentView = button.dataset.view;
        const key = button.dataset.key;
        const current = getInvestorSortState(norm, currentView);
        investorSortState[`${currentView}:${norm}`] = {
          key,
          dir: current.key === key && current.dir === "desc" ? "asc" : "desc",
        };
        renderInvestorResults(searchInput.value.trim(), currentView);
      });
    });
    mainArea.querySelectorAll("table.investor-hold-table tr[data-ticker]").forEach((row) => {
      const openTicker = () => {
        searchInput.value = row.dataset.ticker;
        mode = "saham";
        setActiveTab();
        runSearch();
      };
      row.addEventListener("click", openTicker);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openTicker();
        }
      });
    });
  }

  // =========================================================
  // SCREENING
  // =========================================================
  function renderScreening(filterQuery) {
    let rows = computeScreenData();
    const query = (filterQuery || "").trim().toUpperCase();
    if (query) {
      rows = rows.filter(
        (row) => row.ticker.includes(query) || (row.issuer || "").toUpperCase().includes(query),
      );
    }
    rows = rows.slice().sort((a, b) => {
      const difference = screenSortDir === "desc"
        ? b[screenSortKey] - a[screenSortKey]
        : a[screenSortKey] - b[screenSortKey];
      return difference || a.ticker.localeCompare(b.ticker);
    });
    const total = rows.length;
    const shown = screenShowAll ? rows : rows.slice(0, 50);

    const groupHeaders = SCREEN_GROUPS.map(
      (group) => `<th class="screen-group" colspan="${group.cols.length}" scope="colgroup">${escapeHtml(group.label)}</th>`,
    ).join("");
    const metricHeaders = SCREEN_COLS.map((column) => {
      const sorted = column.key === screenSortKey;
      const arrow = sorted ? (screenSortDir === "desc" ? "▼" : "▲") : "↕";
      const ariaSort = sorted ? (screenSortDir === "desc" ? "descending" : "ascending") : "none";
      return `<th class="${sorted ? "sorted" : ""}" aria-sort="${ariaSort}">
        <button type="button" class="screen-sort-btn" data-key="${column.key}" aria-label="Urutkan ${escapeHtml(column.sortLabel)}">
          <span>${escapeHtml(column.label)}</span><span class="arrow" aria-hidden="true">${arrow}</span>
        </button>
      </th>`;
    }).join("");
    const body = shown.map((row) => {
      const cells = SCREEN_COLS.map((column) => {
        const value = row[column.key];
        return `<td class="${value > 0 ? column.cls : "cell-zero"}">${value}</td>`;
      }).join("");
      return `<tr data-ticker="${row.ticker}"><td class="td-label"><div class="st-ticker">${row.ticker}</div><div class="st-issuer">${escapeHtml(row.issuer || "")}</div></td>${cells}</tr>`;
    }).join("");
    const selectedColumn = SCREEN_COLS.find((column) => column.key === screenSortKey);

    mainArea.innerHTML = `<div class="section-title">Screening Saham · Februari–Juli 2026</div>
      <div class="screen-toolbar"><div class="screen-count">Menampilkan <b>${shown.length}</b> dari <b>${total}</b> saham &middot; diurutkan berdasarkan <b>${escapeHtml(selectedColumn.sortLabel)}</b> (${screenSortDir === "desc" ? "terbesar → terkecil" : "terkecil → terbesar"})</div></div>
      <div class="screen-card">
        <div class="screen-scroll" role="region" aria-label="Tabel screening saham" tabindex="0">
          <table class="screen-table">
            <thead><tr class="screen-group-row"><th class="th-label" rowspan="2" scope="col">Saham</th>${groupHeaders}</tr><tr class="screen-metric-row">${metricHeaders}</tr></thead>
            <tbody>${body || `<tr><td colspan="${SCREEN_COLS.length + 1}" class="screen-empty">Tidak ada hasil.</td></tr>`}</tbody>
          </table>
        </div>
        ${!screenShowAll && total > 50 ? `<button class="show-more-btn" id="showMoreBtn">TAMPILKAN SEMUA (${total})</button>` : ""}
      </div>
      <p class="foot-note">Tabel menyediakan enam kolom total pemegang &gt;1% dan lima grup perubahan antarbulan. Setiap grup perubahan mempunyai Investor Baru, Nambah, Kurangi, dan Keluar. Klik header metrik untuk mengubah arah sort; klik baris untuk membuka detail saham.</p>`;

    mainArea.querySelectorAll(".screen-sort-btn[data-key]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const key = button.dataset.key;
        if (screenSortKey === key) screenSortDir = screenSortDir === "desc" ? "asc" : "desc";
        else {
          screenSortKey = key;
          screenSortDir = "desc";
        }
        renderScreening(searchInput.value.trim());
      });
    });
    mainArea.querySelectorAll("table.screen-table tr[data-ticker]").forEach((row) => {
      row.addEventListener("click", () => {
        searchInput.value = row.dataset.ticker;
        mode = "saham";
        setActiveTab();
        runSearch();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    const showMoreButton = document.getElementById("showMoreBtn");
    if (showMoreButton) {
      showMoreButton.addEventListener("click", () => {
        screenShowAll = true;
        renderScreening(searchInput.value.trim());
      });
    }
  }

  // =========================================================
  // OVERVIEW, HINT, DAN EVENT
  // =========================================================
  function renderOverview() {
    const stats = computeMarketStats();
    const moverRows = (items, valueRenderer) => items.slice(0, 8).map((item) => `
      <div class="mover-row" data-ticker="${item.ticker}">
        <div class="mover-left"><div class="mover-ticker">${item.ticker}</div><div class="mover-name">${escapeHtml(item.name)}</div></div>
        <div class="mover-pct">${valueRenderer(item)}</div>
      </div>`).join("");

    mainArea.innerHTML = `<div class="section-title">Ringkasan Periode Terbaru (${LATEST_TRANSITION.label})</div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${allTickers.size}</div><div class="stat-label">Total saham tercakup, Februari–Juli</div></div>
        <div class="stat-card"><div class="stat-num gold">${stats.newCount}</div><div class="stat-label">Investor baru periode terbaru</div></div>
        <div class="stat-card"><div class="stat-num neg">${stats.exitCount}</div><div class="stat-label">Investor keluar periode terbaru</div></div>
        <div class="stat-card"><div class="stat-num">${stats.changedCount}</div><div class="stat-label">Perubahan signifikan (&ge;0.5pp)</div></div>
      </div>
      <div class="section-title">Pergerakan Terbesar</div>
      <div class="mover-grid">
        <div class="mover-card new"><h3>⬤ Investor Baru Terbesar</h3>${moverRows(stats.bigNew, (item) => `<span class="text-positive">${fmtPct(item.pct)}</span>`)}</div>
        <div class="mover-card exit"><h3>⬤ Investor Keluar Terbesar</h3>${moverRows(stats.bigExit, (item) => `<span class="text-negative">${fmtPct(item.pct)}</span>`)}</div>
      </div>
      ${stats.newTickers.length ? `<div class="section-title">Saham Baru Muncul di ${LATEST_PERIOD.short}</div><div class="mover-card new">${stats.newTickers.map((ticker) => `<div class="mover-row" data-ticker="${ticker}"><div class="mover-left"><div class="mover-ticker">${ticker}</div><div class="mover-name">${escapeHtml(issuerByTicker[ticker] || "")}</div></div><div class="mover-pct text-gold">lihat →</div></div>`).join("")}</div>` : ""}
      <p class="foot-note">Cari Saham, Cari Investor, Investor by Shares, dan Screening memakai data lengkap Februari, Maret, April, Mei, Juni, dan Juli 2026. Ringkasan serta ticker berjalan tetap berfokus pada periode terbaru, ${LATEST_TRANSITION.label}. Nama investor dinormalisasi agar variasi penulisan tidak keliru dihitung sebagai investor baru.</p>`;

    mainArea.querySelectorAll(".mover-row[data-ticker]").forEach((row) => {
      row.addEventListener("click", () => {
        searchInput.value = row.dataset.ticker;
        mode = "saham";
        setActiveTab();
        runSearch();
      });
    });
  }

  function renderTape() {
    const stats = computeMarketStats();
    const items = [];
    stats.bigChange.slice(0, 10).forEach((item) => {
      items.push(`<span class="tape-item" data-ticker="${item.ticker}"><b>${item.ticker}</b> ${escapeHtml(item.name)} <span class="${item.delta > 0 ? "tape-up" : "tape-down"}">${item.delta > 0 ? "▲" : "▼"} ${Math.abs(item.delta).toFixed(2)}pp</span></span>`);
    });
    stats.bigNew.slice(0, 8).forEach((item) => {
      items.push(`<span class="tape-item" data-ticker="${item.ticker}"><b>${item.ticker}</b> <span class="tape-new">BARU</span> ${escapeHtml(item.name)} ${fmtPct(item.pct)}</span>`);
    });
    const html = items.join("") || '<span class="tape-item">Tidak ada pergerakan signifikan periode ini.</span>';
    const track = document.getElementById("tapeTrack");
    track.innerHTML = html + html;
    track.querySelectorAll(".tape-item[data-ticker]").forEach((item) => {
      item.addEventListener("click", () => {
        searchInput.value = item.dataset.ticker;
        mode = "saham";
        setActiveTab();
        runSearch();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  function emptyState(message) {
    return `<div class="empty-state"><img class="empty-icon" src="search.svg" alt="" width="40" height="40"><p>${message}</p></div>`;
  }

  function setActiveTab() {
    tabBtns.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    if (mode === "saham") searchInput.placeholder = "Ketik kode saham, mis. BBCA, AWAN, PKPK...";
    else if (mode === "investor") searchInput.placeholder = "Ketik nama investor, mis. TASPEN, BAKRIE...";
    else if (mode === "investor-shares") searchInput.placeholder = "Ketik nama investor untuk melihat total holding shares...";
    else searchInput.placeholder = "Filter kode saham atau nama emiten (opsional)...";
    renderHints();
  }

  function renderHints() {
    if (mode === "screening") {
      const options = [];
      PERIODS.forEach((period) => {
        options.push({ label: `Total ${period.short}`, key: totalField(period) });
      });
      TRANSITIONS.forEach((transition) => {
        options.push(
          { label: `Baru ${transition.current.short}`, key: metricField("new", transition) },
          { label: `Nambah ${transition.shortLabel}`, key: metricField("up", transition) },
          { label: `Kurangi ${transition.shortLabel}`, key: metricField("down", transition) },
          { label: `Keluar ${transition.current.short}`, key: metricField("exit", transition) },
        );
      });
      hintRow.innerHTML = options.map(
        (option) => `<button type="button" class="hint-chip" data-key="${option.key}">${escapeHtml(option.label)}</button>`,
      ).join("");
      hintRow.querySelectorAll(".hint-chip[data-key]").forEach((button) => {
        button.addEventListener("click", () => {
          screenSortKey = button.dataset.key;
          screenSortDir = "desc";
          screenShowAll = false;
          runSearch();
        });
      });
      return;
    }
    const chips = mode === "saham"
      ? ["AWAN", "PKPK", "DATA", "BNBR", "MAPI", "BACH"]
      : ["TASPEN", "BAKRIE", "VICTORIA", "SAMUEL TUMBUH BERSAMA"];
    hintRow.innerHTML = chips.map(
      (chip) => `<button type="button" class="hint-chip" data-val="${chip}">${chip}</button>`,
    ).join("");
    hintRow.querySelectorAll(".hint-chip[data-val]").forEach((button) => {
      button.addEventListener("click", () => {
        searchInput.value = button.dataset.val;
        runSearch();
      });
    });
  }

  function runSearch() {
    const query = searchInput.value.trim();
    if (mode === "screening") {
      renderScreening(query);
      return;
    }
    if (!query) {
      renderOverview();
      return;
    }
    if (mode === "saham") renderTickerResults(query);
    else if (mode === "investor") renderInvestorResults(query, "percentage");
    else renderInvestorResults(query, "shares");
  }

  function debounce(callback, milliseconds) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => callback(...args), milliseconds);
    };
  }

  tabBtns.forEach((button) => {
    button.addEventListener("click", () => {
      mode = button.dataset.mode;
      setActiveTab();
      runSearch();
    });
  });
  searchInput.addEventListener("input", debounce(runSearch, 150));
  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    runSearch();
    searchInput.focus();
  });

  setActiveTab();
  renderTape();
  renderOverview();
})().catch((error) => {
  console.error(error);
  const mainArea = document.getElementById("mainArea");
  if (!mainArea) return;
  mainArea.innerHTML = `<div class="empty-state"><p>Data JSON tidak dapat dimuat. Jalankan aplikasi melalui web server atau hosting.<br><small>${String(error.message || error)}</small></p></div>`;
});
