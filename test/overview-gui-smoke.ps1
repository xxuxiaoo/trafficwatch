param([string]$PortableRoot,[string]$Screenshot,[ValidateSet('en','zh-CN')][string]$Language='zh-CN',[switch]$KeepArtifacts)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if(-not $PortableRoot){$PortableRoot=Join-Path $projectRoot '.build\windows-0.10.13\TrafficWatch'}
$PortableRoot=[IO.Path]::GetFullPath($PortableRoot)
$buildRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot '.build'))
if(-not $Screenshot){$Screenshot=Join-Path $buildRoot 'release-0.10.13\overview-gui.png'}
if(-not [IO.Path]::IsPathRooted($Screenshot)){$Screenshot=Join-Path $projectRoot $Screenshot}
$Screenshot=[IO.Path]::GetFullPath($Screenshot)
if(-not $Screenshot.StartsWith($buildRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'The screenshot output must stay inside this checkout .build directory.'}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Screenshot))|Out-Null
$tempRoot=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('trafficwatch-overview-gui-'+[Guid]::NewGuid().ToString('N'))))
[IO.Directory]::CreateDirectory($tempRoot)|Out-Null
$node=Join-Path $PortableRoot 'runtime\node.exe'
$report=Join-Path $tempRoot 'report.json'
$probe=Join-Path $tempRoot 'OverviewSmoke.exe'
$server=$null;$probeProcess=$null;$ports=@()
$envNames=@('TRAFFICWATCH_DATA_ROOT','TRAFFICWATCH_CACHE_ROOT','TRAFFICWATCH_OVERVIEW_PORT','TRAFFICWATCH_MACHINE_PORT','TRAFFICWATCH_CLASH_PORT')
$previous=@{};foreach($name in $envNames){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}

function Get-FreePort {
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop();return [int]$port
}

try{
  foreach($required in @($node,(Join-Path $PortableRoot 'Microsoft.Web.WebView2.Core.dll'),(Join-Path $PortableRoot 'Microsoft.Web.WebView2.WinForms.dll'),(Join-Path $PortableRoot 'WebView2Loader.dll'))){if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw ('Missing GUI smoke dependency: '+[IO.Path]::GetFileName($required))}}
  foreach($dependency in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')){Copy-Item -LiteralPath (Join-Path $PortableRoot $dependency) -Destination $tempRoot}
  while($ports.Count -lt 3){$candidate=Get-FreePort;if($ports -notcontains $candidate){$ports+=,$candidate}}
  $dataRoot=Join-Path $tempRoot 'data'
  $env:TRAFFICWATCH_DATA_ROOT=$dataRoot
  $env:TRAFFICWATCH_CACHE_ROOT=Join-Path $tempRoot 'cache'
  $env:TRAFFICWATCH_OVERVIEW_PORT=[string]$ports[0]
  $env:TRAFFICWATCH_MACHINE_PORT=[string]$ports[1]
  $env:TRAFFICWATCH_CLASH_PORT=[string]$ports[2]
  & $node --disable-warning=ExperimentalWarning (Join-Path $projectRoot 'test\overview-gui-fixture.mjs') $dataRoot
  if($LASTEXITCODE -ne 0){throw 'Synthetic overview data could not be created.'}

  $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $common=@('/nologo','/target:winexe','/platform:x64','/codepage:65001','/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',('/reference:'+(Join-Path $PortableRoot 'Microsoft.Web.WebView2.Core.dll')),('/reference:'+(Join-Path $PortableRoot 'Microsoft.Web.WebView2.WinForms.dll')))
  & $compiler @common ('/out:'+$probe) (Join-Path $projectRoot 'test\OverviewSmoke.cs')
  if($LASTEXITCODE -ne 0){throw 'Synthetic WebView2 smoke compilation failed.'}

  $serverScript=Join-Path $projectRoot 'test\overview-gui-server.mjs'
  $serverArgs='--disable-warning=ExperimentalWarning "'+$serverScript+'" "'+$projectRoot+'" "'+$dataRoot+'" '+$ports[0]+' '+$ports[1]+' '+$ports[2]
  $server=Start-Process -FilePath $node -ArgumentList $serverArgs -WorkingDirectory $PortableRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $tempRoot 'server.out.log') -RedirectStandardError (Join-Path $tempRoot 'server.err.log')
  $baseUrl='http://127.0.0.1:'+$ports[0]
  $ready=$false
  for($attempt=0;$attempt -lt 60;$attempt++){
    try{$health=Invoke-RestMethod -Uri ($baseUrl+'/api/health') -TimeoutSec 1;if($health.app -eq 'trafficwatch-overview'){$ready=$true;break}}catch{}
    Start-Sleep -Milliseconds 150
  }
  if(-not $ready){throw 'Synthetic overview server did not become healthy.'}

  $profile=Join-Path $tempRoot 'webview-profile'
  $probeArguments=@('"'+$baseUrl+'"','"'+$profile+'"','"'+$report+'"','"'+$Screenshot+'"','"'+$Language+'"')
  $probeProcess=Start-Process -FilePath $probe -ArgumentList $probeArguments -WorkingDirectory $tempRoot -PassThru
  if(-not $probeProcess.WaitForExit(60000)){$probeProcess.Kill();throw 'Synthetic overview GUI smoke timed out.'}
  if($probeProcess.ExitCode -ne 0){$message=if(Test-Path -LiteralPath $report){Get-Content -LiteralPath $report -Raw}else{'no report'};throw $message}
  Get-Content -LiteralPath $report -Raw
  Write-Host ('Overview screenshot: '+$Screenshot)
}finally{
  if($server -and -not $server.HasExited -and $ports.Count -eq 3){
    try{Invoke-RestMethod -Uri ('http://127.0.0.1:'+$ports[0]+'/api/stop') -Method Post -Headers @{'x-codex-flow'='1'} -ContentType 'application/json' -Body '{}' -TimeoutSec 2|Out-Null}catch{}
    if(-not $server.WaitForExit(5000)){$server.Kill();$server.WaitForExit(5000)|Out-Null}
  }
  foreach($name in $envNames){if($null -eq $previous[$name]){[Environment]::SetEnvironmentVariable($name,$null,'Process')}else{[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}}
  $resolvedTemp=[IO.Path]::GetFullPath($tempRoot)
  $tempBase=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if($KeepArtifacts){Write-Host ('GUI smoke artifacts: '+$resolvedTemp)}
  elseif($resolvedTemp.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTemp).StartsWith('trafficwatch-overview-gui-')){Remove-Item -LiteralPath $resolvedTemp -Recurse -Force}
}
