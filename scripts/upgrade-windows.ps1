param([switch]$Preflight)
$ErrorActionPreference='Stop'
$programs=[IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\')
$packageRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$installRoot=Join-Path $programs 'TrafficWatch'
$systemShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskNames=@('TrafficWatch - Open-source Netwatch','TrafficWatch - Tray','TrafficWatch - AI diagnostics','TrafficWatch - Relay physical bypass')
$ports=@(43128,43130,43131,43132)
. (Join-Path $PSScriptRoot 'upgrade-health.ps1')
. (Join-Path $PSScriptRoot 'upgrade-history.ps1')
. (Join-Path $PSScriptRoot 'upgrade-program.ps1')

if ($packageRoot -eq $installRoot -or $packageRoot.StartsWith($installRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run the upgrade from the extracted new package outside Program Files\TrafficWatch.'
}
& $systemShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-windows.ps1') -ValidatePackageOnly
if ($LASTEXITCODE -ne 0) { throw "Package validation failed, exit $LASTEXITCODE." }
$old=Get-Content -LiteralPath (Join-Path $installRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$new=Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($old.name -notin @('trafficwatch','codex-netwatch') -or $new.name -ne 'trafficwatch' -or [version]$new.version -le [version]$old.version) {
    throw 'The new package must be a newer TrafficWatch version.'
}
$settings=Get-Content -LiteralPath (Join-Path $installRoot 'suite-settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dataRoot=[IO.Path]::GetFullPath([string]$settings.DataRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $dataRoot -PathType Container) -or $dataRoot.StartsWith($installRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or
    $dataRoot -eq $installRoot -or $dataRoot.Length -le [IO.Path]::GetPathRoot($dataRoot).Length) { throw 'Unsafe or missing existing history directory.' }
foreach ($target in @($installRoot,$dataRoot,$packageRoot)) {
    $ancestor=Get-Item -LiteralPath $target -Force
    while ($ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Upgrade path uses a reparse point: $($ancestor.FullName)" }
        $ancestor=$ancestor.Parent
    }
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$historyPlan=Get-UpgradeHistoryPlan $dataRoot ([version]$old.version)
$needsMigration=$historyPlan.Mode -eq 'legacy-encrypted'
$historyDir=Join-Path $dataRoot 'history-v2'
$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($dataRoot))
$inputBytes=0L
if ($needsMigration) {
    foreach ($lane in @('windows','clash','diagnostics')) {
        $file=Join-Path $dataRoot "$lane\history.vault.sqlite"
        $inputBytes+=(Get-Item -LiteralPath $file).Length
        foreach ($name in @('history.vault.sqlite-wal','ingest.sqlite','ingest.sqlite-wal')) {
            $companion=Join-Path $dataRoot "$lane\$name"
            if (Test-Path -LiteralPath $companion -PathType Leaf) { $inputBytes+=(Get-Item -LiteralPath $companion).Length }
        }
    }
}
$migrationSpace=if ($needsMigration) { $inputBytes * 4 + 1GB } else { 0 }
[ordered]@{installed=$old.version;candidate=$new.version;administrator=$admin;program=$installRoot;history=$dataRoot;historyMode=$historyPlan.Mode;verifiedLanes=$historyPlan.Lanes;legacyPasswordRequired=$needsMigration;inputBytes=$inputBytes;freeBytes=$drive.AvailableFreeSpace;migrationSpace=$migrationSpace} | ConvertTo-Json
if ($drive.AvailableFreeSpace -lt $migrationSpace) { throw 'Insufficient free space for separately verified history and recovery files.' }
if ($Preflight) {
    foreach ($name in $taskNames) {
        # Access denied is expected for SYSTEM-only tasks in a normal shell.
        # Record the actual error and continue checking the entire installation.
        $savedPreference=$ErrorActionPreference
        try {
            $ErrorActionPreference='Continue'
            $output=@(& "$env:SystemRoot\System32\schtasks.exe" /query /tn $name 2>&1)
            $code=$LASTEXITCODE
        } finally { $ErrorActionPreference=$savedPreference }
        Write-Host "Task query exit $code - $name"
        if ($code -ne 0) { foreach ($line in $output) { Write-Host ([string]$line) } }
    }
    if ($needsMigration) {
        & (Join-Path $packageRoot 'runtime\node.exe') --disable-warning=ExperimentalWarning (Join-Path $packageRoot 'migration\migrate-history.mjs') --inspect-checkpoints $dataRoot
        if ($LASTEXITCODE -ne 0) { throw "History checkpoint inspection failed, exit $LASTEXITCODE." }
    }
    exit 0
}
if (-not $admin) { throw 'Open Windows PowerShell as administrator and run this same upgrade command. No process has been stopped.' }

function Invoke-Migration([Security.SecureString]$Password) {
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=Join-Path $newApp 'runtime\node.exe'
    $info.Arguments='--disable-warning=ExperimentalWarning "'+(Join-Path $newApp 'migration\migrate-history.mjs')+'" --data-root "'+$dataRoot+'"'
    $info.WorkingDirectory=$newApp
    $info.UseShellExecute=$false
    $info.RedirectStandardInput=$true
    $child=[Diagnostics.Process]::Start($info)
    $secret=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    try {
        $text=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($secret)
        $utf8=[Text.Encoding]::UTF8.GetBytes($text+"`n")
        try { $child.StandardInput.BaseStream.Write($utf8,0,$utf8.Length) }
        finally { [Array]::Clear($utf8,0,$utf8.Length); $text=$null; $child.StandardInput.Close() }
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secret) }
    $child.WaitForExit()
    $code=$child.ExitCode
    $child.Dispose()
    if ($code -ne 0) { throw "History migration failed, exit $code. Original history files are available for retry." }
}

function Protect-HistoryRoot([Security.Principal.SecurityIdentifier]$Owner) {
    $acl=Get-Acl -LiteralPath $dataRoot
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    foreach ($sid in @($Owner.Value,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique) {
        $account=[Security.Principal.SecurityIdentifier]::new($sid)
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($account,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $dataRoot -AclObject $acl
}

function Restore-Tasks {
    $stop=Join-Path $dataRoot 'stop.request'
    if ($null -ne $oldStop) { [IO.File]::WriteAllBytes($stop,$oldStop) }
    elseif (Test-Path -LiteralPath $stop) { Remove-Item -LiteralPath $stop -Force }
    foreach ($task in $taskState) {
        if (-not $task.Running) { continue }
        if (-not $task.Enabled) { Enable-ScheduledTask -TaskName $task.Name | Out-Null }
        try { Start-ScheduledTask -TaskName $task.Name }
        finally { if (-not $task.Enabled) { Disable-ScheduledTask -TaskName $task.Name | Out-Null } }
    }
}

function Write-StartupLogs {
    $viewerLog=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TrafficWatch\logs\overview-launch.log'
    if (Test-Path -LiteralPath $viewerLog -PathType Leaf) {
        Write-Host 'TrafficWatch overview startup log'
        try { Get-Content -LiteralPath $viewerLog -Encoding UTF8 -Tail 10 | Write-Host }
        catch { Write-Warning "Could not read overview startup log - $($_.Exception.Message)" }
    }
    foreach ($relative in @('supervisor.log','windows\collector.log','windows\collector-error.log',
        'clash\collector.log','clash\collector-error.log','diagnostics\daemon.log','diagnostics\daemon-error.log')) {
        $file=Join-Path $dataRoot $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        Write-Host "TrafficWatch startup log ($relative)"
        try { Get-Content -LiteralPath $file -Encoding UTF8 -Tail 10 | Write-Host }
        catch { Write-Warning "Could not read $relative - $($_.Exception.Message)" }
    }
}

function Stop-TrafficWatch {
    & $systemShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $installRoot 'scripts\TrafficWatch-Control.ps1') -Action Stop
    if ($LASTEXITCODE -ne 0) { throw "TrafficWatch could not stop safely, exit $LASTEXITCODE." }
    $wait=[Diagnostics.Stopwatch]::StartNew()
    do {
        $remaining=@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $_.Port -in $ports -and $_.Address.ToString() -in @('127.0.0.1','0.0.0.0','::','::ffff:127.0.0.1') })
        if (-not $remaining.Count) { return }
        Start-Sleep -Milliseconds 250
    } while ($wait.ElapsedMilliseconds -lt 5000)
    throw ('Listeners remain after the scoped TrafficWatch stop: '+($remaining -join ', '))
}

$stopPath=Join-Path $dataRoot 'stop.request'
$stamp=[guid]::NewGuid().ToString('N')
$newApp=Join-Path $programs ('TrafficWatch.stage.'+$stamp)
$rollback=Join-Path $programs ('TrafficWatch.rollback.'+$stamp)
$failed=Join-Path $programs ('TrafficWatch.failed.'+$stamp)
$owner=[Security.Principal.SecurityIdentifier]::new([string]$settings.OwnerSid)
$credential=$null
$upgradeLock=[Threading.Mutex]::new($false,'Global\TrafficWatch.Upgrade')
$ownsUpgradeLock=$false
$stopped=$false
$movedOld=$false
$movedNew=$false
$aclChanged=$false
try {
    try { $ownsUpgradeLock=$upgradeLock.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsUpgradeLock=$true }
    if (-not $ownsUpgradeLock) { throw 'Another TrafficWatch upgrade is in progress.' }
    $installed=Get-Content -LiteralPath (Join-Path $installRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($installed.version -ne $old.version) { throw 'The installed version changed during preflight. Run preflight again.' }
    $currentHistoryPlan=Get-UpgradeHistoryPlan $dataRoot ([version]$installed.version)
    if ($currentHistoryPlan.Mode -ne $historyPlan.Mode) { throw 'The history layout changed during preflight. Run preflight again.' }
    $taskState=@(Get-ScheduledTask -TaskName $taskNames | ForEach-Object {
        [pscustomobject]@{Name=$_.TaskName;Running=$_.State -eq 'Running';Enabled=$_.Settings.Enabled}
    })
    if ($taskState.Count -ne $taskNames.Count) { throw 'Existing TrafficWatch tasks are incomplete.' }
    $oldStop=$null
    if (Test-Path -LiteralPath $stopPath) { $oldStop=[IO.File]::ReadAllBytes($stopPath) }
    if ($needsMigration) {
        $originalAcl=Get-Acl -LiteralPath $dataRoot
        $credential=Read-Host 'Old TrafficWatch password or recovery code (one time)' -AsSecureString
    } elseif ($historyPlan.Mode -eq 'verified-plain') {
        Write-Host 'Keeping the verified plaintext history in place. No password or history conversion is needed.'
    }
    $stageTimer=[Diagnostics.Stopwatch]::StartNew()
    Copy-TrafficWatchUpgradeStage $packageRoot $installRoot $newApp
    Write-Host "TrafficWatch program staged and verified in $($stageTimer.ElapsedMilliseconds)ms."
    $restartTimer=[Diagnostics.Stopwatch]::StartNew()
    $stopped=$true
    Stop-TrafficWatch
    if ($needsMigration) {
        Protect-HistoryRoot $owner
        $aclChanged=$true
        Invoke-Migration $credential
        $historyManifest=Join-Path $historyDir 'migration.json'
        $verifiedHistory=Get-Content -LiteralPath $historyManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($verifiedHistory.verified -ne $true) { throw 'Verified history manifest not found.' }
        foreach ($lane in $verifiedHistory.lanes.PSObject.Properties) {
            $queue=$lane.Value.queue
            if ($queue.quarantined -or $queue.partial) {
                Write-Warning "History $($lane.Name) queue: $($queue.quarantined) quarantined packets, $($queue.partial) partially imported packets. Original queue retained. See $historyManifest"
            }
        }
    }
    [IO.Directory]::Move($installRoot,$rollback)
    $movedOld=$true
    [IO.Directory]::Move($newApp,$installRoot)
    $movedNew=$true
    Restore-Tasks
    $expected=@()
    if (($taskState | Where-Object Name -eq $taskNames[0]).Running -and -not (Test-Path -LiteralPath (Join-Path $dataRoot 'capture-paused'))) {
        $expected+=@{Port=43128;App='codex-flow';Collector=$true},@{Port=43130;App='codex-flow';Collector=$true}
    }
    $trayExpected=($taskState | Where-Object Name -eq $taskNames[1]).Running
    if ($trayExpected) { $expected+=@{Port=43131;App='trafficwatch-overview';Storage='sqlite-wal'} }
    if (($taskState | Where-Object Name -eq $taskNames[2]).Running) { $expected+=@{Port=43132;App='trafficwatch-ai-diagnostics';Storage='sqlite-wal'} }
    Wait-TrafficWatchHealth -Checks $expected -Version $new.version
    if ($trayExpected -and -not (Get-Process -Name 'TrafficWatch-Tray' -ErrorAction SilentlyContinue | Where-Object Path -eq (Join-Path $installRoot 'TrafficWatch-Tray.exe'))) {
        throw 'Updated tray process was not found.'
    }
    if (-not $needsMigration) { Write-Host "TrafficWatch stopped, replaced and checked in $($restartTimer.ElapsedMilliseconds)ms." }
    Write-Host "TrafficWatch $($new.version) installed. Previous program: $rollback. Original history retained at $dataRoot."
} catch {
    $problem=$_.Exception.Message
    if ($movedNew) {
        Write-StartupLogs
        Stop-TrafficWatch
        [IO.Directory]::Move($installRoot,$failed)
    }
    if ($movedOld) { [IO.Directory]::Move($rollback,$installRoot) }
    if ($needsMigration -and $aclChanged -and (Test-Path -LiteralPath $historyDir)) {
        $preserved=Join-Path $dataRoot ('history-v2-rollback-'+$stamp)
        [IO.Directory]::Move($historyDir,$preserved)
        # This directory contains verified plaintext, including possible new rows.
        # Keep it restricted even after restoring the old root's ACL.
        $acl=Get-Acl -LiteralPath $preserved
        $acl.SetAccessRuleProtection($true,$true)
        Set-Acl -LiteralPath $preserved -AclObject $acl
    }
    if ($aclChanged) {
        # Partial conversions contain plaintext. Preserve their restricted ACL
        # before restoring the old root permissions for the previous app.
        foreach ($folder in Get-ChildItem -LiteralPath $dataRoot -Directory -Force | Where-Object Name -Match '^(\.migration-[a-f0-9]{16}|history-v2)$') {
            if ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe migration recovery path.' }
            $privateAcl=Get-Acl -LiteralPath $folder.FullName
            $privateAcl.SetAccessRuleProtection($true,$true)
            Set-Acl -LiteralPath $folder.FullName -AclObject $privateAcl
        }
        Set-Acl -LiteralPath $dataRoot -AclObject $originalAcl
    }
    if ($stopped) { Restore-Tasks }
    throw "TrafficWatch upgrade did not finish. $problem"
} finally {
    if ($credential) { $credential.Dispose() }
    if ($ownsUpgradeLock) { $upgradeLock.ReleaseMutex() }
    $upgradeLock.Dispose()
}
