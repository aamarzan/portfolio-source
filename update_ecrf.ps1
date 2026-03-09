$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$WorkbookPath = Join-Path $RepoRoot "private\query_dataset.xlsx"
$PythonScript = Join-Path $RepoRoot "scripts\update_ecrf_from_excel.py"

if (-not (Test-Path $WorkbookPath)) {
    throw "Workbook not found at $WorkbookPath. Put the latest file there first."
}

if (-not (Test-Path $PythonScript)) {
    throw "Python update script not found at $PythonScript."
}

$VersionToken = Get-Date -Format "yyyyMMdd-HHmmss"

if (Get-Command py -ErrorAction SilentlyContinue) {
    py -3 $PythonScript --version $VersionToken
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    python $PythonScript --version $VersionToken
} else {
    throw "Python was not found. Install Python or make sure py/python is on PATH."
}

git add ecrf-data.js ecrf-data.json ecrf\index.html

$CommitMessage = "Refresh eCRF dashboard data ($VersionToken)"
git commit -m $CommitMessage

git push origin main

Write-Host ""
Write-Host "Done. Netlify should redeploy automatically." -ForegroundColor Green
