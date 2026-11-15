param(
    [ValidateSet('Status','Start','Stop','EnableStartup','DisableStartup','StartDiagnostics','StopDiagnostics','EnableBypass','RollbackBypass')]
    [string]$Action='Status'
)
$ErrorActionPreference='Stop'
$controlRoot=[IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'TrafficWatch'))
$controlTask='TrafficWatch - Open-source Netwatch'
$controlTrayTask='TrafficWatch - Tray'
$controlDiagnosticTask='TrafficWatch - AI diagnostics'
$controlBypassTask='TrafficWatch - Relay physical bypass'
$controlSettings=Get-Content -LiteralPath (Join-Path $controlRoot 'suite-settings.json') -Raw | ConvertFrom-Json
$controlData=[IO.Path]::GetFullPath([string]$controlSettings.DataRoot)
$controlStopSignal=Join-Path $controlData 'stop.request'
$controlSupervisor=Join-Path $controlRoot 'TrafficWatch-Supervisor.ps1'
$controlObserver=Join-Path $controlRoot 'scripts\windows-observer.ps1'
$controlExpectedExecutables=@(
    (Join-Path $controlRoot 'runtime\node.exe'),
    (Join-Path $controlRoot 'native\Codex-Netwatch-Capture.exe'),
    (Join-Path $controlRoot 'native\TrafficWatch-VaultGuard.exe'),
    (Join-Path $controlRoot 'native\TrafficWatch-AiTrace.exe'),
    (Join-Path $controlRoot 'native\TrafficWatch-RelayProbe.exe'),
    (Join-Path $controlRoot 'TrafficWatch-Tray.exe')
)

function Read-ControlHealth([int]$Port) {
    try {
        $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:'+$Port+'/api/health')
        $request.Proxy=$null
        $request.AllowAutoRedirect=$false
        $request.Timeout=650
        $request.ReadWriteTimeout=650
        $response=$request.GetResponse()
        try {
            $reader=[IO.StreamReader]::new($response.GetResponseStream())
            try { $packet=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
            $expectedApp=if ($Port -eq 43131) { 'trafficwatch-overview' } else { 'codex-flow' }
            if ($packet.app -eq $expectedApp) { return $packet }
        } finally { $response.Dispose() }
    } catch {}
    return $null
}

function Get-ControlProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR Name='TrafficWatch-Tray.exe' OR Name='Codex-Netwatch-Capture.exe' OR Name='TrafficWatch-VaultGuard.exe' OR Name='TrafficWatch-AiTrace.exe' OR Name='TrafficWatch-RelayProbe.exe'" | Where-Object {
        if ($controlExpectedExecutables -contains $_.ExecutablePath) { return $true }
        if ($_.Name -in @('powershell.exe','pwsh.exe')) {
            $line=[string]$_.CommandLine
            foreach ($scriptPath in @($controlSupervisor,$controlObserver,(Join-Path $controlRoot 'scripts\TrafficWatch-RelayRoutes.ps1'),(Join-Path $controlRoot 'scripts\TrafficWatch-PktMon.ps1'),(Join-Path $controlRoot 'scripts\TrafficWatch-Resources.ps1'))) {
                # Match a complete, fixed script path, not a process name or an arbitrary substring.
                $quoted='(?i)(?:^|\s)-File\s+(?:"'+[regex]::Escape($scriptPath)+'"|'+[regex]::Escape($scriptPath)+'(?=\s|$))'
                if ($line -match $quoted) { return $true }
            }
        }
        return $false
    })
}

function Get-ControlState {
    $task=Get-ScheduledTask -TaskName $controlTask
    $trayTask=Get-ScheduledTask -TaskName $controlTrayTask
    $diagnosticHealth=$null
    try{$diagnosticHealth=Invoke-RestMethod -Uri 'http://127.0.0.1:43132/api/health' -TimeoutSec 1}catch{}
    [ordered]@{
        at=(Get-Date).ToString('o')
        taskState=[string]$task.State
        startupEnabled=[bool]$task.Settings.Enabled
        trayStartupEnabled=[bool]$trayTask.Settings.Enabled
        machine=Read-ControlHealth 43128
        clash=Read-ControlHealth 43130
        overview=Read-ControlHealth 43131
        diagnostics=$diagnosticHealth
        processes=@(Get-ControlProcesses | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath)
    }
}

