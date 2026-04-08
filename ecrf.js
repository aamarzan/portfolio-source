const payload = window.ECRF_PAYLOAD || {};

const META = payload.META || {
  title: "Methanol Trial eCRF Query Operations Dashboard",
  totalQueries: 0,
  activeSites: 0,
  totalParticipants: 0,
  lastQuerySent: null,
  openQueries: 0,
  resolvedQueries: 0,
  notEnteredQueries: 0,
  siteCounts: {},
  siteNames: {}
};
const DATA = payload.DATA || [];
const SITE_ORDER = payload.SITE_ORDER || [];
const THEME_ORDER = payload.THEME_ORDER || [];
const STATUS_ORDER = payload.STATUS_ORDER || ["Open", "Not entered", "Resolved"];
const SEVERITY_ORDER = payload.SEVERITY_ORDER || ["Major", "Moderate", "Minor", "Standard"];

const state = {
  sites: new Set(SITE_ORDER),
  form: "All",
  severity: "All",
  status: "All",
  theme: "All",
  screen: "All",
  search: "",
  page: 1,
  pageSize: 10
};

const els = {};

function initEcrfDashboard(){
  if(!window.ECRF_PAYLOAD){
    console.warn("ECRF_PAYLOAD was not found. Check that ecrf-data.js loads before ecrf.js.");
  }
  cacheEls();
  hydrateHero();
  buildSiteChips();
  populateSelects();
  bindControls();
  updateDashboard();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initEcrfDashboard);
} else {
  initEcrfDashboard();
}

function cacheEls(){
  [
    "heroSubtitle","lastRefresh","overallQueries","overallParticipants","overallSites","overallOpen",
    "siteChips","formSelect","severitySelect","statusSelect","themeSelect","screenSelect","searchInput",
    "resetFilters","downloadCsv","activeFilters","overview","siteCardGrid","tableBody","tableMeta",
    "pagination","resultsCount","siteLoadChart","statusChart","formChart","severityChart",
    "timelineChart","themeChart","screenChart","heatmapChart"
  ].forEach(id => els[id] = document.getElementById(id));
}

function hydrateHero(){
  els.lastRefresh.textContent = formatDate(META.lastQuerySent);
  els.overallQueries.textContent = formatNumber(META.totalQueries);
  els.overallParticipants.textContent = formatNumber(META.totalParticipants);
  els.overallSites.textContent = formatNumber(META.activeSites);
  els.overallOpen.textContent = formatNumber(META.openQueries);
  els.heroSubtitle.textContent =
    `Updated from the latest uploaded query workbook. This view summarizes ${formatNumber(META.totalQueries)} query rows across ${formatNumber(META.activeSites)} sites and ${formatNumber(META.totalParticipants)} represented participants, while keeping participant-level identifiers hidden.`;
}

function buildSiteChips(){
  els.siteChips.innerHTML = "";
  SITE_ORDER.forEach(siteCode => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "site-chip active";
    btn.dataset.site = siteCode;
    btn.innerHTML = `<span>${siteCode}</span><small>${formatNumber(META.siteCounts[siteCode] || 0)} rows</small>`;
    btn.title = META.siteNames[siteCode] || siteCode;
    btn.addEventListener("click", () => {
      if(state.sites.has(siteCode)){
        state.sites.delete(siteCode);
      } else {
        state.sites.add(siteCode);
      }
      if(state.sites.size === 0){
        SITE_ORDER.forEach(code => state.sites.add(code));
      }
      syncSiteChips();
      state.page = 1;
      updateDashboard();
    });
    els.siteChips.appendChild(btn);
  });
  syncSiteChips();
}

function syncSiteChips(){
  [...els.siteChips.querySelectorAll(".site-chip")].forEach(btn => {
    btn.classList.toggle("active", state.sites.has(btn.dataset.site));
  });
}

