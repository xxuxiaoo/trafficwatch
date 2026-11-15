param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$diagProject=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$diagCache=Join-Path $diagProject '.build\dependencies'
$Destination=[IO.Path]::GetFullPath($Destination)
[IO.Directory]::CreateDirectory($Destination)|Out-Null
[IO.Directory]::CreateDirectory($diagCache)|Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$diagPackages=@(
  @{name='traceevent';version='2.0.77';package='microsoft.diagnostics.tracing.traceevent';sha='0055b65a090d4e7b179bd32fc9365bdcc1f70f7f3d081685f93b2067436c0850';files=@{
    'lib/net45/Microsoft.Diagnostics.Tracing.TraceEvent.dll'='Microsoft.Diagnostics.Tracing.TraceEvent.dll';
    'lib/net45/Microsoft.Diagnostics.FastSerialization.dll'='Microsoft.Diagnostics.FastSerialization.dll';
    'lib/net45/Dia2Lib.dll'='Dia2Lib.dll';'lib/net45/TraceReloggerLib.dll'='TraceReloggerLib.dll';'lib/net45/OSExtensions.dll'='OSExtensions.dll';
    'build/native/amd64/KernelTraceControl.dll'='amd64\KernelTraceControl.dll'
  }},
  @{name='unsafe';version='4.5.2';package='system.runtime.compilerservices.unsafe';sha='f1e5175c658ed8b2fbb804cc6727b6882a503844e7da309c8d4846e9ca11e4ef';files=@{
    'lib/netstandard2.0/System.Runtime.CompilerServices.Unsafe.dll'='System.Runtime.CompilerServices.Unsafe.dll';
    'LICENSE.TXT'='TRACE-UNSAFE-LICENSE.txt';'THIRD-PARTY-NOTICES.TXT'='TRACE-UNSAFE-NOTICES.txt'
  }}
)
foreach($diagPackage in $diagPackages){
  $diagArchive=Join-Path $diagCache ($diagPackage.name+'-'+$diagPackage.version+'.nupkg')
  if(-not(Test-Path -LiteralPath $diagArchive)){
    $diagUrl='https://api.nuget.org/v3-flatcontainer/'+$diagPackage.package+'/'+$diagPackage.version+'/'+$diagPackage.package+'.'+$diagPackage.version+'.nupkg'
    $diagPending=$diagArchive+'.'+[Guid]::NewGuid().ToString('N')+'.pending'
    try{
      & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 --retry 2 --retry-max-time 240 --output $diagPending $diagUrl
      if($LASTEXITCODE -ne 0){throw ('Diagnostic dependency download failed: '+$diagPackage.package)}
      if((Get-FileHash -LiteralPath $diagPending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $diagPackage.sha){throw 'Downloaded diagnostic dependency hash mismatch.'}
      [IO.File]::Move($diagPending,$diagArchive)
    }finally{if(Test-Path -LiteralPath $diagPending){Remove-Item -LiteralPath $diagPending -Force}}
  }
  if((Get-FileHash -LiteralPath $diagArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $diagPackage.sha){throw 'Diagnostic dependency hash mismatch.'}
  $diagZip=[IO.Compression.ZipFile]::OpenRead($diagArchive)
  try{foreach($diagName in $diagPackage.files.Keys){$diagEntry=$diagZip.GetEntry($diagName);if(-not $diagEntry){throw 'Diagnostic package entry missing.'};$diagTarget=Join-Path $Destination $diagPackage.files[$diagName];[IO.Directory]::CreateDirectory((Split-Path -Parent $diagTarget))|Out-Null;[IO.Compression.ZipFileExtensions]::ExtractToFile($diagEntry,$diagTarget,$true)}}finally{$diagZip.Dispose()}
}
$diagCompiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$diagCommon=@('/nologo','/optimize+','/target:exe','/platform:x64','/codepage:65001','/reference:System.dll','/reference:System.Core.dll','/reference:System.Web.Extensions.dll')
& $diagCompiler @diagCommon ('/reference:'+(Join-Path $Destination 'Microsoft.Diagnostics.Tracing.TraceEvent.dll')) ('/out:'+(Join-Path $Destination 'TrafficWatch-AiTrace.exe')) (Join-Path $diagProject 'native\AiNetworkTrace.cs')
if($LASTEXITCODE -ne 0){throw 'TraceEvent diagnostic helper compilation failed.'}
& $diagCompiler @diagCommon ('/out:'+(Join-Path $Destination 'TrafficWatch-RelayProbe.exe')) (Join-Path $diagProject 'native\RelayProbe.cs')
if($LASTEXITCODE -ne 0){throw 'Physical relay probe compilation failed.'}
$diagConfig='<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>'
foreach($diagName in @('TrafficWatch-AiTrace.exe','TrafficWatch-RelayProbe.exe')){[IO.File]::WriteAllText((Join-Path $Destination ($diagName+'.config')),$diagConfig,[Text.UTF8Encoding]::new($false))}
@{traceEvent='2.0.77';framework='net45 on .NET Framework 4.8';reason='Stable framework-compatible ETW decoder; no .NET SDK/runtime installation required';packages=@($diagPackages|ForEach-Object {@{id=$_.package;version=$_.version;sha256=$_.sha;license='MIT'}})}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $Destination 'diagnostics-dependencies.json') -Encoding UTF8