function Request-ControlStop([int]$Port,$Owned) {
    $health=Read-ControlHealth $Port
    if (-not $health) { return }
    if (-not ($Owned | Where-Object { $_.ProcessId -eq $health.collectorPid -and $_.ExecutablePath -eq (Join-Path $controlRoot 'runtime\node.exe') })) {
        throw ('Port '+$Port+' belongs to another process; it was not stopped.')
    }
    try {
        $request=[Net.HttpWebRequest]::Create('http://127.0.0.1:'+$Port+'/api/stop')
        $request.Proxy=$null
        $request.AllowAutoRedirect=$false
        $request.Method='POST'
        $request.Headers['X-Codex-Flow']='1'
        $request.ContentType='application/json'
        $request.ContentLength=2
        $request.Timeout=1000
        $request.ReadWriteTimeout=1000
        $stream=$request.GetRequestStream()
        try { $stream.Write([byte[]]@(123,125),0,2) } finally { $stream.Dispose() }
        $response=$request.GetResponse()
        $response.Dispose()
    } catch {
        # The verified process may be hung. The scoped fallback below handles it.
    }
}

function Stop-ControlSuite {
    if (-not (Test-Path -LiteralPath $controlData -PathType Container)) { throw 'The existing data folder is missing.' }
    [IO.File]::WriteAllText($controlStopSignal,(Get-Date).ToString('o'))
    $owned=@(Get-ControlProcesses)
    foreach ($port in @(43128,43130,43131)) { Request-ControlStop $port $owned }

    # Signal the existing user-session tray before any forced fallback.
    $tray=Join-Path $controlRoot 'TrafficWatch-Tray.exe'
    if ($owned | Where-Object { $_.ExecutablePath -eq $tray }) {
        $traySignal=Start-Process -FilePath $tray -ArgumentList '--attach-suite','--exit' -WindowStyle Hidden -PassThru
        $null=$traySignal.WaitForExit(3000)
    }
    $deadline=(Get-Date).AddSeconds(12)
    do {
        $remaining=@(Get-ControlProcesses)
        $task=Get-ScheduledTask -TaskName $controlTask
        if ($remaining.Count -eq 0 -and $task.State -ne 'Running') { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $controlTask }
    if ((Get-ScheduledTask -TaskName $controlTrayTask).State -eq 'Running') { Stop-ScheduledTask -TaskName $controlTrayTask }
    foreach($controlExtraTask in @($controlDiagnosticTask,$controlBypassTask)){if((Get-ScheduledTask -TaskName $controlExtraTask -ErrorAction SilentlyContinue).State -eq 'Running'){Stop-ScheduledTask -TaskName $controlExtraTask}}
    foreach ($target in @(Get-ControlProcesses)) {
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$target.ProcessId) -ErrorAction SilentlyContinue
        if (-not $current -or $current.CreationDate -ne $target.CreationDate) { continue }
        $result=Invoke-CimMethod -InputObject $current -MethodName Terminate -Arguments @{Reason=[uint32]0}
        if ($result.ReturnValue -ne 0) { throw ('Cannot stop the verified TrafficWatch process '+$target.ProcessId) }
    }
    Start-Sleep -Milliseconds 600

    # A forcibly terminated helper can leave its private ETW session behind.
    # Never touch other trace names or sessions while any Netwatch helper lives.
    if (-not (Get-Process -Name 'Codex-Netwatch-Capture' -ErrorAction SilentlyContinue)) {
        $traceLines=@(& "$env:SystemRoot\System32\logman.exe" query -ets 2>$null)
        foreach ($traceLine in $traceLines) {
            if ($traceLine -match '^\s*(CodexNetwatch-[a-f0-9]{32})\s') {
                & "$env:SystemRoot\System32\logman.exe" stop $Matches[1] -ets *> $null
                if ($LASTEXITCODE -ne 0) { throw 'A Netwatch ETW session could not be stopped.' }
            }
        }
    }
    if (@(Get-ControlProcesses).Count -ne 0) { throw 'A TrafficWatch process is still running.' }
    if ((Read-ControlHealth 43128) -or (Read-ControlHealth 43130) -or (Read-ControlHealth 43131)) { throw 'A TrafficWatch service still responds on a monitoring port.' }
}

