$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$WorkbookPath = Join-Path $RepoRoot "private\master_data.xlsx"
$PythonScript = Join-Path $RepoRoot "scripts\update_right4_dashboard_from_excel.py"

if (-not (Test-Path $WorkbookPath)) {
    throw "Workbook not found at $WorkbookPath. Put the latest master_data.xlsx there first."
}

if (-not (Test-Path $PythonScript)) {
    throw "Python update script not found at $PythonScript."
}

$VersionToken = Get-Date -Format "yyyyMMdd-HHmmss"

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $PythonScript --version $VersionToken
    if ($LASTEXITCODE -ne 0) {
        throw "Dashboard generation failed. Fix the Python error above first."
    }
}
elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python $PythonScript --version $VersionToken
    if ($LASTEXITCODE -ne 0) {
        throw "Dashboard generation failed. Fix the Python error above first."
    }
}
else {
    throw "Python was not found. Install Python or make sure py/python is on PATH."
}

git add right4-dashboard\index.html right4-dashboard.css right4-dashboard.js right4-dashboard-data.js right4-dashboard-data.json scripts\update_right4_dashboard_from_excel.py .gitignore

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "No generated changes detected. The workbook may be unchanged, or the generated output is identical." -ForegroundColor Yellow
    exit 0
}

$CommitMessage = "Refresh RIGHT4 dashboard data ($VersionToken)"
git commit -m $CommitMessage
git push origin main

Write-Host ""
Write-Host "Done. Netlify should redeploy automatically." -ForegroundColor Green
