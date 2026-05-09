$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$WorkbookPath = Join-Path $RepoRoot "private\master_data.xlsx"
$DashboardScript = Join-Path $RepoRoot "scripts\update_right4_dashboard_from_excel.py"
$PocScript = Join-Path $RepoRoot "scripts\update_right4_poc_performance_from_excel.py"

if (-not (Test-Path $WorkbookPath)) {
    throw "Workbook not found at $WorkbookPath. Put the latest master_data.xlsx there first."
}
if (-not (Test-Path $DashboardScript)) {
    throw "Dashboard generation script not found at $DashboardScript."
}
if (-not (Test-Path $PocScript)) {
    throw "POC performance generation script not found at $PocScript."
}

$VersionToken = Get-Date -Format "yyyyMMdd-HHmmss"

function Invoke-PythonScript {
    param([string]$ScriptPath, [string]$Label)
    Write-Host ""
    Write-Host "Generating $Label..." -ForegroundColor Cyan
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 $ScriptPath --version $VersionToken
    }
    elseif (Get-Command python -ErrorAction SilentlyContinue) {
        & python $ScriptPath --version $VersionToken
    }
    else {
        throw "Python was not found. Install Python or make sure py/python is on PATH."
    }
    if ($LASTEXITCODE -ne 0) {
        throw "$Label generation failed. Fix the Python error above first."
    }
}

Invoke-PythonScript -ScriptPath $DashboardScript -Label "RIGHT4 dashboard"
Invoke-PythonScript -ScriptPath $PocScript -Label "POC performance page"

git add `
    right4-dashboard\index.html `
    right4-poc-performance\index.html `
    right4-dashboard.css `
    right4-dashboard.js `
    right4-dashboard-data.js `
    right4-dashboard-data.json `
    right4-poc-performance.css `
    right4-poc-performance.js `
    right4-poc-performance-data.js `
    right4-poc-performance-data.json `
    right4-access.js `
    scripts\update_right4_dashboard_from_excel.py `
    scripts\update_right4_poc_performance_from_excel.py `
    .gitignore

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "No generated changes detected. The workbook may be unchanged, or the generated output is identical." -ForegroundColor Yellow
    exit 0
}

$CommitMessage = "Refresh RIGHT4 dashboard and POC performance data ($VersionToken)"
git commit -m $CommitMessage
git push origin main

Write-Host ""
Write-Host "Done. Netlify should redeploy automatically." -ForegroundColor Green