function populateSelects(){
  fillSelect(els.formSelect, ["All", ...uniqueSorted(DATA.map(d => d.form), ["Recruitment", "Assessment", "Cross-form"])]);
  fillSelect(els.severitySelect, ["All", ...uniqueSorted(DATA.map(d => d.severity), SEVERITY_ORDER)]);
  fillSelect(els.statusSelect, ["All", ...uniqueSorted(DATA.map(d => d.status_group), STATUS_ORDER)]);
  fillSelect(els.themeSelect, ["All", ...uniqueSorted(DATA.map(d => d.theme), THEME_ORDER)]);
  fillSelect(els.screenSelect, ["All", ...uniqueSorted(DATA.map(d => d.screen), [])]);
}

function fillSelect(select, items){
  select.innerHTML = items.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("");
}

function bindControls(){
  els.formSelect.addEventListener("change", e => { state.form = e.target.value; state.page = 1; updateDashboard(); });
  els.severitySelect.addEventListener("change", e => { state.severity = e.target.value; state.page = 1; updateDashboard(); });
  els.statusSelect.addEventListener("change", e => { state.status = e.target.value; state.page = 1; updateDashboard(); });
  els.themeSelect.addEventListener("change", e => { state.theme = e.target.value; state.page = 1; updateDashboard(); });
  els.screenSelect.addEventListener("change", e => { state.screen = e.target.value; state.page = 1; updateDashboard(); });
  els.searchInput.addEventListener("input", e => { state.search = e.target.value.trim().toLowerCase(); state.page = 1; updateDashboard(); });

  els.resetFilters.addEventListener("click", () => {
    state.sites = new Set(SITE_ORDER);
    state.form = "All";
    state.severity = "All";
    state.status = "All";
    state.theme = "All";
    state.screen = "All";
    state.search = "";
    state.page = 1;
    els.formSelect.value = "All";
    els.severitySelect.value = "All";
    els.statusSelect.value = "All";
    els.themeSelect.value = "All";
    els.screenSelect.value = "All";
    els.searchInput.value = "";
    syncSiteChips();
    updateDashboard();
  });

  els.downloadCsv.addEventListener("click", () => {
    const catalogue = getIssueCatalogue(getFilteredRows());
    const csvRows = [
      ["Query message", "Count", "Severity", "Forms", "Themes", "Screens", "Sites", "Status mix", "Query batches"]
    ];
    catalogue.forEach(item => {
      csvRows.push([
        item.query,
        item.count,
        item.severity,
        item.forms.join(" / "),
        item.themes.join(" / "),
        item.screens.join(" / "),
        item.sites.join(", "),
        Object.entries(item.statusCounts).map(([k,v]) => `${k}: ${v}`).join("; "),
        item.querySentDates.map(formatDate).join(", ")
      ]);
    });
    downloadCsv("ecrf_filtered_issue_catalogue.csv", csvRows);
  });
}

function getFilteredRows(){
  return DATA.filter(row => {
    if(!state.sites.has(row.siteCode)) return false;
    if(state.form !== "All" && row.form !== state.form) return false;
    if(state.severity !== "All" && row.severity !== state.severity) return false;
    if(state.status !== "All" && row.status_group !== state.status) return false;
    if(state.theme !== "All" && row.theme !== state.theme) return false;
    if(state.screen !== "All" && row.screen !== state.screen) return false;
    if(state.search){
      const haystack = [row.query, row.siteCode, row.siteName, row.form, row.severity, row.theme, row.screen, row.status_group]
        .join(" ").toLowerCase();
      if(!haystack.includes(state.search)) return false;
    }
    return true;
  });
}

function updateDashboard(){
  const rows = getFilteredRows();
  renderActiveFilters(rows);
  renderKpis(rows);
  renderCharts(rows);
  renderSiteCards(rows);
  renderTable(rows);
}