try {
    if ($Action -eq 'Status') {
        Get-ControlState | ConvertTo-Json -Depth 8
        exit 0
    }
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator approval is required.' }
    switch ($Action) {
        'StartDiagnostics' {
            $diagFlag=Join-Path $controlData 'diagnostics\disabled'
            if(Test-Path -LiteralPath $diagFlag){Remove-Item -LiteralPath $diagFlag -Force}
            if(Test-Path -LiteralPath $controlStopSignal){Remove-Item -LiteralPath $controlStopSignal -Force}
            Start-ScheduledTask -TaskName $controlDiagnosticTask
        }
        'StopDiagnostics' {
            [IO.Directory]::CreateDirectory((Join-Path $controlData 'diagnostics'))|Out-Null
            [IO.File]::WriteAllText((Join-Path $controlData 'diagnostics\disabled'),'disabled')
            # The daemon notices this within three seconds and disposes its own ETW session.
            $diagDeadline=(Get-Date).AddSeconds(12)
            do{try{$diagHealth=Invoke-RestMethod -Uri 'http://127.0.0.1:43132/api/health' -TimeoutSec 1}catch{$diagHealth=$null};if(-not $diagHealth){break};Start-Sleep -Milliseconds 400}while((Get-Date) -lt $diagDeadline)
            if($diagHealth){Stop-ScheduledTask -TaskName $controlDiagnosticTask}
            & (Join-Path $controlRoot 'scripts\TrafficWatch-PktMon.ps1') -Action Stop|Out-Null
        }
        'EnableBypass' {
            $bypassFlag=Join-Path $controlData 'relay-bypass\disabled'
            if(Test-Path -LiteralPath $bypassFlag){Remove-Item -LiteralPath $bypassFlag -Force}
            if(Test-Path -LiteralPath $controlStopSignal){Remove-Item -LiteralPath $controlStopSignal -Force}
            Start-ScheduledTask -TaskName $controlBypassTask
        }
        'RollbackBypass' {
            [IO.Directory]::CreateDirectory((Join-Path $controlData 'relay-bypass'))|Out-Null
            [IO.File]::WriteAllText((Join-Path $controlData 'relay-bypass\disabled'),'disabled')
            if((Get-ScheduledTask -TaskName $controlBypassTask -ErrorAction SilentlyContinue).State -eq 'Running'){Stop-ScheduledTask -TaskName $controlBypassTask}
            $bypassDeadline=(Get-Date).AddSeconds(25)
            do{
                $bypassProcesses=@(Get-ControlProcesses|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[/\\]relay-bypass\.mjs'})
                if(-not $bypassProcesses){break};Start-Sleep -Milliseconds 500
            }while((Get-Date) -lt $bypassDeadline)
            foreach($bypassProcess in $bypassProcesses){Stop-Process -Id $bypassProcess.ProcessId -ErrorAction SilentlyContinue}
            & (Join-Path $controlRoot 'runtime\node.exe') --disable-warning=ExperimentalWarning (Join-Path $controlRoot 'src\relay-bypass.mjs') --rollback
            if($LASTEXITCODE -ne 0){throw 'Bypass rollback did not complete. Original DIRECT rules remain.'}
        }
        'Stop' { Stop-ControlSuite }
        'Start' {
            $task=Get-ScheduledTask -TaskName $controlTask
            $wasEnabled=[bool]$task.Settings.Enabled
            try {
                if (-not $wasEnabled) { Enable-ScheduledTask -TaskName $controlTask | Out-Null }
                Start-ScheduledTask -TaskName $controlTask
                $deadline=(Get-Date).AddSeconds(30)
                do {
                    Start-Sleep -Milliseconds 700
                    $machine=Read-ControlHealth 43128
                    $clash=Read-ControlHealth 43130
                    if ($machine -and $clash) { break }
                } while ((Get-Date) -lt $deadline)
                if (-not $machine -or -not $clash) { throw 'Startup timed out. Use Stop and inspect the collector logs.' }
            } finally {
                # A manual start must preserve the user's boot preference.
                if (-not $wasEnabled) { Disable-ScheduledTask -TaskName $controlTask | Out-Null }
            }
        }
        'EnableStartup' {
            Enable-ScheduledTask -TaskName $controlTask | Out-Null
            Enable-ScheduledTask -TaskName $controlTrayTask | Out-Null
            foreach($controlExtraTask in @($controlDiagnosticTask,$controlBypassTask)){Enable-ScheduledTask -TaskName $controlExtraTask|Out-Null}
        }
        'DisableStartup' {
            # Disabling scheduled triggers alone does not stop an already-running task.
            Stop-ControlSuite
            Disable-ScheduledTask -TaskName $controlTask | Out-Null
            Disable-ScheduledTask -TaskName $controlTrayTask | Out-Null
            foreach($controlExtraTask in @($controlDiagnosticTask,$controlBypassTask)){Disable-ScheduledTask -TaskName $controlExtraTask|Out-Null}
        }
    }
    $logDir=Join-Path $controlRoot 'logs'
    [IO.Directory]::CreateDirectory($logDir) | Out-Null
    Add-Content -LiteralPath (Join-Path $logDir 'control.log') -Value ((Get-Date).ToString('o')+' '+$Action+' OK') -Encoding UTF8
    exit 0
} catch {
    $controlFailure=$_.Exception.Message
    try {
        $logDir=Join-Path $controlRoot 'logs'
        [IO.Directory]::CreateDirectory($logDir) | Out-Null
        Add-Content -LiteralPath (Join-Path $logDir 'control.log') -Value ((Get-Date).ToString('o')+' '+$Action+' FAILED: '+$controlFailure) -Encoding UTF8
    } catch {}
    [Console]::Error.WriteLine($controlFailure)
    exit 1
}
