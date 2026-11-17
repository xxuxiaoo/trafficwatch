param([ValidateSet('Run','Stop','Status')][string]$Action='Run')
$ErrorActionPreference='Stop'
$suiteRoot=$PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $suiteRoot 'src\main.mjs')) {
    $suiteApp=$suiteRoot
    $suiteRoot=Split-Path -Parent $suiteRoot
} else {
    $suiteApp=Join-Path $suiteRoot 'app'
}
$suiteSettingsPath=Join-Path $suiteApp 'suite-settings.json'
$suiteOwnerSettings=if (Test-Path -LiteralPath $suiteSettingsPath) { Get-Content -LiteralPath $suiteSettingsPath -Raw | ConvertFrom-Json } else { $null }
$suiteData=if ($suiteOwnerSettings -and $suiteOwnerSettings.DataRoot) { [IO.Path]::GetFullPath([string]$suiteOwnerSettings.DataRoot) } else { Join-Path $suiteRoot 'data' }
$suiteNode=Join-Path $suiteApp 'runtime\node.exe'
$suiteHeader=@{'x-codex-flow'='1'}
$suiteStopSignal=Join-Path $suiteData 'stop.request'
$suiteProfiles=@(
    @{Name='windows';Port=43128;Mode='native'},
    @{Name='clash';Port=43130;Mode='mihomo'}
)
function Read-SuiteHealth($profile) {
    try { return Invoke-RestMethod -Uri ('http://127.0.0.1:'+ $profile.Port +'/api/health') -TimeoutSec 3 } catch { return $null }
}
if ($Action -eq 'Status') {
    @($suiteProfiles | ForEach-Object { $suiteHealth=Read-SuiteHealth $_; [pscustomobject]@{Name=$_.Name;Port=$_.Port;Health=$suiteHealth} }) | ConvertTo-Json -Depth 8
    exit
}
if ($Action -eq 'Stop') {
    New-Item -ItemType Directory -Path $suiteData -Force | Out-Null
    [IO.File]::WriteAllText($suiteStopSignal,(Get-Date).ToString('o'))
    foreach ($suiteProfile in $suiteProfiles) {
        try { Invoke-RestMethod -Uri ('http://127.0.0.1:'+ $suiteProfile.Port +'/api/stop') -Method Post -Headers $suiteHeader -Body '{}' -ContentType 'application/json' -TimeoutSec 3 | Out-Null } catch {}
    }
    try{Invoke-RestMethod -Uri 'http://127.0.0.1:43131/api/stop' -Method Post -Headers $suiteHeader -TimeoutSec 3|Out-Null}catch{}
    exit
}
New-Item -ItemType Directory -Path $suiteData -Force | Out-Null
if (Test-Path -LiteralPath $suiteStopSignal) { Remove-Item -LiteralPath $suiteStopSignal -Force }
$suiteLog=Join-Path $suiteData 'supervisor.log'
$suiteChildren=@{}
$suiteLastNativeRetry=[datetime]::MinValue
function Write-SuiteLog([string]$text) {
    if ((Test-Path -LiteralPath $suiteLog) -and (Get-Item -LiteralPath $suiteLog).Length -gt 2MB) { Copy-Item -LiteralPath $suiteLog -Destination ($suiteLog+'.previous') -Force; Clear-Content -LiteralPath $suiteLog }
    Add-Content -LiteralPath $suiteLog -Value ((Get-Date).ToString('o')+' '+$text) -Encoding UTF8
}
function Repair-SuiteNativeSessions {
    # A killed helper cannot execute its ETW finally block. Clean up only this
    # project's sessions, and only when no project capture helper is alive.
    if (Get-Process -Name 'Codex-Netwatch-Capture' -ErrorAction SilentlyContinue) { return }
    $suiteTraceLines=@(& "$env:SystemRoot\System32\logman.exe" query -ets 2>$null)
    foreach ($suiteTraceLine in $suiteTraceLines) {
        if ($suiteTraceLine -match '^\s*(CodexNetwatch-[a-f0-9]{32})\s') {
            $suiteTraceName=$Matches[1]
            & "$env:SystemRoot\System32\logman.exe" stop $suiteTraceName -ets *> $null
            Write-SuiteLog ('Stopped stale native ETW session '+$suiteTraceName+'; exit '+$LASTEXITCODE)
        }
    }
}
function Start-SuiteProfile($profile) {
    $profileData=Join-Path $suiteData $profile.Name
    New-Item -ItemType Directory -Path $profileData -Force | Out-Null
    $env:CODEX_FLOW_DATA_DIR=$profileData
    $env:CODEX_FLOW_PORT=[string]$profile.Port
    $env:CODEX_NETWATCH_CAPTURE_MODE=$profile.Mode
    # Deliberately unreachable in native mode: ETW must work without a proxy API.
    $env:CODEX_FLOW_CONTROLLER=if ($profile.Mode -eq 'native') { '127.0.0.1:1' } else { 'auto' }
    $env:MIHOMO_SECRET=''
    if (-not $suiteOwnerSettings -or -not $suiteOwnerSettings.ClashConfigPath) { throw 'suite-settings.json must name the owner Clash configuration for system startup.' }
    $suiteClashFile=[string]$suiteOwnerSettings.ClashConfigPath
    if ($profile.Mode -eq 'mihomo' -and (Test-Path -LiteralPath $suiteClashFile)) {
        $suiteClashText=[IO.File]::ReadAllText($suiteClashFile)
        $suiteSecretMatch=[regex]::Match($suiteClashText,'(?m)^secret:\s*([^\r\n]*)')
        if ($suiteSecretMatch.Success) {
            $suiteSecret=$suiteSecretMatch.Groups[1].Value.Trim()
            if ($suiteSecret.StartsWith('"') -and $suiteSecret.EndsWith('"')) { $suiteSecret=ConvertFrom-Json $suiteSecret }
            elseif ($suiteSecret.StartsWith("'") -and $suiteSecret.EndsWith("'")) { $suiteSecret=$suiteSecret.Substring(1,$suiteSecret.Length-2).Replace("''", "'") }
            $env:MIHOMO_SECRET=$suiteSecret
        }
        # Clash Verge can rotate this configured pipe name while keeping the
        # same service active. Leave the controller on auto so the collector
        # discovers the live production pipe instead of pinning a stale path.
    }
    $suiteStdout=Join-Path $profileData 'collector.log'
    $suiteStderr=Join-Path $profileData 'collector-error.log'
    foreach ($suiteLogFile in @($suiteStdout,$suiteStderr)) { if (Test-Path -LiteralPath $suiteLogFile) { Copy-Item -LiteralPath $suiteLogFile -Destination ($suiteLogFile+'.previous') -Force } }
    $suiteProcess=Start-Process -FilePath $suiteNode -ArgumentList '--disable-warning=ExperimentalWarning','src/main.mjs' -WorkingDirectory $suiteApp -WindowStyle Hidden -RedirectStandardOutput $suiteStdout -RedirectStandardError $suiteStderr -PassThru
    $suiteChildren[$profile.Name]=$suiteProcess
    $env:MIHOMO_SECRET=''
    Write-SuiteLog ('Started '+$profile.Name+' collector PID '+$suiteProcess.Id)
}
function Ensure-SuiteViewer {
    try{$viewerHealth=Invoke-RestMethod -Uri 'http://127.0.0.1:43131/api/health' -TimeoutSec 2;if($viewerHealth.app -eq 'trafficwatch-overview'){return}}catch{}
    $old=$suiteChildren['viewer'];if($old -and -not $old.HasExited){return}
    $env:TRAFFICWATCH_DATA_ROOT=$suiteData
    $env:TRAFFICWATCH_CACHE_ROOT=Join-Path $suiteData 'viewer-cache'
    New-Item -ItemType Directory -Path $env:TRAFFICWATCH_CACHE_ROOT -Force|Out-Null
    $suiteChildren['viewer']=Start-Process -FilePath $suiteNode -ArgumentList '--disable-warning=ExperimentalWarning','src/overview-server.mjs' -WorkingDirectory $suiteApp -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TRAFFICWATCH_CACHE_ROOT 'viewer.log') -RedirectStandardError (Join-Path $env:TRAFFICWATCH_CACHE_ROOT 'viewer-error.log') -PassThru
    Write-SuiteLog ('Started protected viewer PID '+$suiteChildren['viewer'].Id)
}
function Ensure-SuiteDiagnostics {
    if(-not(Test-Path -LiteralPath (Join-Path $suiteData 'vault\vault.json'))){return}
    foreach($suiteComponent in @('diagnostics','relay-bypass')){
        if($suiteComponent -eq 'relay-bypass' -and -not $suiteOwnerSettings.RelayHosts -and -not(Test-Path -LiteralPath (Join-Path $suiteData 'relay-bypass\managed-targets.json'))){continue}
        $suiteDisabled=Join-Path $suiteData ($suiteComponent+'\disabled')
        if(Test-Path -LiteralPath $suiteDisabled){continue}
        $suiteTaskName=if($suiteComponent -eq 'diagnostics'){'TrafficWatch - AI diagnostics'}else{'TrafficWatch - Relay physical bypass'}
        $suiteTask=Get-ScheduledTask -TaskName $suiteTaskName -ErrorAction SilentlyContinue
        if($suiteTask){if($suiteTask.State -ne 'Running'){Start-ScheduledTask -TaskName $suiteTaskName};continue}
        $suiteOld=$suiteChildren[$suiteComponent];if($suiteOld -and -not $suiteOld.HasExited){continue}
        $suiteLive=$false
        if($suiteComponent -eq 'diagnostics'){
            try{$suiteStatus=Invoke-RestMethod -Uri 'http://127.0.0.1:43132/api/health' -TimeoutSec 1;$suiteLive=$suiteStatus.app -eq 'trafficwatch-ai-diagnostics'}catch{}
        }else{
            if(-not $suiteOwnerSettings.RelayHosts -and -not(Test-Path -LiteralPath (Join-Path $suiteData 'relay-bypass\managed-targets.json'))){continue}
            $suiteBypassState=Join-Path $suiteData 'relay-bypass\status.json'
            try{$suiteStatus=Get-Content -LiteralPath $suiteBypassState -Raw|ConvertFrom-Json;$suiteLive=$suiteStatus.state -notin @('stopped','rolled_back') -and ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$suiteStatus.at -lt 150000) -and [bool](Get-Process -Id $suiteStatus.pid -ErrorAction SilentlyContinue)}catch{}
        }
        if($suiteLive){continue}
        $suiteScript=if($suiteComponent -eq 'diagnostics'){'src/ai-diagnostic-daemon.mjs'}else{'src/relay-bypass.mjs'}
        $suiteDir=Join-Path $suiteData $suiteComponent;[IO.Directory]::CreateDirectory($suiteDir)|Out-Null
        $suiteChildren[$suiteComponent]=Start-Process -FilePath $suiteNode -ArgumentList '--disable-warning=ExperimentalWarning',$suiteScript -WorkingDirectory $suiteApp -WindowStyle Hidden -RedirectStandardOutput (Join-Path $suiteDir 'daemon.log') -RedirectStandardError (Join-Path $suiteDir 'daemon-error.log') -PassThru
        Write-SuiteLog ('Started '+$suiteComponent+' PID '+$suiteChildren[$suiteComponent].Id)
    }
}
Write-SuiteLog 'Supervisor started; Windows native and Mihomo databases are independent.'
Repair-SuiteNativeSessions
while (-not (Test-Path -LiteralPath $suiteStopSignal)) {
    try{Ensure-SuiteViewer}catch{Write-SuiteLog ('Viewer start failed: '+$_.Exception.Message)}
    try{Ensure-SuiteDiagnostics}catch{Write-SuiteLog 'Diagnostics background start failed.'}
    foreach ($suiteProfile in $suiteProfiles) {
        if (Test-Path -LiteralPath $suiteStopSignal) { break }
        $suiteHealth=Read-SuiteHealth $suiteProfile
        if (-not $suiteHealth) {
            $suiteOld=$suiteChildren[$suiteProfile.Name]
            if ($suiteOld -and -not $suiteOld.HasExited) { continue }
            try { Start-SuiteProfile $suiteProfile } catch { Write-SuiteLog ('Start failed '+$suiteProfile.Name+': '+$_.Exception.Message) }
        } elseif ($suiteHealth.app -ne 'codex-flow') {
            Write-SuiteLog ('Port conflict: '+$suiteProfile.Port)
        } elseif ($suiteProfile.Name -eq 'windows' -and $suiteHealth.state -eq 'disconnected' -and ((Get-Date)-$suiteLastNativeRetry).TotalSeconds -gt 30) {
            $suiteLastNativeRetry=Get-Date
            Repair-SuiteNativeSessions
            try { Invoke-RestMethod -Uri ('http://127.0.0.1:'+ $suiteProfile.Port +'/api/capture') -Method Post -Headers $suiteHeader -ContentType 'application/json' -Body '{"mode":"native","authorize":false}' -TimeoutSec 12 | Out-Null } catch { Write-SuiteLog ('Native retry: '+$_.Exception.Message) }
        }
    }
    Start-Sleep -Seconds 5
}
foreach ($suiteProfile in $suiteProfiles) {
    try { Invoke-RestMethod -Uri ('http://127.0.0.1:'+ $suiteProfile.Port +'/api/stop') -Method Post -Headers $suiteHeader -Body '{}' -ContentType 'application/json' -TimeoutSec 3 | Out-Null } catch {}
}
try{Invoke-RestMethod -Uri 'http://127.0.0.1:43131/api/stop' -Method Post -Headers $suiteHeader -TimeoutSec 3|Out-Null}catch{}
$suiteStopDeadline=(Get-Date).AddSeconds(15)
do {
    $suiteLiveHelpers=@(Get-Process -Name 'Codex-Netwatch-Capture' -ErrorAction SilentlyContinue)
    if ($suiteLiveHelpers.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $suiteStopDeadline)
Repair-SuiteNativeSessions
Write-SuiteLog 'Supervisor stopped by request.'