function renderActiveFilters(rows){
  const pills = [];
  pills.push(`<span class="filter-pill neutral">${formatNumber(rows.length)} visible query rows</span>`);
  pills.push(`<span class="filter-pill neutral">${formatNumber(new Set(rows.map(r => r.siteCode)).size)} sites in view</span>`);
  const selectedSites = SITE_ORDER.filter(code => state.sites.has(code));
  if(selectedSites.length !== SITE_ORDER.length){
    pills.push(`<span class="filter-pill">Sites: ${escapeHtml(selectedSites.join(", "))}</span>`);
  }
  if(state.form !== "All") pills.push(`<span class="filter-pill">Form: ${escapeHtml(state.form)}</span>`);
  if(state.severity !== "All") pills.push(`<span class="filter-pill">Severity: ${escapeHtml(state.severity)}</span>`);
  if(state.status !== "All") pills.push(`<span class="filter-pill">Status: ${escapeHtml(state.status)}</span>`);
  if(state.theme !== "All") pills.push(`<span class="filter-pill">Theme: ${escapeHtml(state.theme)}</span>`);
  if(state.screen !== "All") pills.push(`<span class="filter-pill">Screen: ${escapeHtml(state.screen)}</span>`);
  if(state.search) pills.push(`<span class="filter-pill">Search: "${escapeHtml(state.search)}"</span>`);
  els.activeFilters.innerHTML = pills.join("");
}

function renderKpis(rows){
  const openCount = rows.filter(r => r.status_group === "Open").length;
  const elevatedSeverity = rows.filter(r => r.severity === "Major" || r.severity === "Moderate").length;
  const uniqueMessages = new Set(rows.map(r => normalizeKey(r.query))).size;
  const uniqueBatches = new Set(rows.map(r => r.querySentDate).filter(Boolean)).size;
  const heaviestSite = getTopCounts(rows, r => r.siteCode, SITE_ORDER)[0];
  const screens = new Set(rows.map(r => r.screen)).size;
  const kpis = [
    {
      label: "Visible query load",
      value: formatNumber(rows.length),
      note: "Total query instances returned by the current filter selection."
    },
    {
      label: "Unique issue messages",
      value: formatNumber(uniqueMessages),
      note: "Distinct query wordings after grouping repeated messages."
    },
    {
      label: "Open / unresolved",
      value: rows.length ? `${((openCount / rows.length) * 100).toFixed(1)}%` : "0.0%",
      note: `${formatNumber(openCount)} rows are still open within the current view.`
    },
    {
      label: "Major + moderate",
      value: formatNumber(elevatedSeverity),
      note: "Rows marked as higher operational severity in the workbook."
    },
    {
      label: "Heaviest site",
      value: heaviestSite ? heaviestSite.label : "—",
      note: heaviestSite ? `${formatNumber(heaviestSite.value)} visible query rows under current filters.` : "No site data under the current filters."
    },
    {
      label: "Screens / modules",
      value: formatNumber(screens),
      note: `${formatNumber(uniqueBatches)} distinct query batches in the current selection.`
    }
  ];
  els.overview.innerHTML = kpis.map(item => `
    <article class="kpi-card">
      <div class="label">${item.label}</div>
      <div class="value">${item.value}</div>
      <p>${item.note}</p>
    </article>
  `).join("");
}

function renderCharts(rows){
  renderSiteLoadChart(rows);
  renderStatusChart(rows);
  renderFormChart(rows);
  renderSeverityChart(rows);
  renderTimelineChart(rows);
  renderThemeChart(rows);
  renderScreenChart(rows);
  renderHeatmapChart(rows);
}

