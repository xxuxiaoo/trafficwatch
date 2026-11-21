param([switch]$Demo, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  $bundledNode=Join-Path $projectRoot 'runtime\node.exe'
  $nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } elseif ($nodeCommand) { $nodeCommand.Source } else { $bundledNode }
  if (!(Test-Path -LiteralPath $nodePath)) { throw 'Node.js 24+ is required. Install Node.js, then run start.cmd again.' }
  $nodeVersion = & $nodePath --version
  if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24+ is required.' }
  $port = 43128
  $localConfig = Join-Path $projectRoot 'config.local.json'
  if (Test-Path -LiteralPath $localConfig) {
    $settings = Get-Content -Raw -LiteralPath $localConfig | ConvertFrom-Json
    if ($settings.port) { $port = [int]$settings.port }
  }
  if ($Demo) { $port = 43129 }
  if ($env:CODEX_FLOW_PORT) { $port = [int]$env:CODEX_FLOW_PORT }
  $overviewPort = if($env:TRAFFICWATCH_OVERVIEW_PORT){[int]$env:TRAFFICWATCH_OVERVIEW_PORT}elseif($port -eq 43129 -and $Demo){43139}elseif($port -eq 65535){$port-1}else{$port+1}
  if($overviewPort -eq $port -or $overviewPort -lt 1024 -or $overviewPort -gt 65535){throw 'The viewer needs a separate valid TRAFFICWATCH_OVERVIEW_PORT.'}
  $env:CODEX_FLOW_PORT = "$port"
  $env:TRAFFICWATCH_OVERVIEW_PORT="$overviewPort"
  $baseUrl = "http://127.0.0.1:$port"
  $overviewUrl="http://127.0.0.1:$overviewPort"
  $logDir=if($env:CODEX_FLOW_DATA_DIR){$env:CODEX_FLOW_DATA_DIR}else{Join-Path $projectRoot 'data'}
  if($Demo){$logDir=Join-Path $logDir 'demo'}
  $logDir=[IO.Path]::GetFullPath($logDir)
  $overview=$null
  try { $overview=Invoke-RestMethod -Uri "$overviewUrl/api/health" -TimeoutSec 2 } catch { $overviewProbeError=$_.Exception.Message }
  if($overview -and ($overview.app -ne 'trafficwatch-overview' -or -not $overview.singleCollector -or [bool]($overview.singleCollector -eq 'demo') -ne [bool]$Demo)){
    throw 'The viewer port is occupied by another mode. Set TRAFFICWATCH_OVERVIEW_PORT.'
  }
  $health = $null
  try { $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2 } catch { }
  if ($health) {
    if ($health.app -ne 'codex-flow' -or [bool]$health.demo -ne [bool]$Demo) { throw 'The port is occupied by a different app or monitor mode. Set CODEX_FLOW_PORT.' }
  } else {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $nodeArguments = @('--disable-warning=ExperimentalWarning', ('"' + (Join-Path $projectRoot 'src\main.mjs') + '"'))
    if ($Demo) { $nodeArguments += '--demo' }
    $launchedProcess = Start-Process -FilePath $nodePath -ArgumentList $nodeArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log') -PassThru
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
      Start-Sleep -Milliseconds 200
      try { $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 1; break } catch { }
      if ($launchedProcess.HasExited) { throw 'Monitor exited. See data/server-error.log for details.' }
    }
    if (!$health -or $health.app -ne 'codex-flow') { throw 'Monitor did not become ready. See data/server-error.log.' }
  }
  if(!$overview){
    $env:TRAFFICWATCH_DATA_ROOT=$logDir
    $env:TRAFFICWATCH_CACHE_ROOT=Join-Path $logDir 'viewer-cache'
    $env:TRAFFICWATCH_MACHINE_PORT="$port"
    $env:TRAFFICWATCH_CLASH_PORT="$overviewPort"
    $env:TRAFFICWATCH_SINGLE_COLLECTOR='1'
    $env:TRAFFICWATCH_DEMO=if($Demo){'1'}else{'0'}
    $viewer=Start-Process -FilePath $nodePath -ArgumentList @('--disable-warning=ExperimentalWarning',('"'+(Join-Path $projectRoot 'src\overview-server.mjs')+'"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'overview.log') -RedirectStandardError (Join-Path $logDir 'overview-error.log') -PassThru
    for($attempt=0;$attempt -lt 40;$attempt++){
      if($viewer.HasExited){throw ('Viewer exited with code '+$viewer.ExitCode+'. See overview-error.log in '+$logDir)}
      try{$overview=Invoke-RestMethod -Uri "$overviewUrl/api/health" -TimeoutSec 1;if($overview.collectorPid -eq $viewer.Id){break}}catch{$overviewProbeError=$_.Exception.Message}
      Start-Sleep -Milliseconds 150
    }
    if(!$overview -or $overview.collectorPid -ne $viewer.Id){throw ('Viewer did not become ready: '+$overviewProbeError)}
  }
  Write-Host "TrafficWatch: $overviewUrl/"
  if (!$NoBrowser) { Start-Process $overviewUrl }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
