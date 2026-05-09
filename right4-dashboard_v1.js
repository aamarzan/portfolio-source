(async function(){
  const small = () => window.matchMedia('(max-width: 820px)').matches;
  const baseConfig = () => ({
    displayModeBar: false,
    responsive: true,
    staticPlot: false,
    scrollZoom: false,
    doubleClick: false
  });

  function parseIsoDateUTC(iso){
    if(!iso || typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const [y,m,d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function toIsoFromUTC(date){
    return date.toISOString().slice(0,10);
  }

  function addDaysIso(iso, days){
    const date = parseIsoDateUTC(iso);
    if(!date) return iso;
    date.setUTCDate(date.getUTCDate() + days);
    return toIsoFromUTC(date);
  }

  function buildIsoDateRange(startIso, endIso){
    const start = parseIsoDateUTC(startIso);
    const end = parseIsoDateUTC(endIso);
    if(!start || !end || start > end) return [];
    const out = [];
    const cur = new Date(start.getTime());
    while(cur <= end){
      out.push(toIsoFromUTC(cur));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  function isoDateMin(rows){
    return rows.length ? rows.reduce((min, r) => (r.screeningDate < min ? r.screeningDate : min), rows[0].screeningDate) : '';
  }

  function isoDateMax(rows){
    return rows.length ? rows.reduce((max, r) => (r.screeningDate > max ? r.screeningDate : max), rows[0].screeningDate) : '';
  }

  function escapeHTML(value){
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[ch]));
  }

  async function resolveData(){
    if(window.RIGHT4_DASHBOARD_DATA && Array.isArray(window.RIGHT4_DASHBOARD_DATA.records)){
      return window.RIGHT4_DASHBOARD_DATA;
    }
    const assetConfig = window.RIGHT4_DASHBOARD_ASSETS || {};
    const candidates = [
      assetConfig.dataJson,
      '../right4-dashboard-data.json',
      '/right4-dashboard-data.json'
    ].filter(Boolean);

    for(const url of candidates){
      try{
        const response = await fetch(url, { cache: 'no-store' });
        if(!response.ok) continue;
        const json = await response.json();
        if(json && Array.isArray(json.records)) return json;
      }catch(err){
        // try next candidate
      }
    }
    return null;
  }

  const DATA = await resolveData();
  if(!DATA || !Array.isArray(DATA.records)){
    document.body.insertAdjacentHTML('afterbegin','<div style="padding:16px;background:#fff1f1;color:#991b1b;font-weight:700">Dashboard data could not be loaded.</div>');
    return;
  }

  const fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmtPct = (n) => `${Number(n || 0).toFixed(1)}%`;
  const toShortDate = (iso) => {
    const d = parseIsoDateUTC(iso);
    return d ? d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone:'UTC' }) : '-';
  };
  const toMonthLabel = (ym) => {
    if(!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || '-';
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, (m || 1) - 1, 1));
    return d.toLocaleDateString('en-GB', { month:'short', year:'numeric', timeZone:'UTC' });
  };

  const monthlyPreferredOrder = ['CMCH', 'RMCH', 'DMCH', 'SZMCH', 'SOMCH', 'CoxMCH', 'PGIMER', 'SGRDUHS', 'GGSMCH'];
  const themePresets = {
    light: {
      series:['#2563eb','#0ea5e9','#14b8a6','#8b5cf6','#ec4899','#f59e0b','#ef4444','#06b6d4','#64748b','#22c55e'],
      total:'#173b78',
      countryLine:'rgba(255,255,255,0.85)',
      chartFont:'#18304f',
      chartMuted:'#62779a',
      chartGrid:'rgba(54, 84, 138, 0.12)',
      chartZero:'rgba(54, 84, 138, 0.16)',
      hoverBg:'#f8fbff',
      hoverBorder:'#93c5fd',
      hoverFont:'#10223a',
      annotationBg:'rgba(255,255,255,0.88)',
      annotationBorder:'rgba(135,153,255,0.24)',
      annotationFont:'#1c3352',
      targetLine:'#a78bfa',
      calculatedLine:'#34d399',
      actualLine:'#38bdf8',
      positiveTarget:'#c084fc',
      truePositive:'#fbbf24',
      countryColors:{ India:'#7dd3fc', Bangladesh:'#60a5fa', Other:'#94a3b8' },
      classificationTrue:'#f59e0b',
      classificationOther:'#7c8aa0',
      empty:'#334155'
    },
    dark: {
      series:['#7dd3fc','#60a5fa','#34d399','#c084fc','#f472b6','#fbbf24','#fb7185','#22d3ee','#cbd5e1','#818cf8'],
      total:'#f8fafc',
      countryLine:'rgba(2,8,23,0.9)',
      chartFont:'#e8eefc',
      chartMuted:'#a8bcde',
      chartGrid:'rgba(191,219,254,0.14)',
      chartZero:'rgba(226,232,240,0.20)',
      hoverBg:'#050816',
      hoverBorder:'#60a5fa',
      hoverFont:'#ffffff',
      annotationBg:'rgba(5,8,22,0.76)',
      annotationBorder:'rgba(125,211,252,0.26)',
      annotationFont:'#e8eefc',
      targetLine:'#a78bfa',
      calculatedLine:'#34d399',
      actualLine:'#22d3ee',
      positiveTarget:'#c084fc',
      truePositive:'#fbbf24',
      countryColors:{ India:'#7dd3fc', Bangladesh:'#60a5fa', Other:'#94a3b8' },
      classificationTrue:'#f59e0b',
      classificationOther:'#7c8aa0',
      empty:'#334155'
    }
  };
  function currentTheme(){
    return document.body.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  function themeTokens(){
    return themePresets[currentTheme()] || themePresets.light;
  }

  const records = DATA.records.map((r, idx) => ({ ...r, _idx: idx, screeningTs: parseIsoDateUTC(r.screeningDate) }));
  const siteOrder = (DATA.config && DATA.config.siteOrder) || [...new Set(records.map(r => r.siteCode))];
  const siteMeta = (DATA.config && DATA.config.siteMeta) || Object.fromEntries(siteOrder.map(code => [code, {label: code, country: 'Other'}]));
  const targetSchedule = (DATA.config && DATA.config.targetSchedule) || { dates: [], targetPatients: [], calculatedTarget: [] };
  const positiveTargetSchedule = (DATA.config && DATA.config.truePositiveTargetSchedule) || { dates: [], targetPositive: [] };
  const studyTargets = (DATA.config && DATA.config.studyTargets) || {};
  const studyTimeline = (DATA.config && DATA.config.studyTimeline) || {};
  const studyStartDate = studyTimeline.startDate || targetSchedule.dates?.[0] || isoDateMin(records) || '2025-06-01';
  const studyEndDate = studyTimeline.endDate || '2026-12-31';
  const truePositiveTarget = studyTargets.truePositiveTarget || positiveTargetSchedule.targetPositive?.[positiveTargetSchedule.targetPositive.length - 1] || 81;
  const overallRecruitmentTarget = studyTargets.overallRecruitmentTarget || targetSchedule.targetPatients?.[targetSchedule.targetPatients.length - 1] || 1620;

  const countrySet = new Set(records.map(r => r.country).filter(Boolean));
  Object.values(siteMeta).forEach(meta => { if(meta?.country) countrySet.add(meta.country); });
  const allCountries = [...countrySet].sort();
  const allStatuses = [...new Set(records.map(r => r.patientStatus).filter(Boolean))].sort();
  const allOutcomes = [...new Set(records.map(r => r.outcome).filter(Boolean))].sort();
  const minDate = isoDateMin(records) || studyStartDate;
  const maxDate = isoDateMax(records) || minDate;

  const els = {
    pageTitle: document.getElementById('pageTitle'),
    pageSubtitle: document.getElementById('pageSubtitle'),
    lastUpdate: document.getElementById('lastUpdate'),
    targetPct: document.getElementById('targetPct'),
    positivePct: document.getElementById('positivePct'),
    kpiGrid: document.getElementById('kpiGrid'),
    totalCasesTable: document.getElementById('totalCasesTable'),
    last14Table: document.getElementById('last14Table'),
    last30Table: document.getElementById('last30Table'),
    last60Table: document.getElementById('last60Table'),
    last14Heading: document.getElementById('last14Heading'),
    last30Heading: document.getElementById('last30Heading'),
    last60Heading: document.getElementById('last60Heading'),
    truePositiveTable: document.getElementById('truePositiveTable'),
    truePositiveSearch: document.getElementById('truePositiveSearch'),
    exportTruePositiveCsv: document.getElementById('exportTruePositiveCsv'),
    recentRecordsTable: document.getElementById('recentRecordsTable'),
    activeFilters: document.getElementById('activeFilters'),
    countryFilter: document.getElementById('countryFilter'),
    siteFilter: document.getElementById('siteFilter'),
    statusFilter: document.getElementById('statusFilter'),
    outcomeFilter: document.getElementById('outcomeFilter'),
    positiveFilter: document.getElementById('positiveFilter'),
    dateFromFilter: document.getElementById('dateFromFilter'),
    dateToFilter: document.getElementById('dateToFilter'),
    resetFilters: document.getElementById('resetFilters'),
    countryLegend: document.getElementById('countryLegend'),
    classificationLegend: document.getElementById('classificationLegend'),
    recordsPrev: document.getElementById('recordsPrev'),
    recordsNext: document.getElementById('recordsNext'),
    recordsPageInfo: document.getElementById('recordsPageInfo')
  };

  const RECORDS_PAGE_SIZE = 20;
  let recordsPage = 1;
  let filteredRecordsForPagination = [];
  let currentTruePositiveRows = [];

  function fillSelect(select, options, allLabel){
    if(!select) return;
    select.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = allLabel;
    select.appendChild(allOpt);
    options.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      select.appendChild(option);
    });
  }

  fillSelect(els.countryFilter, allCountries, 'All countries');
  fillSelect(els.siteFilter, siteOrder, 'All sites');
  fillSelect(els.statusFilter, allStatuses, 'All statuses');
  fillSelect(els.outcomeFilter, allOutcomes, 'All outcomes');
  fillSelect(els.positiveFilter, ['Yes','No'], 'All true-positive states');
  if(els.dateFromFilter && els.dateToFilter){
    els.dateFromFilter.value = minDate;
    els.dateToFilter.value = maxDate;
    els.dateFromFilter.min = minDate;
    els.dateFromFilter.max = maxDate;
    els.dateToFilter.min = minDate;
    els.dateToFilter.max = maxDate;
  }

  if(els.pageTitle) els.pageTitle.textContent = DATA.meta?.pageTitle || 'NIHR RIGHT4 Methanol Dashboard';
  if(els.pageSubtitle) els.pageSubtitle.textContent = DATA.meta?.pageSubtitle || 'Operational recruitment, screening, and true-positive monitoring based on the eCRF.';
  if(els.lastUpdate) els.lastUpdate.textContent = DATA.meta?.generatedAt ? toShortDate(DATA.meta.generatedAt.slice(0,10)) : '-';

  function getFilters(){
    return {
      country: els.countryFilter?.value || '',
      site: els.siteFilter?.value || '',
      status: els.statusFilter?.value || '',
      outcome: els.outcomeFilter?.value || '',
      positive: els.positiveFilter?.value || '',
      dateFrom: els.dateFromFilter?.value || '',
      dateTo: els.dateToFilter?.value || '',
    };
  }

  function getFilteredRecords(){
    const f = getFilters();
    return records.filter(r => {
      if (f.country && r.country !== f.country) return false;
      if (f.site && r.siteCode !== f.site) return false;
      if (f.status && r.patientStatus !== f.status) return false;
      if (f.outcome && r.outcome !== f.outcome) return false;
      if (f.positive && r.truePositive !== f.positive) return false;
      if (f.dateFrom && r.screeningDate < f.dateFrom) return false;
      if (f.dateTo && r.screeningDate > f.dateTo) return false;
      return true;
    });
  }

  function activeFilterChips(){
    const f = getFilters();
    const chips = [];
    if (f.country) chips.push(`Country: ${f.country}`);
    if (f.site) chips.push(`Site: ${f.site}`);
    if (f.status) chips.push(`Status: ${f.status}`);
    if (f.outcome) chips.push(`Outcome: ${f.outcome}`);
    if (f.positive) chips.push(`True positive: ${f.positive}`);
    if (f.dateFrom) chips.push(`From: ${toShortDate(f.dateFrom)}`);
    if (f.dateTo) chips.push(`To: ${toShortDate(f.dateTo)}`);
    return chips;
  }

  function groupedBySiteRows(rows){
    const mapped = siteOrder.map(code => {
      const subset = rows.filter(r => r.siteCode === code);
      return {
        siteCode: code,
        siteLabel: siteMeta[code]?.label || code,
        screened: subset.length,
        recruited: subset.filter(r => r.isEnrolled).length,
        excluded: subset.filter(r => r.isExcluded).length,
        diedEnrolled: subset.filter(r => r.isDiedEnrolled).length,
      };
    });
    mapped.push({
      siteCode: 'TOTAL',
      siteLabel: 'Total',
      screened: rows.length,
      recruited: rows.filter(r => r.isEnrolled).length,
      excluded: rows.filter(r => r.isExcluded).length,
      diedEnrolled: rows.filter(r => r.isDiedEnrolled).length,
    });
    return mapped;
  }

  function renderTable(mount, rows){
    if(!mount) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    table.className = 'r4-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Site</th>
          <th>Screened</th>
          <th>Recruited</th>
          <th>Excluded</th>
          <th>Died (Enrolled)</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(row => `
          <tr class="${row.siteCode === 'TOTAL' ? 'total-row' : ''}">
            <td>${escapeHTML(row.siteLabel)}</td>
            <td>${fmtInt.format(row.screened)}</td>
            <td>${fmtInt.format(row.recruited)}</td>
            <td>${fmtInt.format(row.excluded)}</td>
            <td>${fmtInt.format(row.diedEnrolled)}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    wrap.appendChild(table);
    mount.innerHTML = '';
    mount.appendChild(wrap);
  }

  function renderRecent(rows){
    if(!els.recentRecordsTable) return;
    filteredRecordsForPagination = [...rows];
    const totalPages = Math.max(1, Math.ceil(filteredRecordsForPagination.length / RECORDS_PAGE_SIZE));
    if (recordsPage > totalPages) recordsPage = totalPages;
    if (recordsPage < 1) recordsPage = 1;

    const start = (recordsPage - 1) * RECORDS_PAGE_SIZE;
    const pageRows = filteredRecordsForPagination.slice(start, start + RECORDS_PAGE_SIZE);

    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    if(!pageRows.length){
      wrap.innerHTML = '<div class="empty-note">No records are available under the current filters.</div>';
      els.recentRecordsTable.innerHTML = '';
      els.recentRecordsTable.appendChild(wrap);
      if (els.recordsPageInfo) els.recordsPageInfo.textContent = 'Page 1 of 1';
      if (els.recordsPrev) els.recordsPrev.disabled = true;
      if (els.recordsNext) els.recordsNext.disabled = true;
      return;
    }

    const table = document.createElement('table');
    table.className = 'r4-table records-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Patient ID</th>
          <th>Site</th>
          <th>Date</th>
          <th>Status</th>
          <th>Outcome</th>
          <th>True Positive</th>
          <th>Base Deficit</th>
          <th>Comment</th>
        </tr>
      </thead>
      <tbody>
        ${pageRows.map(row => `
          <tr>
            <td>${escapeHTML(row.patientId)}</td>
            <td>${escapeHTML(row.siteCode)}</td>
            <td>${toShortDate(row.screeningDate)}</td>
            <td>${escapeHTML(row.patientStatus || '-')}</td>
            <td>${escapeHTML(row.outcome || '-')}</td>
            <td><span class="status-badge ${row.isTruePositive ? 'positive' : 'neutral'}">${escapeHTML(row.truePositive)}</span></td>
            <td>${escapeHTML(row.baseDeficit || '-')}</td>
            <td>${escapeHTML(row.comment || '-')}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    wrap.appendChild(table);
    els.recentRecordsTable.innerHTML = '';
    els.recentRecordsTable.appendChild(wrap);

    if (els.recordsPageInfo) els.recordsPageInfo.textContent = `Page ${recordsPage} of ${totalPages}`;
    if (els.recordsPrev) els.recordsPrev.disabled = recordsPage <= 1;
    if (els.recordsNext) els.recordsNext.disabled = recordsPage >= totalPages;
  }

  function truePositiveSearchText(row){
    return [row.patientId, row.siteCode, row.country, row.screeningDate, row.patientStatus, row.outcome, row.baseDeficit, row.comment, row.excludedReason]
      .map(v => String(v || '').toLowerCase()).join(' ');
  }

  function renderTruePositive(rows){
    if(!els.truePositiveTable) return;
    const q = (els.truePositiveSearch?.value || '').trim().toLowerCase();
    currentTruePositiveRows = rows
      .filter(r => r.isTruePositive)
      .filter(r => !q || truePositiveSearchText(r).includes(q))
      .sort((a,b) => (a.screeningDate < b.screeningDate ? 1 : a.screeningDate > b.screeningDate ? -1 : a.patientId.localeCompare(b.patientId)));

    const wrap = document.createElement('div');
    wrap.className = 'table-wrap true-positive-wrap';
    if(!currentTruePositiveRows.length){
      wrap.innerHTML = '<div class="empty-note">No true-positive cases match the current filters/search.</div>';
      els.truePositiveTable.innerHTML = '';
      els.truePositiveTable.appendChild(wrap);
      return;
    }

    const table = document.createElement('table');
    table.className = 'r4-table true-positive-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Patient ID</th>
          <th>Site</th>
          <th>Country</th>
          <th>Screening date</th>
          <th>Status</th>
          <th>Outcome</th>
          <th>Base Deficit</th>
          <th>Comment</th>
          <th>Excluded reason</th>
        </tr>
      </thead>
      <tbody>
        ${currentTruePositiveRows.map(row => `
          <tr>
            <td><strong>${escapeHTML(row.patientId)}</strong></td>
            <td>${escapeHTML(row.siteCode)}</td>
            <td>${escapeHTML(row.country || '-')}</td>
            <td>${toShortDate(row.screeningDate)}</td>
            <td>${escapeHTML(row.patientStatus || '-')}</td>
            <td><span class="status-badge ${String(row.outcome).toLowerCase() === 'died' ? 'danger' : 'positive'}">${escapeHTML(row.outcome || '-')}</span></td>
            <td>${escapeHTML(row.baseDeficit || '-')}</td>
            <td>${escapeHTML(row.comment || '-')}</td>
            <td>${escapeHTML(row.excludedReason || '-')}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    wrap.appendChild(table);
    els.truePositiveTable.innerHTML = '';
    els.truePositiveTable.appendChild(wrap);
  }

  function exportTruePositiveCsv(){
    const header = ['Patient ID','Site','Country','Screening Date','Status','Outcome','True Positive','Base Deficit','Comment','Excluded Reason'];
    const rows = currentTruePositiveRows.map(r => [r.patientId, r.siteCode, r.country, r.screeningDate, r.patientStatus, r.outcome, r.truePositive, r.baseDeficit, r.comment, r.excludedReason]);
    const csv = [header, ...rows]
      .map(line => line.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `right4_true_positive_cases_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function renderLegend(mount, items){
    if(!mount) return;
    if(!items.length){
      mount.innerHTML = '<div class="empty-note">No data under the current filters.</div>';
      return;
    }
    const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
    mount.innerHTML = items.map(item => {
      const pct = (item.value / total) * 100;
      return `
        <div class="mini-legend-row">
          <span class="legend-swatch" style="background:${item.color}"></span>
          <span class="legend-label">${escapeHTML(item.label)}</span>
          <span class="legend-value">${fmtInt.format(item.value)} | ${fmtPct(pct)}</span>
        </div>
      `;
    }).join('');
  }

  function donutLayout(centerLabel){
    const theme = themeTokens();
    return {
      margin:{l:8,r:8,t:8,b:8},
      paper_bgcolor:'rgba(0,0,0,0)',
      plot_bgcolor:'rgba(0,0,0,0)',
      font:{color:'#e8eefc'},
      showlegend:false,
      annotations:[{ text:centerLabel, x:0.5, y:0.5, showarrow:false, font:{size: small() ? 14 : 16, color:'#e8eefc'} }]
    };
  }
  function renderDonut(targetId, legendEl, items, centerLabel){
    if(!document.getElementById(targetId)) return;
    const theme = themeTokens();
    const safeItems = items.length ? items : [{ label:'No data', value:1, color:theme.empty }];
    Plotly.newPlot(targetId, [{
      type:'pie', labels:safeItems.map(i => i.label), values:safeItems.map(i => i.value), hole:0.68, textinfo:'none', sort:false, direction:'clockwise',
      marker:{ colors:safeItems.map(i => i.color), line:{ color:'rgba(2,8,23,0.92)', width:2 } },
      hovertemplate:'%{label}: %{value} (%{percent})<extra></extra>',
      hoverlabel:{ bgcolor:'#050816', bordercolor:'#60a5fa', font:{ color:'#ffffff', size:12 } }
    }], donutLayout(centerLabel), baseConfig());
    renderLegend(legendEl, items);
  }
  function chartAnnotation(text, x=0.035, y=0.965){
    const theme = themeTokens();
    return {
      xref:'paper', yref:'paper', x, y, xanchor:'left', yanchor:'top', align:'left', text, showarrow:false,
      bgcolor:theme.annotationBg, bordercolor:theme.annotationBorder, borderwidth:1, borderpad:9,
      font:{ size: small() ? 11 : 12, color:theme.annotationFont }
    };
  }
  function endpointLabel(text, x, y, color, xshift=16, yshift=16){
    const theme = themeTokens();
    return {
      xref:'x', yref:'y', x, y,
      text:`<b>${text}</b>`, showarrow:false,
      xanchor:'left', yanchor:'middle', xshift, yshift,
      bgcolor:theme.annotationBg,
      bordercolor:color || theme.annotationBorder,
      borderwidth:1, borderpad:4,
      font:{ size: small() ? 10 : 12, color:theme.annotationFont }
    };
  }

  function timelineXAxis(title){
    return {
      ...axisBase(title),
      type:'date',
      tickmode:'array',
      tickvals:['2025-06-01','2025-09-01','2025-12-01','2026-03-01','2026-06-01','2026-09-01','2026-12-31'],
      ticktext:['Jun 2025','Sep 2025','Dec 2025','Mar 2026','Jun 2026','Sep 2026','Dec 2026'],
      range:[addDaysIso(studyStartDate, -18), addDaysIso(studyEndDate, 38)],
      tickangle:-45,
      automargin:true
    };
  }

  function axisBase(title){
    const theme = themeTokens();
    return {
      title:{ text:title, font:{ color:theme.chartFont } }, tickfont:{ size:small()?10:12, color:theme.chartMuted },
      gridcolor:theme.chartGrid, zerolinecolor:theme.chartZero, linecolor:theme.chartGrid, automargin:true
    };
  }
  function transparentLayout(extra = {}){
    const theme = themeTokens();
    return {
      margin:{l:56,r:24,t:10,b:66}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)', font:{ color:theme.chartFont },
      hoverlabel:{ bgcolor:theme.hoverBg, bordercolor:theme.hoverBorder, font:{ color:theme.hoverFont, size:12 } },
      ...extra
    };
  }

  function buildCountMap(rows, predicate = null){
    const map = new Map();
    rows.forEach(r => {
      if(predicate && !predicate(r)) return;
      map.set(r.screeningDate, (map.get(r.screeningDate) || 0) + 1);
    });
    return map;
  }

  function buildCumulativeSeries(dateRange, countMap){
    let running = 0;
    return dateRange.map(date => {
      running += countMap.get(date) || 0;
      return running;
    });
  }

  function buildLinearSeries(dateRange, startValue, endValue){
    if(!dateRange.length) return [];
    const start = parseIsoDateUTC(dateRange[0]);
    const end = parseIsoDateUTC(dateRange[dateRange.length - 1]);
    const span = Math.max((end - start) / 86400000, 1);
    return dateRange.map(iso => {
      const cur = parseIsoDateUTC(iso);
      const fraction = Math.max(0, Math.min(1, ((cur - start) / 86400000) / span));
      return startValue + ((endValue - startValue) * fraction);
    });
  }

  function renderCharts(rows){
    const theme = themeTokens();
    const enrolledRows = rows.filter(r => r.isEnrolled);
    const recruitedTotal = enrolledRows.length;
    const truePositiveRows = rows.filter(r => r.isTruePositive);
    const truePositiveTotal = truePositiveRows.length;
    const positiveRatePct = recruitedTotal ? (truePositiveTotal / recruitedTotal) * 100 : 0;
    const truePositiveTargetPct = truePositiveTarget ? ((truePositiveTotal / truePositiveTarget) * 100) : 0;
    const calculatedTargetEnd = positiveRatePct > 0
      ? Math.round(overallRecruitmentTarget / (positiveRatePct / 5))
      : 0;

    const countryItems = [];
    const countryMap = new Map();
    const countryOrder = ['Bangladesh', 'India', 'Other'];
    enrolledRows.forEach(r => countryMap.set(r.country, (countryMap.get(r.country) || 0) + 1));
    const countryEntries = [...countryMap.entries()].sort((a,b) => {
      const aRank = countryOrder.indexOf(a[0]);
      const bRank = countryOrder.indexOf(b[0]);
      const safeARank = aRank === -1 ? 999 : aRank;
      const safeBRank = bRank === -1 ? 999 : bRank;
      if(safeARank !== safeBRank) return safeARank - safeBRank;
      return String(a[0]).localeCompare(String(b[0]));
    });
    countryEntries.forEach(([label, value], idx) => {
      const color = theme.countryColors?.[label] || theme.countryColors?.Other || theme.series[idx % theme.series.length];
      countryItems.push({ label, value, color });
    });
    renderDonut('countryChart', els.countryLegend, countryItems, `Enrolled<br><b>${fmtInt.format(recruitedTotal)}</b>`);

    const classificationItems = [
      { label:'True Positive', value:truePositiveTotal, color:theme.classificationTrue },
      { label:'Other Enrolled', value:Math.max(recruitedTotal - truePositiveTotal, 0), color:theme.classificationOther }
    ].filter(item => item.value > 0);
    renderDonut('classificationChart', els.classificationLegend, classificationItems, `Positive<br><b>${fmtInt.format(truePositiveTotal)}</b>`);

    const f = getFilters();
    const actualRecruitmentEndDate = enrolledRows.length ? isoDateMax(enrolledRows) : studyStartDate;
    const truePositiveEndDate = truePositiveRows.length ? isoDateMax(truePositiveRows) : studyStartDate;
    const targetCalendarDates = buildIsoDateRange(studyStartDate, studyEndDate);
    const recruitmentCalendarDates = buildIsoDateRange(studyStartDate, actualRecruitmentEndDate);
    const actualPatientDates = buildIsoDateRange(studyStartDate, actualRecruitmentEndDate);
    const actualPositiveDates = buildIsoDateRange(studyStartDate, truePositiveEndDate);
    const visibleSites = f.site ? [f.site] : siteOrder;

    const recruitmentTraces = visibleSites.map((code, idx) => {
      const siteCountMap = buildCountMap(enrolledRows.filter(r => r.siteCode === code));
      const y = buildCumulativeSeries(recruitmentCalendarDates, siteCountMap);
      return { type:'scatter', mode:'lines', x:recruitmentCalendarDates, y, name:code, line:{ width: code === 'CoxMCH' ? 2.6 : 2.2, color:theme.series[idx % theme.series.length] }, hovertemplate:`${code}: %{y}<extra></extra>` };
    });
    const totalSeries = recruitmentCalendarDates.map((_, idx) => recruitmentTraces.reduce((sum, tr) => sum + (tr.y[idx] || 0), 0));
    if(!f.site){
      recruitmentTraces.push({
        type:'scatter', mode:'lines+text', x:recruitmentCalendarDates, y:totalSeries,
        text:totalSeries.map((v, idx) => idx === totalSeries.length - 1 && v ? fmtInt.format(v) : ''), textposition:'top right', name:'Total',
        line:{ width:4.2, color:theme.total }, cliponaxis:false, hovertemplate:'Total: %{y}<extra></extra>'
      });
    }
    Plotly.newPlot('recruitmentGraph', recruitmentTraces, transparentLayout({
      margin:{l:56,r:84,t:14,b:92}, hovermode:'x unified', hoverdistance:24, spikedistance:24,
      xaxis:timelineXAxis('Date'),
      yaxis:{ ...axisBase('Cumulative recruited'), rangemode:'tozero', range:[0, Math.max(600, recruitedTotal * 1.25 + 25)] },
      legend:{ orientation:small()?'h':'v', y:small()?-0.34:1, x:0, title:{text:''}, traceorder:'normal', font:{color:theme.chartFont} }
    }), baseConfig());

    const enrolledCountMap = buildCountMap(enrolledRows);
    const actualPatients = buildCumulativeSeries(actualPatientDates, enrolledCountMap);
    const targetPatientsLine = buildLinearSeries(targetCalendarDates, 0, overallRecruitmentTarget);
    const calculatedTargetLine = buildLinearSeries(targetCalendarDates, 0, calculatedTargetEnd);
    Plotly.newPlot('targetActualChart', [
      { type:'scatter', mode:'lines', x:targetCalendarDates, y:targetPatientsLine, name:'Target patients', cliponaxis:false, line:{ width:3.1, color:theme.targetLine }, hovertemplate:'Target patients<br>%{x}: %{y:.0f}<extra></extra>' },
      { type:'scatter', mode:'lines', x:targetCalendarDates, y:calculatedTargetLine, name:'Calculated target', cliponaxis:false, line:{ width:2.8, color:theme.calculatedLine, dash:'dashdot' }, hovertemplate:'Calculated target<br>%{x}: %{y:.0f}<extra></extra>' },
      { type:'scatter', mode:'lines+markers', x:actualPatientDates, y:actualPatients, name:'Actual patients', cliponaxis:false, line:{ width:3.3, color:theme.actualLine }, marker:{size:4, color:theme.actualLine}, hovertemplate:'Actual patients<br>%{x}: %{y}<extra></extra>' }
    ], transparentLayout({
      margin:{l:56,r:104,t:24,b:94}, hovermode:'x unified', hoverdistance:24, spikedistance:24,
      xaxis:timelineXAxis('Date'),
      yaxis:{ ...axisBase('Patients'), rangemode:'tozero', range:[0, Math.max(overallRecruitmentTarget * 1.12, calculatedTargetEnd * 1.18, recruitedTotal * 1.35, 1700)] }, legend:{ orientation:'h', y:-0.32, x:0, font:{color:theme.chartFont} },
      annotations:[
        chartAnnotation(`<b>Recruitment progress</b><br>${fmtInt.format(recruitedTotal)} recruited out of ${fmtInt.format(overallRecruitmentTarget)} target (${fmtPct((recruitedTotal / overallRecruitmentTarget) * 100)})`),
        endpointLabel(fmtInt.format(overallRecruitmentTarget), studyEndDate, overallRecruitmentTarget, theme.targetLine, 12, 20),
        calculatedTargetEnd ? endpointLabel(fmtInt.format(calculatedTargetEnd), studyEndDate, calculatedTargetEnd, theme.calculatedLine, 12, -22) : null,
        actualPatients.length ? endpointLabel(fmtInt.format(actualPatients[actualPatients.length - 1] || 0), actualRecruitmentEndDate, actualPatients[actualPatients.length - 1] || 0, theme.actualLine, 12, 22) : null
      ].filter(Boolean)
    }), baseConfig());

    const positiveCountMap = buildCountMap(truePositiveRows);
    const actualPositive = buildCumulativeSeries(actualPositiveDates, positiveCountMap);
    const positiveTargetLine = buildLinearSeries(targetCalendarDates, 0, truePositiveTarget);
    Plotly.newPlot('positiveTargetChart', [
      { type:'scatter', mode:'lines', x:targetCalendarDates, y:positiveTargetLine, name:'Target positive', cliponaxis:false, line:{ width:3.0, color:theme.positiveTarget }, hovertemplate:'Target positive<br>%{x}: %{y:.0f}<extra></extra>' },
      { type:'scatter', mode:'lines+markers', x:actualPositiveDates, y:actualPositive, name:'True positive', cliponaxis:false, line:{ width:3.3, color:theme.truePositive }, marker:{size:4, color:theme.truePositive}, hovertemplate:'True positive<br>%{x}: %{y}<extra></extra>' }
    ], transparentLayout({
      margin:{l:56,r:104,t:24,b:94}, hovermode:'x unified', hoverdistance:24, spikedistance:24,
      xaxis:timelineXAxis('Date'),
      yaxis:{ ...axisBase('Patients'), rangemode:'tozero', range:[0, Math.max(truePositiveTarget * 1.16, truePositiveTotal * 1.35 + 8, 95)] }, legend:{ orientation:'h', y:-0.32, x:0, font:{color:theme.chartFont} },
      annotations:[
        chartAnnotation(`<b>True-positive progress</b><br>${fmtInt.format(truePositiveTotal)} observed out of ${fmtInt.format(truePositiveTarget)} target (${fmtPct(truePositiveTargetPct)})`),
        endpointLabel(fmtInt.format(truePositiveTarget), studyEndDate, truePositiveTarget, theme.positiveTarget, 12, 20),
        actualPositive.length ? endpointLabel(fmtInt.format(actualPositive[actualPositive.length - 1] || 0), truePositiveEndDate, actualPositive[actualPositive.length - 1] || 0, theme.truePositive, 12, -20) : null
      ].filter(Boolean)
    }), baseConfig());

    const monthKeys = [...new Set(enrolledRows.map(r => r.screeningDate.slice(0,7)))].sort();
    const monthDates = monthKeys.map(key => `${key}-01`);
    const monthMap = new Map();
    monthKeys.forEach(k => monthMap.set(k, {}));
    enrolledRows.forEach(r => {
      const key = r.screeningDate.slice(0,7);
      const bucket = monthMap.get(key) || {};
      bucket[r.siteCode] = (bucket[r.siteCode] || 0) + 1;
      monthMap.set(key, bucket);
    });
    const monthlyOrder = monthlyPreferredOrder.filter(code => siteOrder.includes(code) && (f.site ? f.site === code : rows.some(r => r.siteCode === code) || code === 'CoxMCH')).concat(siteOrder.filter(code => !monthlyPreferredOrder.includes(code) && (f.site ? f.site === code : rows.some(r => r.siteCode === code))));
    const monthlyTraces = monthlyOrder.map((code, idx) => ({ type:'bar', x:monthDates, y:monthKeys.map(key => (monthMap.get(key)?.[code] || 0)), name:code, marker:{ color:theme.series[idx % theme.series.length], line:{color:theme.countryLine, width:0.6} }, hovertemplate:`${code}<br>%{x|%b %Y}: %{y}<extra></extra>` }));
    const monthlyTotals = monthDates.map((_, idx) => monthlyTraces.reduce((sum, tr) => sum + (tr.y[idx] || 0), 0));
    monthlyTraces.push({ type:'scatter', mode:'text', x:monthDates, y:monthlyTotals, text:monthlyTotals.map(v => v ? fmtInt.format(v) : ''), textposition:'top center', showlegend:false, hoverinfo:'skip', textfont:{color:theme.chartFont} });
    Plotly.newPlot('monthlyChart', monthlyTraces, transparentLayout({
      barmode:'stack', margin:{l:56,r:24,t:10,b:96}, xaxis:timelineXAxis('Month'), yaxis:{ ...axisBase('Recruited patients'), rangemode:'tozero' }, legend:{ orientation:'h', y:-0.30, x:0, traceorder:'normal', font:{color:theme.chartFont} }
    }), baseConfig());

    const exclusionMap = new Map();
    rows.filter(r => r.isExcluded).forEach(r => {
      const key = r.excludedReason || 'Not specified';
      exclusionMap.set(key, (exclusionMap.get(key) || 0) + 1);
    });
    const exclusionItems = [...exclusionMap.entries()].sort((a,b) => b[1] - a[1]).slice(0,8).reverse();
    Plotly.newPlot('exclusionChart', [{ type:'bar', orientation:'h', x:exclusionItems.map(i=>i[1]), y:exclusionItems.map(i=>i[0]), text:exclusionItems.map(i=>fmtInt.format(i[1])), textposition:'outside', cliponaxis:false, marker:{ color:exclusionItems.map((_,i)=>theme.series[i % theme.series.length]), line:{ color:theme.countryLine, width:0.6 } }, hovertemplate:'%{y}: %{x}<extra></extra>' }], transparentLayout({
      margin:{l:140,r:44,t:10,b:40}, xaxis:{ ...axisBase('Count'), rangemode:'tozero' }, yaxis:{ tickfont:{ color:theme.chartMuted, size:small()?10:12 }, automargin:true }
    }), baseConfig());
  }

  function renderSummary(rows){
    const screened = rows.length;
    const enrolled = rows.filter(r => r.isEnrolled).length;
    const excluded = rows.filter(r => r.isExcluded).length;
    const diedEnrolled = rows.filter(r => r.isDiedEnrolled).length;
    const positive = rows.filter(r => r.isTruePositive).length;
    const positivePct = enrolled ? (positive / enrolled) * 100 : 0;
    const targetPct = overallRecruitmentTarget ? (enrolled / overallRecruitmentTarget) * 100 : 0;

    if(els.targetPct) els.targetPct.textContent = enrolled ? fmtPct(targetPct) : '-';
    if(els.positivePct) els.positivePct.textContent = enrolled ? fmtPct(positivePct) : '-';

    const cards = [
      ['Screened patients', screened, 'Records captured'],
      ['Recruited patients', enrolled, `${fmtPct(targetPct)} of target`],
      ['Excluded patients', excluded, 'Not recruited'],
      ['True positive cases', positive, `${fmtPct(positivePct)} of recruited`],
      ['Died among enrolled', diedEnrolled, 'Enrolled outcome'],
    ];
    if(els.kpiGrid){
      els.kpiGrid.innerHTML = cards.map(([label, value, sub]) => `
        <article class="kpi-card">
          <span class="eyebrow-sm">${escapeHTML(label)}</span>
          <strong>${fmtInt.format(value)}</strong>
          <span class="sub">${escapeHTML(sub)}</span>
        </article>
      `).join('');
    }
  }

  function lastNDaysRows(rows, n){
    if(!rows.length) return [];
    const maxIso = isoDateMax(rows);
    const end = parseIsoDateUTC(maxIso);
    const start = new Date(end.getTime());
    start.setUTCDate(start.getUTCDate() - (n - 1));
    const startIso = toIsoFromUTC(start);
    return rows.filter(r => r.screeningDate >= startIso && r.screeningDate <= maxIso);
  }

  function renderAll(){
    const filtered = getFilteredRecords();
    const chips = activeFilterChips();
    if(els.activeFilters){
      els.activeFilters.innerHTML = chips.length ? chips.map(t => `<span class="filter-chip">${escapeHTML(t)}</span>`).join('') : '<span class="filter-chip">Showing all records</span>';
    }

    renderSummary(filtered);
    renderTable(els.totalCasesTable, groupedBySiteRows(filtered));
    renderTable(els.last14Table, groupedBySiteRows(lastNDaysRows(filtered, 14)));
    renderTable(els.last30Table, groupedBySiteRows(lastNDaysRows(filtered, 30)));
    renderTable(els.last60Table, groupedBySiteRows(lastNDaysRows(filtered, 60)));
    renderTruePositive(filtered);
    renderRecent([...filtered].sort((a,b) => (a.screeningDate < b.screeningDate ? 1 : a.screeningDate > b.screeningDate ? -1 : a.patientId.localeCompare(b.patientId))));
    renderCharts(filtered);
  }

  [els.countryFilter, els.siteFilter, els.statusFilter, els.outcomeFilter, els.positiveFilter, els.dateFromFilter, els.dateToFilter].filter(Boolean).forEach(el => {
    el.addEventListener('change', () => { recordsPage = 1; renderAll(); });
  });
  if(els.truePositiveSearch){
    els.truePositiveSearch.addEventListener('input', () => renderTruePositive(getFilteredRecords()));
  }
  if(els.exportTruePositiveCsv){
    els.exportTruePositiveCsv.addEventListener('click', exportTruePositiveCsv);
  }
  if(els.resetFilters){
    els.resetFilters.addEventListener('click', () => {
      els.countryFilter.value = '';
      els.siteFilter.value = '';
      els.statusFilter.value = '';
      els.outcomeFilter.value = '';
      els.positiveFilter.value = '';
      els.dateFromFilter.value = minDate;
      els.dateToFilter.value = maxDate;
      if(els.truePositiveSearch) els.truePositiveSearch.value = '';
      recordsPage = 1;
      renderAll();
    });
  }
  if (els.recordsPrev) els.recordsPrev.addEventListener('click', () => { recordsPage -= 1; renderRecent([...filteredRecordsForPagination]); });
  if (els.recordsNext) els.recordsNext.addEventListener('click', () => { recordsPage += 1; renderRecent([...filteredRecordsForPagination]); });

  window.__RIGHT4_RENDER_ALL__ = renderAll;
  window.addEventListener('right4-theme-change', () => renderAll());

  renderAll();
})();
