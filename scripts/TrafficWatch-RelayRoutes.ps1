param([ValidateSet('Apply','Rollback','Status')][string]$Action='Status',[string]$InputFile)
$ErrorActionPreference='Stop'
$relayRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$relaySettings=Get-Content -LiteralPath (Join-Path $relayRoot 'suite-settings.json') -Raw -Encoding UTF8|ConvertFrom-Json
$relayDir=Join-Path ([IO.Path]::GetFullPath($relaySettings.DataRoot)) 'relay-bypass'
[IO.Directory]::CreateDirectory($relayDir)|Out-Null
$relayStateFile=Join-Path $relayDir 'routes.json'
$relayHostsFile=Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$relayBegin='# BEGIN TrafficWatch relay physical bypass'
$relayEnd='# END TrafficWatch relay physical bypass'
$relayState=if(Test-Path -LiteralPath $relayStateFile){Get-Content -LiteralPath $relayStateFile -Raw|ConvertFrom-Json}else{[pscustomobject]@{routes=@();block='';at=0}}
$relayEnvFile=Join-Path $relayDir 'no-proxy-ownership.json'
$relayEnvPath='Registry::HKEY_USERS\'+$relaySettings.OwnerSid+'\Environment'
function Set-RelayNoProxy([bool]$Rollback){
  if(-not(Test-Path -LiteralPath $relayEnvPath)){return 'owner_not_logged_in'}
  $relayEnvItem=Get-ItemProperty -LiteralPath $relayEnvPath -Name 'NO_PROXY' -ErrorAction SilentlyContinue
  $relayEnvCurrent=if($relayEnvItem){[string]$relayEnvItem.NO_PROXY}else{''}
  $relayEnvParts=@($relayEnvCurrent.Split(',')|ForEach-Object {$_.Trim()}|Where-Object {$_})
  $relayEnvOwned=if(Test-Path -LiteralPath $relayEnvFile){Get-Content -LiteralPath $relayEnvFile -Raw|ConvertFrom-Json}else{[pscustomobject]@{added=@();existed=[bool]$relayEnvItem}}
  if($Rollback){$relayEnvParts=@($relayEnvParts|Where-Object {$relayEnvOwned.added -notcontains $_});$relayEnvOwned.added=@()}
  else{foreach($relayEnvHost in @($relaySettings.RelayHosts)){if($relayEnvParts -notcontains $relayEnvHost){$relayEnvParts+=,$relayEnvHost;$relayEnvOwned.added=@($relayEnvOwned.added)+@($relayEnvHost)}}}
  [IO.File]::WriteAllText($relayEnvFile,($relayEnvOwned|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
  $relayEnvNext=$relayEnvParts -join ','
  if($relayEnvNext -ne $relayEnvCurrent){
    if($Rollback -and -not $relayEnvNext -and -not $relayEnvOwned.existed){Remove-ItemProperty -LiteralPath $relayEnvPath -Name 'NO_PROXY' -ErrorAction SilentlyContinue}
    else{Set-ItemProperty -LiteralPath $relayEnvPath -Name 'NO_PROXY' -Value $relayEnvNext -Type String}
  }
  return 'domain_exceptions_set'
}
function Save-RelayState { [IO.File]::WriteAllText($relayStateFile,($relayState|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false)) }
function Test-RelayIp([string]$value){$relayIp=$null;return [Net.IPAddress]::TryParse($value,[ref]$relayIp) -and $relayIp.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $value -notmatch '^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|198\.1[89]\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)'}
try{
  if($Action -eq 'Status'){@{ok=$true;at=$relayState.at;routes=@($relayState.routes).Count}|ConvertTo-Json -Compress;exit 0}
  $relayPrincipal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $relayPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'administrator_required'}
  $relayHosts=[IO.File]::ReadAllText($relayHostsFile)
  $relayPattern='(?ms)^'+[regex]::Escape($relayBegin)+'\r?\n.*?^'+[regex]::Escape($relayEnd)+'(?:\r?\n|$)'
  $relayMatch=[regex]::Match($relayHosts,$relayPattern)
  if($relayMatch.Success -and $relayMatch.Value.TrimEnd() -ne ([string]$relayState.block).TrimEnd()){throw 'managed_hosts_modified'}
  $relayClean=[regex]::Replace($relayHosts,$relayPattern,'')
  if($Action -eq 'Rollback'){
    $relayEnvironment=Set-RelayNoProxy $true
    if($relayMatch.Success){[IO.File]::WriteAllText($relayHostsFile,$relayClean,[Text.UTF8Encoding]::new($false))}
    foreach($relayRoute in @($relayState.routes)){
      if($relayRoute.owned -and (Test-RelayIp $relayRoute.ip)){
        Get-NetRoute -DestinationPrefix ($relayRoute.ip+'/32') -InterfaceIndex $relayRoute.index -NextHop $relayRoute.gateway -PolicyStore ActiveStore -ErrorAction SilentlyContinue|Remove-NetRoute -Confirm:$false -ErrorAction Stop
      }
    }
    $relayState.routes=@();$relayState.block='';$relayState.at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();Save-RelayState
    Clear-DnsClientCache
    @{ok=$true;state='rolled_back';environment=$relayEnvironment}|ConvertTo-Json -Compress;exit 0
  }
  $relayInput=Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8|ConvertFrom-Json
  $relayAdapter=$relayInput.adapter
  $relayActual=Get-NetIPConfiguration -InterfaceIndex ([int]$relayAdapter.index)
  if($relayActual.IPv4Address.IPAddress -notcontains $relayAdapter.address -or $relayActual.IPv4DefaultGateway.NextHop -notcontains $relayAdapter.gateway -or $relayActual.InterfaceAlias -match 'Meta|Mihomo|Clash|TUN'){throw 'physical_adapter_changed'}
  $relayNow=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $relayAllowed=@($relaySettings.RelayHosts)
  if($relayAllowed.Count -eq 0 -or @($relayInput.targets).Count -gt 32){throw 'invalid_relay_targets'}
  $relayLines=@();$relayDesired=@()
  foreach($relayTarget in $relayInput.targets){
    if($relayAllowed -notcontains [string]$relayTarget.host){throw 'invalid_relay_host'}
    if($relayClean -match ('(?im)^\s*[^#\r\n]+\s'+[regex]::Escape($relayTarget.host)+'(?:\s|$)')){throw 'existing_hosts_conflict'}
    foreach($relayIp in @($relayTarget.ips)){
      if(-not(Test-RelayIp $relayIp)){throw 'invalid_relay_ip'}
      $relayLines+=([string]$relayIp+' '+$relayTarget.host)
      if($relayDesired -notcontains $relayIp){$relayDesired+=,$relayIp}
      $relayKnown=@($relayState.routes|Where-Object {$_.ip -eq $relayIp -and $_.index -eq $relayAdapter.index -and $_.gateway -eq $relayAdapter.gateway})|Select-Object -First 1
      $relayExisting=Get-NetRoute -DestinationPrefix ($relayIp+'/32') -InterfaceIndex $relayAdapter.index -NextHop $relayAdapter.gateway -PolicyStore ActiveStore -ErrorAction SilentlyContinue
      if(-not $relayKnown){
        $relayKnown=[pscustomobject]@{ip=$relayIp;index=[int]$relayAdapter.index;gateway=[string]$relayAdapter.gateway;owned=(-not [bool]$relayExisting);lastWanted=$relayNow}
        $relayState.routes=@($relayState.routes)+@($relayKnown);Save-RelayState
      }
      $relayKnown.lastWanted=$relayNow
      if(-not $relayExisting){New-NetRoute -DestinationPrefix ($relayIp+'/32') -InterfaceIndex $relayAdapter.index -NextHop $relayAdapter.gateway -RouteMetric 1 -PolicyStore ActiveStore|Out-Null}
    }
  }
  if($relayLines.Count -eq 0){throw 'empty_relay_targets'}
  $relayBlock=$relayBegin+"`r`n"+($relayLines -join "`r`n")+"`r`n"+$relayEnd+"`r`n"
  # Journal the exact owned text before publishing it. Concurrent user edits are preserved.
  $relayState.block=$relayBlock;Save-RelayState
  if($relayMatch.Value -ne $relayBlock){[IO.File]::WriteAllText($relayHostsFile,($relayClean.TrimEnd()+"`r`n"+$relayBlock),[Text.UTF8Encoding]::new($false));Clear-DnsClientCache}
  $relayKeep=@()
  foreach($relayRoute in @($relayState.routes)){
    $relayExpired=$relayNow-[long]$relayRoute.lastWanted -gt 900000
    if($relayExpired -and $relayRoute.owned){Get-NetRoute -DestinationPrefix ($relayRoute.ip+'/32') -InterfaceIndex $relayRoute.index -NextHop $relayRoute.gateway -PolicyStore ActiveStore -ErrorAction SilentlyContinue|Remove-NetRoute -Confirm:$false}
    else{$relayKeep+=,$relayRoute}
  }
  $relayState.routes=$relayKeep;$relayState.at=$relayNow;Save-RelayState
  $relayEnvironment=Set-RelayNoProxy $false
  $relayChecks=@($relayDesired|ForEach-Object{$relayFound=@(Find-NetRoute -RemoteIPAddress $_);$relaySource=$relayFound|Where-Object {$_.IPAddress}|Select-Object -First 1;[pscustomobject]@{ip=$_;interfaceIndex=[int]$relaySource.InterfaceIndex;source=[string]$relaySource.IPAddress;physical=($relaySource.InterfaceIndex -eq $relayAdapter.index -and $relaySource.IPAddress -eq $relayAdapter.address)}})
  @{ok=(@($relayChecks|Where-Object {-not $_.physical}).Count -eq 0);state='applied';at=$relayNow;checks=$relayChecks;environment=$relayEnvironment}|ConvertTo-Json -Depth 6 -Compress
}catch{[Console]::WriteLine((@{ok=$false;code=if($_.Exception.Message -match '^[a-z_]+$'){$_.Exception.Message}else{'relay_routes_failed'}}|ConvertTo-Json -Compress));exit 1}