function renderSiteLoadChart(rows){
  const sites = SITE_ORDER.filter(code => rows.some(r => r.siteCode === code));
  if(!sites.length) return renderEmpty("siteLoadChart", "No site rows match the current filters.");
  const open = sites.map(site => rows.filter(r => r.siteCode === site && r.status_group === "Open").length);
  const notEntered = sites.map(site => rows.filter(r => r.siteCode === site && r.status_group === "Not entered").length);
  const resolved = sites.map(site => rows.filter(r => r.siteCode === site && r.status_group === "Resolved").length);
  const data = [
    {
      type:"bar",
      x:open,
      y:sites,
      orientation:"h",
      name:"Open",
      marker:{color:"#f59e0b"},
      hovertemplate:"%{y}<br>Open: %{x}<extra></extra>"
    },
    {
      type:"bar",
      x:notEntered,
      y:sites,
      orientation:"h",
      name:"Not entered",
      marker:{color:"#64748b"},
      hovertemplate:"%{y}<br>Not entered: %{x}<extra></extra>"
    },
    {
      type:"bar",
      x:resolved,
      y:sites,
      orientation:"h",
      name:"Resolved",
      marker:{color:"#16a34a"},
      hovertemplate:"%{y}<br>Resolved: %{x}<extra></extra>"
    }
  ];
  Plotly.react("siteLoadChart", data, baseLayout({
    barmode:"stack",
    margin:{l:72,r:18,t:8,b:32},
    xaxis:{title:"Query rows", gridcolor:"#e9f0f6"},
    yaxis:{automargin:true}
  }), plotConfig());
}

function renderStatusChart(rows){
  const counts = getTopCounts(rows, r => r.status_group, STATUS_ORDER);
  if(!counts.length) return renderEmpty("statusChart", "No status data available.");
  Plotly.react("statusChart", [{
    type:"pie",
    labels:counts.map(d => d.label),
    values:counts.map(d => d.value),
    hole:.58,
    marker:{colors:["#f59e0b","#64748b","#16a34a"]},
    textinfo:"label+percent",
    sort:false
  }], baseLayout({margin:{l:12,r:12,t:10,b:10}, showlegend:false}), plotConfig());
}

function renderFormChart(rows){
  const counts = getTopCounts(rows, r => r.form, ["Recruitment","Assessment","Cross-form"]);
  if(!counts.length) return renderEmpty("formChart", "No form data available.");
  Plotly.react("formChart", [{
    type:"pie",
    labels:counts.map(d => d.label),
    values:counts.map(d => d.value),
    hole:.55,
    marker:{colors:["#1d4ed8","#0ea5e9","#64748b"]},
    textinfo:"label+percent",
    sort:false
  }], baseLayout({margin:{l:12,r:12,t:10,b:10}, showlegend:false}), plotConfig());
}

function renderSeverityChart(rows){
  const counts = getTopCounts(rows, r => r.severity, SEVERITY_ORDER);
  if(!counts.length) return renderEmpty("severityChart", "No severity data available.");

  const colorMap = {
    Major: "#dc2626",
    Moderate: "#f59e0b",
    Minor: "#0ea5e9",
    Standard: "#1d4ed8"
  };

  Plotly.react("severityChart", [{
    type:"pie",
    labels:counts.map(d => d.label),
    values:counts.map(d => d.value),
    hole:.55,
    marker:{colors:counts.map(d => colorMap[d.label] || "#64748b")},
    textinfo:"label+percent",
    sort:false
  }], baseLayout({margin:{l:12,r:12,t:10,b:10}, showlegend:false}), plotConfig());
}

function renderTimelineChart(rows){
  const datedRows = rows.filter(r => r.querySentDate);
  if(!datedRows.length) return renderEmpty("timelineChart", "No dated query batches under the current filters.");
  const counts = getTopCounts(datedRows, r => r.querySentDate).sort((a,b) => a.label.localeCompare(b.label));
  Plotly.react("timelineChart", [{
    type:"scatter",
    mode:"lines+markers",
    x:counts.map(d => d.label),
    y:counts.map(d => d.value),
    line:{color:"#1d4ed8", width:3},
    marker:{size:8, color:"#0ea5e9"},
    fill:"tozeroy",
    fillcolor:"rgba(14,165,233,.10)",
    hovertemplate:"%{x}<br>Rows: %{y}<extra></extra>"
  }], baseLayout({
    margin:{l:44,r:18,t:8,b:42},
    xaxis:{title:"Query batch date", tickangle:-20},
    yaxis:{title:"Rows", gridcolor:"#e9f0f6"}
  }), plotConfig());
}

