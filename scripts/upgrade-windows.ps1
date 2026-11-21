param([switch]$Preflight)
$ErrorActionPreference='Stop'
$programs=[IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\')
$packageRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$installRoot=Join-Path $programs 'TrafficWatch'
$systemShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskNames=@('TrafficWatch - Open-source Netwatch','TrafficWatch - Tray','TrafficWatch - AI diagnostics','TrafficWatch - Relay physical bypass')
$ports=@(43128,43130,43131,43132)

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
$legacyFile=Join-Path $dataRoot 'vault\vault.json'
$needsMigration=Test-Path -LiteralPath $legacyFile -PathType Leaf
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
[ordered]@{installed=$old.version;candidate=$new.version;administrator=$admin;program=$installRoot;history=$dataRoot;legacyPasswordRequired=[bool]$needsMigration;inputBytes=$inputBytes;freeBytes=$drive.AvailableFreeSpace;migrationSpace=$migrationSpace} | ConvertTo-Json
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

function Read-LocalHealth([int]$Port) {
    try {
        $request=[Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/health")
        $request.Proxy=$null; $request.AllowAutoRedirect=$false; $request.Timeout=1300; $request.ReadWriteTimeout=1300
        $response=$request.GetResponse()
        try {
            $reader=[IO.StreamReader]::new($response.GetResponseStream())
            try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
        } finally { $response.Dispose() }
    } catch { return [pscustomobject]@{Error=$_.Exception.Message} }
}

function Stop-TrafficWatch {
    & $systemShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $installRoot 'scripts\TrafficWatch-Control.ps1') -Action Stop
    if ($LASTEXITCODE -ne 0) { throw "TrafficWatch could not stop safely, exit $LASTEXITCODE." }
    foreach ($port in $ports) {
        if (Get-NetTCPConnection -LocalPort $port -LocalAddress '127.0.0.1' -State Listen -ErrorAction SilentlyContinue) {
            throw "Port $port is still in use after the scoped TrafficWatch stop."
        }
    }
}

$stopPath=Join-Path $dataRoot 'stop.request'
$stamp=[guid]::NewGuid().ToString('N')
$newApp=Join-Path $programs ('TrafficWatch.stage.'+$stamp)
$rollback=Join-Path $programs ('TrafficWatch.rollback.'+$stamp)
$failed=Join-Path $programs ('TrafficWatch.failed.'+$stamp)
$manifest=Get-Content -LiteralPath (Join-Path $packageRoot 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
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
    $taskState=@(Get-ScheduledTask -TaskName $taskNames | ForEach-Object {
        [pscustomobject]@{Name=$_.TaskName;Running=$_.State -eq 'Running';Enabled=$_.Settings.Enabled}
    })
    if ($taskState.Count -ne $taskNames.Count) { throw 'Existing TrafficWatch tasks are incomplete.' }
    $oldStop=$null
    if (Test-Path -LiteralPath $stopPath) { $oldStop=[IO.File]::ReadAllBytes($stopPath) }
    $originalAcl=Get-Acl -LiteralPath $dataRoot
    if ($needsMigration) { $credential=Read-Host 'Old TrafficWatch password or recovery code (one time)' -AsSecureString }
    [IO.Directory]::CreateDirectory($newApp) | Out-Null
    foreach ($entry in $manifest.files) {
        $relative=[string]$entry.path
        $source=[IO.Path]::GetFullPath((Join-Path $packageRoot $relative))
        $destination=[IO.Path]::GetFullPath((Join-Path $newApp $relative))
        if (-not $source.StartsWith($packageRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or
            -not $destination.StartsWith($newApp+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe manifest path.' }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
            throw "Staged file failed hash verification: $relative"
        }
    }
    Copy-Item -LiteralPath (Join-Path $packageRoot 'release-manifest.json') -Destination $newApp
    foreach ($name in @('suite-settings.json','config.local.json')) {
        $file=Join-Path $installRoot $name
        if (Test-Path -LiteralPath $file -PathType Leaf) { Copy-Item -LiteralPath $file -Destination $newApp }
    }
    $stopped=$true
    Stop-TrafficWatch
    Protect-HistoryRoot $owner
    $aclChanged=$true
    if ($needsMigration) {
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
    if (($taskState | Where-Object Name -eq $taskNames[0]).Running -and -not (Test-Path -LiteralPath (Join-Path $dataRoot 'capture-paused'))) { $expected+=43128; $expected+=43130 }
    $trayExpected=($taskState | Where-Object Name -eq $taskNames[1]).Running
    if ($trayExpected) { $expected+=43131 }
    if (($taskState | Where-Object Name -eq $taskNames[2]).Running) { $expected+=43132 }
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    do {
        $remaining=@(foreach ($port in $expected) {
            $health=Read-LocalHealth $port
            if (($port -eq 43132 -and ($health.app -ne 'trafficwatch-ai-diagnostics' -or $health.storage -ne 'sqlite-wal')) -or
               ($port -ne 43132 -and $health.version -ne $new.version)) { "$port $($health.Error)" }
        })
        if (-not $remaining.Count) { break }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count) { throw ('New version health checks failed: '+($remaining -join ', ')) }
    if ($trayExpected -and -not (Get-Process -Name 'TrafficWatch-Tray' -ErrorAction SilentlyContinue | Where-Object Path -eq (Join-Path $installRoot 'TrafficWatch-Tray.exe'))) {
        throw 'Updated tray process was not found.'
    }
    Write-Host "TrafficWatch $($new.version) installed. Previous program: $rollback. Original history retained at $dataRoot."
} catch {
    $problem=$_.Exception.Message
    if ($movedNew) {
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
