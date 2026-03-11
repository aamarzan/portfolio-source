
(function(){
  const DATA = window.RIGHT4_DASHBOARD_DATA;
  const isSmallScreen = window.matchMedia('(max-width: 820px)').matches;
  const config = {
    displayModeBar: false,
    responsive: true,
    staticPlot: isSmallScreen,
    scrollZoom: false
  };

  if(!DATA){
    document.body.insertAdjacentHTML('afterbegin','<div style="padding:16px;background:#fff1f1;color:#991b1b;font-weight:700">Dashboard data could not be loaded.</div>');
    return;
  }

  const fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const fmtPct = (n) => `${Number(n || 0).toFixed(1)}%`;
  const toShortDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  };

  document.getElementById('pageTitle').textContent = DATA.meta.pageTitle;
  document.getElementById('pageSubtitle').textContent = DATA.meta.pageSubtitle;
  document.getElementById('lastUpdate').textContent = DATA.summary.lastUpdate;
  document.getElementById('targetPct').textContent = fmtPct(DATA.summary.truePositiveVsTargetPct);
  document.getElementById('positivePct').textContent = fmtPct(DATA.summary.overallPositivePct);

  const kpis = [
    ['Total screened', DATA.summary.totalScreened, 'All screened records currently available in the master workbook.'],
    ['Total recruited', DATA.summary.totalRecruited, 'Patients marked as enrolled at the time of the latest refresh.'],
    ['Total excluded', DATA.summary.totalExcluded, 'Patients excluded after screening, grouped directly from workbook status.'],
    ['Died (enrolled)', DATA.summary.totalDiedEnrolled, 'Outcome marked as died among enrolled patients only.'],
    ['True positive cases', DATA.summary.totalTruePositive, 'Cases explicitly marked “Yes” in the True Positive column.']
  ];
  const kpiGrid = document.getElementById('kpiGrid');
  kpis.forEach(([label, value, sub]) => {
    const card = document.createElement('article');
    card.className = 'kpi-card';
    card.innerHTML = `<span class="eyebrow-sm">${label}</span><div class="value">${fmtInt.format(value)}</div><div class="sub">${sub}</div>`;
    kpiGrid.appendChild(card);
  });

  function renderTable(mountId, rows){
    const mount = document.getElementById(mountId);
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

  renderTable('totalCasesTable', DATA.siteTables.totalCases);
  renderTable('last14Table', DATA.siteTables.last14Days);
  renderTable('last30Table', DATA.siteTables.last30Days);

  const country = DATA.summary.countryEnrollment;
  Plotly.newPlot('countryChart', [{
    type:'pie',
    labels:Object.keys(country),
    values:Object.values(country),
    hole:0.58,
    textinfo:'label+value',
    sort:false,
    marker:{ colors:['#1f63ff','#18b5ff'] }
  }], {
    margin:{l:10,r:10,t:0,b:0},
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor:'rgba(0,0,0,0)',
    showlegend:false
  }, config);

  const classification = DATA.summary.classification;
  Plotly.newPlot('classificationChart', [{
    type:'pie',
    labels:Object.keys(classification),
    values:Object.values(classification),
    hole:0.58,
    textinfo:'label+value',
    sort:false,
    marker:{ colors:['#14a44d','#7a8da8'] }
  }], {
    margin:{l:10,r:10,t:0,b:0},
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor:'rgba(0,0,0,0)',
    showlegend:false
  }, config);

  const siteSeriesOrder = ['CMCH','SOMCH','SZMCH','RMCH','DMCH','PGIMER','SGRDUHS','GGSMCH'];
  const recruitmentTraces = siteSeriesOrder.map((code, idx) => ({
    type:'scatter',
    mode:'lines',
    x: DATA.charts.dailyCumulative.dates,
    y: DATA.charts.dailyCumulative.series[code],
    name: code,
    line:{ width:2 }
  }));
  recruitmentTraces.push({
    type:'scatter',
    mode:'lines',
    x: DATA.charts.dailyCumulative.dates,
    y: DATA.charts.dailyCumulative.series.TOTAL,
    name:'Total',
    line:{ width:3.5, dash:'solid', color:'#0f355c' }
  });
  Plotly.newPlot('recruitmentGraph', recruitmentTraces, {
    margin:{l:48,r:18,t:10,b:54},
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor:'rgba(0,0,0,0)',
    xaxis:{ title:'Date', tickfont:{ size:isSmallScreen?10:12 }, gridcolor:'rgba(19,36,59,0.08)' },
    yaxis:{ title:'Cumulative recruited', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)' },
    legend:{ orientation:isSmallScreen?'h':'v', y:isSmallScreen?-0.28:1, x:0 }
  }, config);

  Plotly.newPlot('targetActualChart', [
    {
      type:'scatter',
      mode:'lines+markers',
      x: DATA.charts.targetVsActual.dates,
      y: DATA.charts.targetVsActual.targetPatients,
      name:'Target patients',
      line:{ width:2.6, color:'#1f63ff' }
    },
    {
      type:'scatter',
      mode:'lines',
      x: DATA.charts.targetVsActual.dates,
      y: DATA.charts.targetVsActual.calculatedTarget,
      name:'Calculated target',
      line:{ width:2.2, dash:'dot', color:'#7c8cb1' }
    },
    {
      type:'scatter',
      mode:'lines+markers',
      x: DATA.charts.targetVsActual.dates,
      y: DATA.charts.targetVsActual.actualPatients,
      name:'Actual patients',
      line:{ width:3, color:'#14a44d' }
    }
  ], {
    margin:{l:48,r:18,t:10,b:54},
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor:'rgba(0,0,0,0)',
    xaxis:{ title:'Date', tickfont:{ size:isSmallScreen?10:12 }, gridcolor:'rgba(19,36,59,0.08)' },
    yaxis:{ title:'Patients', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)' },
    legend:{ orientation:'h', y:-0.24, x:0 }
  }, config);

  Plotly.newPlot('positiveTargetChart', [
    {
      type:'scatter',
      mode:'lines+markers',
      x: DATA.charts.positiveVsTarget.dates,
      y: DATA.charts.positiveVsTarget.targetPositive,
      name:'Target positive',
      line:{ width:2.6, color:'#8b5cf6' }
    },
    {
      type:'scatter',
      mode:'lines+markers',
      x: DATA.charts.positiveVsTarget.dates,
      y: DATA.charts.positiveVsTarget.actualPositive,
      name:'True positive',
      line:{ width:3, color:'#f59e0b' }
    }
  ], {
    margin:{l:48,r:18,t:10,b:54},
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor:'rgba(0,0,0,0)',
    xaxis:{ title:'Date', tickfont:{ size:isSmallScreen?10:12 }, gridcolor:'rgba(19,36,59,0.08)' },
    yaxis:{ title:'Patients', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)' },
    legend:{ orientation:'h', y:-0.24, x:0 }
  }, config);

  const monthlyTraces = siteSeriesOrder.map(code => ({
    type:'bar',
    x: DATA.charts.monthlyRecruitment.labels,
    y: DATA.charts.monthlyRecruitment.series[code],
    name: code
  }));
  Plotly.newPlot('monthlyChart', monthlyTraces, {
    barmode:'stack',
    margin:{l:48,r:18,t:10,b:70},
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor:'rgba(0,0,0,0)',
    xaxis:{ title:'Month', tickangle:isSmallScreen?-45:0, gridcolor:'rgba(19,36,59,0.04)' },
    yaxis:{ title:'Recruited patients', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)' },
    legend:{ orientation:'h', y:-0.28, x:0 }
  }, config);

  const exclusion = DATA.charts.exclusionReasons || [];
  Plotly.newPlot('exclusionChart', [{
    type:'bar',
    orientation:'h',
    x: exclusion.map(item => item.count).reverse(),
    y: exclusion.map(item => item.reason).reverse(),
    marker:{ color:'#f59e0b' }
  }], {
    margin:{l:120,r:18,t:10,b:40},
    paper_bgcolor:'rgba(0,0,0,0)',
    plot_bgcolor:'rgba(0,0,0,0)',
    xaxis:{ title:'Excluded cases', rangemode:'tozero', gridcolor:'rgba(19,36,59,0.08)' },
    yaxis:{ automargin:true }
  }, config);

  function renderRecent(){
    const rows = DATA.recentRecords || [];
    const mount = document.getElementById('recentRecordsTable');
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
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
        ${rows.map(row => `
          <tr>
            <td>${row.patientId}</td>
            <td>${row.siteCode}</td>
            <td>${toShortDate(row.screeningDate)}</td>
            <td>${row.patientStatus}</td>
            <td>${row.outcome || '-'}</td>
            <td>${row.truePositive}</td>
            <td>${row.baseDeficit || '-'}</td>
            <td>${row.comment || '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    wrap.appendChild(table);
    mount.innerHTML = '';
    mount.appendChild(wrap);
  }
  renderRecent();

  window.addEventListener('resize', () => {
    ['countryChart','classificationChart','recruitmentGraph','targetActualChart','positiveTargetChart','monthlyChart','exclusionChart']
      .forEach(id => Plotly.Plots.resize(document.getElementById(id)));
  });
})();