function renderThemeChart(rows){
  const counts = getTopCounts(rows, r => r.theme, THEME_ORDER).slice(0, 8);
  if(!counts.length) return renderEmpty("themeChart", "No theme data available.");
  Plotly.react("themeChart", [{
    type:"bar",
    x:counts.map(d => d.value).reverse(),
    y:counts.map(d => d.label).reverse(),
    orientation:"h",
    marker:{color:"#1d4ed8"},
    hovertemplate:"%{y}<br>Rows: %{x}<extra></extra>"
  }], baseLayout({
    margin:{l:178,r:18,t:8,b:28},
    xaxis:{title:"Rows", gridcolor:"#e9f0f6"},
    yaxis:{automargin:true}
  }), plotConfig());
}

function renderScreenChart(rows){
  const counts = getTopCounts(rows, r => r.screen).slice(0, 8);
  if(!counts.length) return renderEmpty("screenChart", "No screen data available.");
  Plotly.react("screenChart", [{
    type:"bar",
    x:counts.map(d => d.label),
    y:counts.map(d => d.value),
    marker:{color:"#0ea5e9"},
    hovertemplate:"%{x}<br>Rows: %{y}<extra></extra>"
  }], baseLayout({
    margin:{l:46,r:18,t:8,b:104},
    xaxis:{tickangle:-30},
    yaxis:{title:"Rows", gridcolor:"#e9f0f6"}
  }), plotConfig());
}

function renderHeatmapChart(rows){
  const sites = SITE_ORDER.filter(code => rows.some(r => r.siteCode === code));
  const themes = getTopCounts(rows, r => r.theme, THEME_ORDER).slice(0, 8).map(d => d.label);
  if(!sites.length || !themes.length) return renderEmpty("heatmapChart", "No site-theme intersections under the current filters.");
  const z = themes.map(theme => sites.map(site => rows.filter(r => r.siteCode === site && r.theme === theme).length));
  Plotly.react("heatmapChart", [{
    type:"heatmap",
    x:sites,
    y:themes,
    z:z,
    colorscale:[
      [0, "#eff6ff"],
      [.25, "#bfdbfe"],
      [.55, "#60a5fa"],
      [1, "#1d4ed8"]
    ],
    hovertemplate:"Site: %{x}<br>Theme: %{y}<br>Rows: %{z}<extra></extra>",
    showscale:true,
    colorbar:{title:"Rows"}
  }], baseLayout({
    margin:{l:200,r:20,t:8,b:40},
    xaxis:{tickangle:0},
    yaxis:{automargin:true}
  }), plotConfig());
}

