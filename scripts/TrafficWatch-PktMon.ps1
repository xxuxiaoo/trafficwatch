param([ValidateSet('Start','Snapshot','Stop','Status')][string]$Action='Status',[string]$InputFile)
$ErrorActionPreference='Stop'
$pktRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$pktSettings=Get-Content -LiteralPath (Join-Path $pktRoot 'suite-settings.json') -Raw -Encoding UTF8|ConvertFrom-Json
$pktDir=Join-Path ([IO.Path]::GetFullPath($pktSettings.DataRoot)) 'diagnostics\pktmon-private'
$pktStatePath=Join-Path $pktDir 'owner.json'
$pktExe=Join-Path $env:SystemRoot 'System32\pktmon.exe'
$pktLogman=Join-Path $env:SystemRoot 'System32\logman.exe'
function Get-PktActive { $pktSessions=@(& $pktLogman query -ets 2>$null);if($LASTEXITCODE -ne 0){throw 'pktmon_status_denied'};return [bool]@($pktSessions|Where-Object {$_ -match '^\s*PktMon\s'}).Count }
function Read-PktOwner { if(Test-Path -LiteralPath $pktStatePath){return Get-Content -LiteralPath $pktStatePath -Raw|ConvertFrom-Json};return $null }
function Test-PktOwned($owner){
  if(-not $owner){return $false}
  $pktOwnedFile=[IO.Path]::GetFullPath([string]$owner.file)
  if((Split-Path -Parent $pktOwnedFile) -ne [IO.Path]::GetFullPath($pktDir) -or [IO.Path]::GetFileName($pktOwnedFile) -notmatch '^[a-f0-9]{32}\.etl$'){return $false}
  $pktStatus=(& $pktExe status 2>$null|Out-String)
  if($LASTEXITCODE -ne 0){return $false}
  if($pktStatus.IndexOf([string]$owner.file,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $true}
  # Windows omits the output filename in memory mode. The lease created only
  # after a successful start must match every current random-nonce filter,
  # the exact metadata provider flags and the bounded memory size together.
  $pktCurrentNames=@([regex]::Matches($pktStatus,'(?m)^\s*\d+\s+(\S+)\s+TCP\s')|ForEach-Object {$_.Groups[1].Value})
  $pktExpected=@($owner.filters)
  if(-not $pktExpected.Count -or $pktCurrentNames.Count -ne $pktExpected.Count -or [long]$owner.from -le 0){return $false}
  foreach($pktExpectedName in $pktExpected){if($pktExpectedName -notmatch '^TrafficWatch-[a-f0-9]{8}-\d+$' -or $pktCurrentNames -notcontains $pktExpectedName){return $false}}
  return $pktStatus -match '(?m)^\s*Microsoft-Windows-PktMon\s+4\s+0x2\s*$' -and $pktStatus -match '\b8\s+MB\b'
}
function Start-PktOwned($owner){
  & $pktExe start --capture --comp nics --flags 0x002 --pkt-size 64 --file-name $owner.file --file-size 8 --log-mode memory *> $null
  if($LASTEXITCODE -ne 0){throw 'pktmon_start_failed'}
  $owner.from=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [IO.File]::WriteAllText($pktStatePath,($owner|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
}
function Stop-PktOwned($owner){
  $pktSavedFile=[IO.Path]::GetFullPath([string]$owner.file)
  if((Split-Path -Parent $pktSavedFile) -ne [IO.Path]::GetFullPath($pktDir) -or [IO.Path]::GetFileName($pktSavedFile) -notmatch '^[a-f0-9]{32}\.etl$'){throw 'invalid_pktmon_export_path'}
  if(Test-Path -LiteralPath $pktSavedFile){throw 'pktmon_export_collision'}
  # Some Windows versions ignore --file-name for a memory session and write
  # PktMon.etl in the STOP process's working directory. Give every export its
  # own ACL-inheriting private directory; never search or move a global file.
  $pktExportDir=Join-Path $pktDir ('export-'+[guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($pktExportDir)|Out-Null
  Push-Location -LiteralPath $pktExportDir
  try{
    & $pktExe stop *> $null
    if($LASTEXITCODE -ne 0){throw 'pktmon_stop_failed'}
  }finally{Pop-Location}
  $pktDefaultExport=Join-Path $pktExportDir 'PktMon.etl'
  if(-not(Test-Path -LiteralPath $pktSavedFile) -and (Test-Path -LiteralPath $pktDefaultExport)){
    [IO.File]::Move($pktDefaultExport,$pktSavedFile)
  }
  if(-not @(Get-ChildItem -LiteralPath $pktExportDir -Force).Count){Remove-Item -LiteralPath $pktExportDir -Force}
  if(-not(Test-Path -LiteralPath $pktSavedFile)){throw 'pktmon_export_missing'}
  return $pktSavedFile
}
try{
  $pktOwner=Read-PktOwner
  $pktActive=Get-PktActive
  if($Action -eq 'Status'){@{state=if($pktActive){if(Test-PktOwned $pktOwner){'recording'}else{'in_use_by_other'}}else{'stopped'};payload=$false}|ConvertTo-Json -Compress;exit 0}
  if($pktActive -and -not(Test-PktOwned $pktOwner)){@{state='in_use_by_other';payload=$false}|ConvertTo-Json -Compress;exit 0}
  if($Action -eq 'Stop' -or $Action -eq 'Snapshot'){
    if(-not $pktOwner){@{state='stopped'}|ConvertTo-Json -Compress;exit 0}
    $pktSaved=$null
    if($pktActive){
      $pktSaved=Stop-PktOwned $pktOwner
    }
    $pktTo=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if($Action -eq 'Snapshot'){
      $pktOldFrom=$pktOwner.from
      $pktOwner.file=Join-Path $pktDir (([guid]::NewGuid().ToString('N'))+'.etl')
      Start-PktOwned $pktOwner
      @{state='recording';file=$pktSaved;from=$pktOldFrom;to=$pktTo;payload=$false}|ConvertTo-Json -Compress;exit 0
    }
    # A normal stop discards background metadata. Retention is only for incidents.
    if($pktSaved -and (Split-Path -Parent $pktSaved) -eq [IO.Path]::GetFullPath($pktDir) -and $pktSaved.EndsWith('.etl')){Remove-Item -LiteralPath $pktSaved -Force}
    foreach($pktFilter in $pktOwner.filters){if($pktFilter -match '^TrafficWatch-[a-f0-9]{8}-\d+$'){& $pktExe filter remove $pktFilter *> $null}}
    Remove-Item -LiteralPath $pktStatePath -Force
    @{state='stopped'}|ConvertTo-Json -Compress;exit 0
  }
  if($pktActive){@{state='recording';payload=$false}|ConvertTo-Json -Compress;exit 0}
  $pktFilters=(& $pktExe filter list 2>$null|Out-String)
  if($LASTEXITCODE -ne 0){throw 'pktmon_filter_status_failed'}
  # Never broaden capture by combining with pre-existing OR filters.
  if($pktFilters -match '(?m)^\s*\d+'){ @{state='foreign_filters_present';payload=$false}|ConvertTo-Json -Compress;exit 0 }
  [IO.Directory]::CreateDirectory($pktDir)|Out-Null
  $pktAcl=[Security.AccessControl.DirectorySecurity]::new();$pktAcl.SetAccessRuleProtection($true,$false)
  foreach($pktSid in @('S-1-5-18','S-1-5-32-544',$pktSettings.OwnerSid)){
    $pktIdentity=[Security.Principal.SecurityIdentifier]::new($pktSid)
    $pktRule=[Security.AccessControl.FileSystemAccessRule]::new($pktIdentity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$pktAcl.AddAccessRule($pktRule)
  }
  Set-Acl -LiteralPath $pktDir -AclObject $pktAcl
  $pktInput=Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8|ConvertFrom-Json
  $pktIps=@($pktInput.ips|Select-Object -Unique)
  if($pktIps.Count -lt 1 -or $pktIps.Count -gt 24){throw 'invalid_pktmon_targets'}
  $pktNonce=[guid]::NewGuid().ToString('N').Substring(0,8);$pktNames=@();$pktCounter=0
  foreach($pktIp in $pktIps){
    $pktParsed=$null;if(-not[Net.IPAddress]::TryParse($pktIp,[ref]$pktParsed) -or $pktIp -match '^(127\.|0\.|198\.1[89]\.)'){throw 'invalid_pktmon_target'}
    $pktName='TrafficWatch-'+$pktNonce+'-'+$pktCounter;$pktCounter++
    & $pktExe filter add $pktName -i $pktIp -t TCP -p 443 *> $null
    if($LASTEXITCODE -ne 0){throw 'pktmon_filter_failed'}
    $pktNames+=,$pktName
  }
  $pktOwner=[pscustomobject]@{file=(Join-Path $pktDir (([guid]::NewGuid().ToString('N'))+'.etl'));filters=$pktNames;from=0}
  Start-PktOwned $pktOwner
  @{state='recording';payload=$false}|ConvertTo-Json -Compress
}catch{[Console]::WriteLine((@{state='unavailable';code=if($_.Exception.Message -match '^[a-z_]+$'){$_.Exception.Message}else{'pktmon_operation_failed'}}|ConvertTo-Json -Compress));exit 1}
