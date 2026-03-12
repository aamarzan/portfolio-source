(async function(){
  const small = () => window.matchMedia('(max-width: 820px)').matches;
  const baseConfig = () => ({
    displayModeBar: false,
    responsive: true,
    staticPlot: small(),
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
  const colors = ['#1f63ff','#18b5ff','#0f355c','#14a44d','#8b5cf6','#f59e0b','#ef4444','#06b6d4','#64748b','#10b981'];
  const monthlyPreferredOrder = ['CMCH', 'RMCH', 'DMCH', 'SZMCH', 'SOMCH', 'PGIMER', 'SGRDUHS', 'GGSMCH'];

  const records = DATA.records.map((r, idx) => ({ ...r, _idx: idx, screeningTs: parseIsoDateUTC(r.screeningDate) }));
  const siteOrder = (DATA.config && DATA.config.siteOrder) || [...new Set(records.map(r => r.siteCode))];
  const siteMeta = (DATA.config && DATA.config.siteMeta) || Object.fromEntries(siteOrder.map(code => [code, {label: code, country: 'Other'}]));
  const targetSchedule = (DATA.config && DATA.config.targetSchedule) || { dates: [], targetPatients: [], calculatedTarget: [] };
  const positiveTargetSchedule = (DATA.config && DATA.config.truePositiveTargetSchedule) || { dates: [], targetPositive: [] };
  const studyTargets = (DATA.config && DATA.config.studyTargets) || {};
  const truePositiveTarget = studyTargets.truePositiveTarget || positiveTargetSchedule.targetPositive[positiveTargetSchedule.targetPositive.length - 1] || 81;

  const allCountries = [...new Set(records.map(r => r.country).filter(Boolean))].sort();
  const allStatuses = [...new Set(records.map(r => r.patientStatus).filter(Boolean))].sort();
  const allOutcomes = [...new Set(records.map(r => r.outcome).filter(Boolean))].sort();
  const minDate = isoDateMin(records);
  const maxDate = isoDateMax(records);

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
    last14Heading: document.getElementById('last14Heading'),
    last30Heading: document.getElementById('last30Heading'),
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

  function fillSelect(select, options, allLabel){
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
  els.dateFromFilter.value = minDate;
  els.dateToFilter.value = maxDate;
  els.dateFromFilter.min = minDate;
  els.dateFromFilter.max = maxDate;
  els.dateToFilter.min = minDate;
  els.dateToFilter.max = maxDate;

  els.pageTitle.textContent = DATA.meta?.pageTitle || 'NIHR RIGHT4 Methanol Dashboard';
  els.pageSubtitle.textContent = DATA.meta?.pageSubtitle || 'Operational recruitment, screening, and true-positive monitoring synced from the master workbook.';
  els.lastUpdate.textContent = DATA.meta?.generatedAt ? toShortDate(DATA.meta.generatedAt.slice(0,10)) : '-';

  function getFilters(){
    return {
      country: els.countryFilter.value,
      site: els.siteFilter.value,
      status: els.statusFilter.value,
      outcome: els.outcomeFilter.value,
      positive: els.positiveFilter.value,
      dateFrom: els.dateFromFilter.value,
      dateTo: els.dateToFilter.value,
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
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    if(!rows.length){
      wrap.innerHTML = '<div class="empty-note">No records match the current filter selection.</div>';
      mount.innerHTML = '';
      mount.appendChild(wrap);
      return;
    }
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
            <td>${row.siteLabel}</td>
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
    table.className = 'r4-table';
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
            <td>${row.patientId}</td>
            <td>${row.siteCode}</td>
            <td>${toShortDate(row.screeningDate)}</td>
            <td>${row.patientStatus}</td>
            <td>${row.outcome}</td>
            <td>${row.truePositive}</td>
            <td>${row.baseDeficit ?? '-'}</td>
            <td>${row.comment || '-'}</td>
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
          <span class="legend-label">${item.label}</span>
          <span class="legend-value">${fmtInt.format(item.value)} | ${fmtPct(pct)}</span>
        </div>
      `;
    }).join('');
  }

  function donutLayout(centerLabel){
    return {
      margin:{l:8,r:8,t:8,b:8},
      paper_bgcolor:'rgba(0,0,0,0)',
      plot_bgcolor:'rgba(0,0,0,0)',
      showlegend:false,
      annotations:[{
        text:centerLabel,
        x:0.5,
        y:0.5,
        showarrow:false,
        font:{size: small() ? 14 : 16, color:'#395778'}
      }]
    };
  }

  function renderDonut(targetId, legendEl, items, centerLabel){
    const safeItems = items.length ? items : [{ label:'No data', value:1, color:'#cbd5e1' }];
    Plotly.newPlot(targetId, [{
      type:'pie',
      labels:safeItems.map(i => i.label),
      values:safeItems.map(i => i.value),
      hole:0.68,
      textinfo:'none',
      sort:false,
      direction:'clockwise',
      marker:{
        colors:safeItems.map(i => i.color),
        line:{ color:'#ffffff', width:2 }
      },
      hovertemplate:'%{label}: %{value} (%{percent})<extra></extra>',
      hoverlabel:{ bgcolor:'#000000', bordercolor:'#000000', font:{ color:'#ffffff', size:12 } }
    }], donutLayout(centerLabel), baseConfig());
    renderLegend(legendEl, items);
  }

  function chartAnnotation(text, x=0.03, y=0.98){
    return {
      xref:'paper', yref:'paper', x, y,
      xanchor:'left', yanchor:'top', align:'left', text,
      showarrow:false,
      bgcolor:'rgba(255,255,255,0.92)',
      bordercolor:'rgba(19,36,59,0.14)', borderwidth:1, borderpad:8,
      font:{ size: small() ? 11 : 12, color:'#234361' }
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

  function renderCharts(rows){
    const enrolledRows = rows.filter(r => r.isEnrolled);
    const recruitedTotal = enrolledRows.length;
    const truePositiveRows = rows.filter(r => r.isTruePositive);
    const truePositiveTotal = truePositiveRows.length;
    const positiveRate = recruitedTotal ? (truePositiveTotal / recruitedTotal) : 0;
    const positiveRatePct = positiveRate * 100;
    const truePositiveTargetPct = truePositiveTarget ? ((truePositiveTotal / truePositiveTarget) * 100) : 0;
    const calculatedTargetCount = positiveRate > 0 ? (truePositiveTarget / positiveRate) : null;
    const calculatedTargetRounded = calculatedTargetCount !== null ? Math.round(calculatedTargetCount) : null;

    const countryItems = [];
    const countryMap = new Map();
    enrolledRows.forEach(r => countryMap.set(r.country, (countryMap.get(r.country) || 0) + 1));
    [...countryMap.entries()].sort((a,b) => b[1] - a[1]).forEach(([label, value], idx) => countryItems.push({ label, value, color: colors[idx % colors.length] }));
    renderDonut('countryChart', els.countryLegend, countryItems, `Enrolled<br><b>${fmtInt.format(recruitedTotal)}</b>`);

    const classificationItems = [
      { label:'True Positive', value:truePositiveTotal, color:'#14a44d' },
      { label:'Other Enrolled', value:Math.max(recruitedTotal - truePositiveTotal, 0), color:'#7a8da8' }
    ].filter(item => item.value > 0);
    renderDonut('classificationChart', els.classificationLegend, classificationItems, `Positive<br><b>${fmtInt.format(truePositiveTotal)}</b>`);

    const effectiveMin = rows.length ? isoDateMin(rows) : minDate;
    const effectiveMax = rows.length ? isoDateMax(rows) : maxDate;
    const calendarDates = buildIsoDateRange(effectiveMin, effectiveMax);

    const recruitmentTraces = siteOrder.map((code, idx) => {
      const siteCountMap = buildCountMap(enrolledRows.filter(r => r.siteCode === code));
      const y = buildCumulativeSeries(calendarDates, siteCountMap);
      return {
        type:'scatter', mode:'lines', x: calendarDates, y,
        name: code,
        line:{ width:2, color:colors[idx % colors.length] },
        hovertemplate:`${code}: %{y}<extra></extra>`
      };
    });
    const totalSeries = calendarDates.map((_, idx) => recruitmentTraces.reduce((sum, tr) => sum + (tr.y[idx] || 0), 0));
    recruitmentTraces.push({
      type:'scatter', mode:'lines+text', x: calendarDates, y: totalSeries,
      text: totalSeries.map((v, idx) => idx === totalSeries.length - 1 && v ? fmtInt.format(v) : ''),
      textposition:'top right', name:'Total',
      line:{ width:4, color:'#0f355c' }, cliponaxis:false,
      hovertemplate:'Total: %{y}<extra></extra>'
    });
    Plotly.newPlot('recruitmentGraph', recruitmentTraces, {
      margin:{l:56,r:24,t:10,b:62}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
      hovermode:'x unified',
      xaxis:{ title:'Date', tickfont:{ size:small()?10:12 }, gridcolor:'rgba(19,36,59,0.08)', automargin:true, range:[effectiveMin, effectiveMax] },
      yaxis:{ title:'Cumulative recruited', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)', automargin:true },
      legend:{ orientation:small()?'h':'v', y:small()?-0.34:1, x:0, title:{text:''}, traceorder:'normal' },
      hoverlabel:{ bgcolor:'#000000', bordercolor:'#000000', font:{ color:'#ffffff', size:12 } }
    }, baseConfig());

    const targetDates = targetSchedule.dates || [];
    const enrolledCountMap = buildCountMap(enrolledRows);
    const actualPatients = buildCumulativeSeries(calendarDates, enrolledCountMap);
    const targetPatientLastText = (targetSchedule.targetPatients || []).map((v, i, arr) => i === arr.length - 1 ? fmtInt.format(v) : '');
    const actualPatientsLastText = actualPatients.map((v, i, arr) => i === arr.length - 1 && arr.length ? fmtInt.format(v) : '');
    const targetActualTraces = [
      {
        type:'scatter', mode:'lines+markers+text', x:targetDates, y:targetSchedule.targetPatients,
        name:'Target patients', text:targetPatientLastText, textposition:'top center',
        line:{ width:2.6, color:'#1f63ff' },
        hovertemplate:'Target patients<br>%{x}: %{y}<extra></extra>'
      },
      {
        type:'scatter', mode:'lines+markers+text', x:calendarDates, y:actualPatients,
        name:'Actual patients', text:actualPatientsLastText, textposition:'top center',
        line:{ width:3, color:'#14a44d' },
        hovertemplate:'Actual patients<br>%{x}: %{y}<extra></extra>'
      }
    ];
    if(calculatedTargetRounded !== null && targetDates.length){
      targetActualTraces.splice(1, 0, {
        type:'scatter', mode:'lines+text', x:[targetDates[0], targetDates[targetDates.length - 1]], y:[0, calculatedTargetRounded],
        name:'Calculated target', text:['', fmtInt.format(calculatedTargetRounded)], textposition:'top right',
        line:{ width:2.2, dash:'dot', color:'#7c8cb1' },
        hovertemplate:'Calculated target<br>%{x}: %{y}<extra></extra>'
      });
    }
    Plotly.newPlot('targetActualChart', targetActualTraces, {
      margin:{l:56,r:24,t:10,b:66}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
      hovermode:'x unified',
      xaxis:{ title:'Date', tickfont:{ size:small()?10:12 }, tickangle:small()?-40:0, gridcolor:'rgba(19,36,59,0.08)', automargin:true },
      yaxis:{ title:'Patients', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)', automargin:true },
      legend:{ orientation:'h', y:-0.28, x:0 },
      hoverlabel:{ bgcolor:'#000000', bordercolor:'#000000', font:{ color:'#ffffff', size:12 } },
      annotations:[ chartAnnotation(`<b>True Positive Cases (%)</b><br>out of ${fmtInt.format(recruitedTotal)} enrolled patients (${fmtPct(positiveRatePct)})`) ]
    }, baseConfig());

    const positiveTargetDates = positiveTargetSchedule.dates || [];
    const positiveCountMap = buildCountMap(truePositiveRows);
    const actualPositive = buildCumulativeSeries(calendarDates, positiveCountMap);
    Plotly.newPlot('positiveTargetChart', [
      {
        type:'scatter', mode:'lines+markers+text', x:positiveTargetDates, y:positiveTargetSchedule.targetPositive,
        name:'Target positive', text:(positiveTargetSchedule.targetPositive || []).map((v, i, arr) => i === arr.length - 1 ? fmtInt.format(v) : ''),
        textposition:'top center', line:{ width:2.6, color:'#8b5cf6' },
        hovertemplate:'Target positive<br>%{x}: %{y}<extra></extra>'
      },
      {
        type:'scatter', mode:'lines+markers+text', x:calendarDates, y:actualPositive,
        name:'True positive', text:actualPositive.map((v, i, arr) => i === arr.length - 1 && arr.length ? fmtInt.format(v) : ''),
        textposition:'top center', line:{ width:3, color:'#f59e0b' },
        hovertemplate:'True positive<br>%{x}: %{y}<extra></extra>'
      }
    ], {
      margin:{l:56,r:24,t:10,b:66}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
      hovermode:'x unified',
      xaxis:{ title:'Date', tickfont:{ size:small()?10:12 }, tickangle:small()?-40:0, gridcolor:'rgba(19,36,59,0.08)', automargin:true },
      yaxis:{ title:'Patients', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)', automargin:true },
      legend:{ orientation:'h', y:-0.28, x:0 },
      hoverlabel:{ bgcolor:'#000000', bordercolor:'#000000', font:{ color:'#ffffff', size:12 } },
      annotations:[ chartAnnotation(`<b>True Positive Cases (%)</b><br>out of ${fmtInt.format(truePositiveTarget)} True Positive Target<br>(${fmtPct(truePositiveTargetPct)})`) ]
    }, baseConfig());

    const monthKeys = [...new Set(enrolledRows.map(r => r.screeningDate.slice(0,7)))].sort();
    const monthLabels = monthKeys.map(toMonthLabel);
    const monthMap = new Map();
    monthKeys.forEach(k => monthMap.set(k, {}));
    enrolledRows.forEach(r => {
      const key = r.screeningDate.slice(0,7);
      const bucket = monthMap.get(key) || {};
      bucket[r.siteCode] = (bucket[r.siteCode] || 0) + 1;
      monthMap.set(key, bucket);
    });
    const monthlyOrder = monthlyPreferredOrder.filter(code => siteOrder.includes(code) && rows.some(r => r.siteCode === code))
      .concat(siteOrder.filter(code => !monthlyPreferredOrder.includes(code) && rows.some(r => r.siteCode === code)));
    const monthlyTraces = monthlyOrder.map((code, idx) => ({
      type:'bar', x: monthLabels, y: monthKeys.map(key => (monthMap.get(key)?.[code] || 0)),
      name: code, marker:{ color: colors[idx % colors.length] }, hovertemplate:`${code}: %{y}<extra></extra>`
    }));
    const monthlyTotals = monthLabels.map((_, idx) => monthlyTraces.reduce((sum, tr) => sum + (tr.y[idx] || 0), 0));
    monthlyTraces.push({ type:'scatter', mode:'text', x: monthLabels, y: monthlyTotals, text: monthlyTotals.map(v => v ? fmtInt.format(v) : ''), textposition:'top center', showlegend:false, hoverinfo:'skip' });
    Plotly.newPlot('monthlyChart', monthlyTraces, {
      barmode:'stack', margin:{l:56,r:24,t:10,b:76}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
      xaxis:{ title:'Month', tickangle:small()?-40:0, gridcolor:'rgba(19,36,59,0.04)', automargin:true },
      yaxis:{ title:'Recruited patients', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)', automargin:true },
      legend:{ orientation:'h', y:-0.30, x:0, traceorder:'normal' }
    }, baseConfig());

    const exclusionMap = new Map();
    rows.filter(r => r.isExcluded).forEach(r => {
      const key = r.excludedReason || 'Not specified';
      exclusionMap.set(key, (exclusionMap.get(key) || 0) + 1);
    });
    const exclusionItems = [...exclusionMap.entries()].sort((a,b) => b[1] - a[1]).slice(0,8).reverse();
    Plotly.newPlot('exclusionChart', [{
      type:'bar', orientation:'h', x: exclusionItems.map(i => i[1]), y: exclusionItems.map(i => i[0]),
      text: exclusionItems.map(i => fmtInt.format(i[1])), textposition:'outside', cliponaxis:false,
      marker:{ color:'#1f63ff' },
      hovertemplate:'%{y}: %{x}<extra></extra>'
    }], {
      margin:{l:140,r:44,t:10,b:40}, paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
      xaxis:{ title:'Count', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)', automargin:true },
      yaxis:{ automargin:true },
      hoverlabel:{ bgcolor:'#000000', bordercolor:'#000000', font:{ color:'#ffffff', size:12 } }
    }, baseConfig());
  }

  function renderSummary(rows){
    const screened = rows.length;
    const enrolled = rows.filter(r => r.isEnrolled).length;
    const excluded = rows.filter(r => r.isExcluded).length;
    const diedEnrolled = rows.filter(r => r.isDiedEnrolled).length;
    const positive = rows.filter(r => r.isTruePositive).length;
    const positivePct = enrolled ? (positive / enrolled) * 100 : 0;
    const targetPct = 1620 ? (enrolled / 1620) * 100 : 0;

    els.targetPct.textContent = enrolled ? fmtPct(targetPct) : '-';
    els.positivePct.textContent = enrolled ? fmtPct(positivePct) : '-';

    const cards = [
      ['Screened patients', screened],
      ['Recruited patients', enrolled],
      ['Excluded patients', excluded],
      ['True positive cases', positive],
      ['Died among enrolled', diedEnrolled],
    ];
    els.kpiGrid.innerHTML = cards.map(([label, value]) => `
      <article class="kpi-card">
        <span class="eyebrow-sm">${label}</span>
        <strong>${fmtInt.format(value)}</strong>
      </article>
    `).join('');
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
    els.activeFilters.innerHTML = chips.length ? chips.map(t => `<span class="filter-chip">${t}</span>`).join('') : '<span class="filter-chip">Showing all records</span>';

    renderSummary(filtered);
    renderTable(els.totalCasesTable, groupedBySiteRows(filtered));
    renderTable(els.last14Table, groupedBySiteRows(lastNDaysRows(filtered, 14)));
    renderTable(els.last30Table, groupedBySiteRows(lastNDaysRows(filtered, 30)));
    renderRecent([...filtered].sort((a,b) => (a.screeningDate < b.screeningDate ? 1 : a.screeningDate > b.screeningDate ? -1 : a.patientId.localeCompare(b.patientId))));
    renderCharts(filtered);
  }

  [els.countryFilter, els.siteFilter, els.statusFilter, els.outcomeFilter, els.positiveFilter, els.dateFromFilter, els.dateToFilter].forEach(el => {
    el.addEventListener('change', () => { recordsPage = 1; renderAll(); });
  });
  els.resetFilters.addEventListener('click', () => {
    els.countryFilter.value = '';
    els.siteFilter.value = '';
    els.statusFilter.value = '';
    els.outcomeFilter.value = '';
    els.positiveFilter.value = '';
    els.dateFromFilter.value = minDate;
    els.dateToFilter.value = maxDate;
    recordsPage = 1;
    renderAll();
  });
  if (els.recordsPrev) els.recordsPrev.addEventListener('click', () => { recordsPage -= 1; renderRecent([...filteredRecordsForPagination]); });
  if (els.recordsNext) els.recordsNext.addEventListener('click', () => { recordsPage += 1; renderRecent([...filteredRecordsForPagination]); });

  renderAll();
})();