function renderSiteCards(rows){
  const codes = SITE_ORDER.filter(code => rows.some(r => r.siteCode === code));
  if(!codes.length){
    els.siteCardGrid.innerHTML = `<div class="empty-state">No site cards are available for the current filter selection.</div>`;
    return;
  }
  els.siteCardGrid.innerHTML = codes.map(code => {
    const siteRows = rows.filter(r => r.siteCode === code);
    const topTheme = getTopCounts(siteRows, r => r.theme, THEME_ORDER)[0];
    const open = siteRows.filter(r => r.status_group === "Open").length;
    const notEntered = siteRows.filter(r => r.status_group === "Not entered").length;
    const elevatedSeverity = siteRows.filter(r => r.severity === "Major" || r.severity === "Moderate").length;
    const dated = siteRows.map(r => r.querySentDate).filter(Boolean).sort();
    const lastBatch = dated.length ? dated[dated.length - 1] : null;
    return `
      <article class="site-card">
        <div class="site-card-head">
          <div>
            <h4>${code}</h4>
            <div class="site-name">${escapeHtml(META.siteNames[code] || code)}</div>
          </div>
          <div class="site-badge">${formatNumber(siteRows.length)} rows</div>
        </div>
        <div class="site-metrics">
          <div class="site-metric">
            <div class="mini-label">Latest batch</div>
            <div class="mini-value" style="font-size:18px;line-height:1.2">${escapeHtml(formatDate(lastBatch))}</div>
            <div class="mini-sub">Most recent query-sent date visible for this site.</div>
          </div>
          <div class="site-metric">
            <div class="mini-label">Open rows</div>
            <div class="mini-value">${formatNumber(open)}</div>
            <div class="mini-sub">${notEntered ? `${formatNumber(notEntered)} rows are not entered.` : "No not-entered status rows in this filtered view."}</div>
          </div>
          <div class="site-metric">
            <div class="mini-label">Major + moderate</div>
            <div class="mini-value">${formatNumber(elevatedSeverity)}</div>
            <div class="mini-sub">Higher-severity workbook rows under the current filters.</div>
          </div>
          <div class="site-metric">
            <div class="mini-label">Dominant theme</div>
            <div class="mini-value" style="font-size:16px;line-height:1.25">${escapeHtml(topTheme ? topTheme.label : "—")}</div>
            <div class="mini-sub">${topTheme ? `${formatNumber(topTheme.value)} row(s)` : "No theme data"}.</div>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderTable(rows){
  const catalogue = getIssueCatalogue(rows);
  els.resultsCount.textContent = formatNumber(catalogue.length);
  const totalPages = Math.max(1, Math.ceil(catalogue.length / state.pageSize));
  if(state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = catalogue.slice(start, start + state.pageSize);

  if(!pageRows.length){
    els.tableBody.innerHTML = `<tr><td colspan="8"><div class="empty-state" style="min-height:180px">No grouped issue rows match the current filters.</div></td></tr>`;
    els.tableMeta.textContent = "Nothing to show under the current filters.";
    els.pagination.innerHTML = "";
    return;
  }

  els.tableBody.innerHTML = pageRows.map(row => {
    const statusBadges = Object.entries(row.statusCounts).map(([status, count]) =>
      `<span class="badge-inline ${status === "Open" ? "badge-pending" : status === "Resolved" ? "badge-resolved" : "badge-standard"}">${status} · ${count}</span>`
    ).join("");

    return `
      <tr>
        <td>
          <div>${escapeHtml(row.query)}</div>
          <div class="mono">${row.querySentDates.length ? `Batches: ${row.querySentDates.map(formatDate).join(", ")}` : "No dated batch in workbook"}</div>
        </td>
        <td><span class="badge-inline ${severityBadgeClass(row.severity)}">${row.severity}</span></td>
        <td>${escapeHtml(row.forms.join(" / "))}</td>
        <td>${escapeHtml(row.themes.join(" / "))}</td>
        <td>${escapeHtml(row.screens.join(" / "))}</td>
        <td>${escapeHtml(row.sites.join(", "))}</td>
        <td>${statusBadges}</td>
        <td><strong>${formatNumber(row.count)}</strong></td>
      </tr>
    `;
  }).join("");

  const startItem = catalogue.length ? start + 1 : 0;
  const endItem = Math.min(start + state.pageSize, catalogue.length);
  els.tableMeta.textContent = `Showing ${startItem}-${endItem} of ${catalogue.length} grouped issue row(s).`;
  renderPagination(totalPages);
}

function renderPagination(totalPages){
  if(totalPages <= 1){
    els.pagination.innerHTML = "";
    return;
  }
  const buttons = [];
  for(let page = 1; page <= totalPages; page += 1){
    buttons.push(`<button class="page-btn ${page === state.page ? "active" : ""}" data-page="${page}" type="button">${page}</button>`);
  }
  els.pagination.innerHTML = buttons.join("");
  [...els.pagination.querySelectorAll(".page-btn")].forEach(btn => {
    btn.addEventListener("click", () => {
      state.page = Number(btn.dataset.page);
      renderTable(getFilteredRows());
      window.scrollTo({ top: document.getElementById("catalogue").offsetTop - 18, behavior: "smooth" });
    });
  });
}

function getIssueCatalogue(rows){
  const map = new Map();
  rows.forEach(row => {
    const key = normalizeKey(row.query);
    if(!map.has(key)){
      map.set(key, {
        query: row.query,
        count: 0,
        severity: row.severity,
        forms: new Set(),
        themes: new Set(),
        screens: new Set(),
        sites: new Set(),
        statusCounts: {},
        querySentDates: new Set()
      });
    }
    const item = map.get(key);
    item.count += 1;
    item.severity = maxSeverity(item.severity, row.severity);
    item.forms.add(row.form);
    item.themes.add(row.theme);
    item.screens.add(row.screen);
    item.sites.add(row.siteCode);
    item.statusCounts[row.status_group] = (item.statusCounts[row.status_group] || 0) + 1;
    if(row.querySentDate) item.querySentDates.add(row.querySentDate);
  });
  return [...map.values()].map(item => ({
    ...item,
    forms:[...item.forms].sort(),
    themes:[...item.themes].sort(sortWithOrder(THEME_ORDER)),
    screens:[...item.screens].sort(),
    sites:[...item.sites].sort(sortWithOrder(SITE_ORDER)),
    querySentDates:[...item.querySentDates].sort()
  })).sort((a,b) => {
    const sev = severityWeight(b.severity) - severityWeight(a.severity);
    if(sev !== 0) return sev;
    return b.count - a.count || a.query.localeCompare(b.query);
  });
}

function renderEmpty(elId, message){
  document.getElementById(elId).innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function getTopCounts(rows, accessor, order=[]){
  const counts = new Map();
  rows.forEach(row => {
    const key = accessor(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const arr = [...counts.entries()].map(([label, value]) => ({label, value}));
  arr.sort((a,b) => {
    const ai = order.indexOf(a.label);
    const bi = order.indexOf(b.label);
    if(ai !== -1 || bi !== -1){
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || b.value - a.value;
    }
    return b.value - a.value || String(a.label).localeCompare(String(b.label));
  });
  return arr;
}

function uniqueSorted(values, order=[]){
  const items = [...new Set(values.filter(Boolean))];
  items.sort(sortWithOrder(order));
  return items;
}

function sortWithOrder(order=[]){
  return (a,b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if(ai !== -1 || bi !== -1){
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || String(a).localeCompare(String(b));
    }
    return String(a).localeCompare(String(b));
  };
}

function maxSeverity(a, b){
  return severityWeight(b) > severityWeight(a) ? b : a;
}

function severityWeight(sev){
  return sev === "Major" ? 3 : sev === "Minor" ? 2 : 1;
}

function severityBadgeClass(sev){
  return sev === "Major" ? "badge-major" : sev === "Moderate" ? "badge-moderate" : sev === "Minor" ? "badge-minor" : "badge-standard";
}

function normalizeKey(text){
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

function baseLayout(extra={}){
  return {
    paper_bgcolor:"rgba(0,0,0,0)",
    plot_bgcolor:"rgba(0,0,0,0)",
    font:{family:"Inter, Segoe UI, sans-serif", color:"#112034"},
    margin:{l:40,r:20,t:10,b:40},
    ...extra
  };
}

function plotConfig(){
  return {
    responsive:true,
    displayModeBar:false
  };
}

function formatDate(value){
  if(!value) return "Undated";
  const dt = new Date(value);
  if(Number.isNaN(dt.getTime())) return String(value);
  return dt.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"});
}

function formatNumber(value){
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function downloadCsv(filename, rows){
  const csv = rows.map(cols => cols.map(value => {
    const str = String(value ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
