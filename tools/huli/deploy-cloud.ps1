# Builds Huli Cloud and the hosted web client from this checkout's HEAD and installs both on
# oracle-relay through cloud/deploy/install.sh. Windows PowerShell 5.1 or later.
#
#   powershell -File tools\huli\deploy-cloud.ps1              build, upload, install
#   powershell -File tools\huli\deploy-cloud.ps1 -BuildOnly   build into out\cloud-deploy only
#
# It builds in a copy of HEAD (git archive) with the checkout's node_modules, so the rebrand never
# touches the working tree; uncommitted changes are not deployed. Needs `ssh oracle-relay` to work
# (Tailscale) with passwordless sudo there.

param(
  [switch]$BuildOnly,
  [string]$Server = 'oracle-relay'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$git = 'git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $git = 'C:\Program Files\Git\cmd\git.exe' }

function Invoke-Checked([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" }
}

$commit = (& $git -C $root rev-parse --short HEAD).Trim()
if ((& $git -C $root status --porcelain).Length -gt 0) {
  Write-Warning "The working tree has uncommitted changes; deploying $commit as committed."
}
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  throw 'Run `npx -y pnpm@10.11.1 install` in the checkout first.'
}

$out = Join-Path $root 'out\cloud-deploy'
$work = Join-Path ([IO.Path]::GetTempPath()) "huli-deploy-$commit-$(Get-Random)"
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out | Remove-Item -Recurse -Force
New-Item -ItemType Directory $work | Out-Null
try {
  Write-Host "Building $commit in $work"
  Invoke-Checked 'git archive' { & $git -C $root archive -o (Join-Path $work 'src.tar') HEAD }
  Invoke-Checked 'tar' { tar -xf (Join-Path $work 'src.tar') -C $work }
  Remove-Item (Join-Path $work 'src.tar')
  New-Item -ItemType Junction -Path (Join-Path $work 'node_modules') -Target (Join-Path $root 'node_modules') | Out-Null
  Push-Location $work
  try {
    $env:VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true'
    # The hosted web client is public, so the update channel's path stays out of it.
    Invoke-Checked 'rebrand' { node tools/huli/rebrand.mjs --no-update-path }
    Invoke-Checked 'cloud build' { npx.cmd vite build -c vite.cloud.config.mts }
    # The web build copies the artifact viewers in, so they are built first (as build:web:hosted).
    Invoke-Checked 'viewers build' { npx.cmd vite build -c vite.viewers.config.mts }
    Invoke-Checked 'web build' { npx.cmd vite build -c vite.web.config.mts --mode hosted }
  } finally {
    Pop-Location
  }
  Copy-Item (Join-Path $work 'cloud\dist\huli-cloud.mjs') $out
  Copy-Item (Join-Path $work 'cloud\deploy\regions.signed.json') $out
  Copy-Item (Join-Path $work 'cloud\deploy\install.sh') $out
  Invoke-Checked 'web tarball' { tar -czf (Join-Path $out 'huli-web.tar.gz') -C (Join-Path $work 'out\web-hosted') . }
  $hash = (Get-FileHash (Join-Path $out 'huli-web.tar.gz') -Algorithm SHA256).Hash.ToLower()
  [IO.File]::WriteAllText((Join-Path $out 'huli-web.tar.gz.sha256'), "$hash  huli-web.tar.gz`n")
} finally {
  # The junction first, so removing the copy never reaches into the checkout's node_modules.
  $junction = Join-Path $work 'node_modules'
  if (Test-Path $junction) { cmd /c rmdir "$junction" | Out-Null }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

Get-ChildItem $out | ForEach-Object {
  '{0,-28} {1,10:N0} bytes  sha256 {2}' -f $_.Name, $_.Length, (Get-FileHash $_.FullName).Hash.Substring(0, 12).ToLower()
}
if ($BuildOnly) {
  Write-Host "Built into $out; not deployed."
  return
}

$remote = "/tmp/huli-deploy-$commit"
Write-Host "Uploading to ${Server}:$remote"
Invoke-Checked 'ssh mkdir' { ssh $Server "rm -rf $remote && mkdir -m 700 $remote" }
Invoke-Checked 'scp' { scp -q (Get-ChildItem $out).FullName "${Server}:$remote/" }
Write-Host 'Installing (sudo bash install.sh)'
Invoke-Checked 'install.sh' { ssh $Server "sudo bash $remote/install.sh $remote; status=`$?; sudo rm -rf $remote; exit `$status" }
Write-Host "Deployed $commit. Record it in the ops log (cloud/deploy/README.md says what)."
