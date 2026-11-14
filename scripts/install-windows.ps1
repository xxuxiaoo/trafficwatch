param([string]$DataRoot,[string]$ClashConfigPath,[switch]$NoStart)
$ErrorActionPreference='Stop'
$packageRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$installRoot=[IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'TrafficWatch'))
if(-not $DataRoot){$DataRoot=Join-Path $env:ProgramData 'TrafficWatch'}
$DataRoot=[IO.Path]::GetFullPath($DataRoot)
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this fresh installer from an administrator PowerShell.'}
$taskName='TrafficWatch - Open-source Netwatch'
$trayTask='TrafficWatch - Tray'
if((Test-Path -LiteralPath $installRoot) -or (Get-ScheduledTask -TaskName $taskName,$trayTask -ErrorAction SilentlyContinue)){throw 'An installation or TrafficWatch task already exists. This installer only supports fresh installation and will not overwrite it.'}
if($DataRoot -eq $installRoot -or $DataRoot.StartsWith($installRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Keep the observation directory separate from the executable directory.'}
if((Test-Path -LiteralPath $DataRoot) -and @(Get-ChildItem -LiteralPath $DataRoot -Force).Count -gt 0){throw 'Choose a new empty data directory. Existing histories are not modified by this fresh installer.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$ownerProfile=[Environment]::GetFolderPath('UserProfile')
if(-not $ClashConfigPath){$ClashConfigPath=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml'}
$ClashConfigPath=[IO.Path]::GetFullPath($ClashConfigPath)
if(-not(Test-Path -LiteralPath $ClashConfigPath -PathType Leaf)){throw 'Clash configuration not found. Start Clash Verge once or pass -ClashConfigPath with a local compatible controller configuration.'}
$manifestPath=Join-Path $packageRoot 'release-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
$packageVersion=(Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw|ConvertFrom-Json).version
if($manifest.version -ne $packageVersion -or $packageVersion -notmatch '^\d+\.\d+\.\d+$'){throw 'Build the reviewed TrafficWatch Windows package first.'}
foreach($entry in $manifest.files){
  $source=[IO.Path]::GetFullPath((Join-Path $packageRoot $entry.path))
  if(-not $source.StartsWith($packageRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Package manifest contains a path outside the package.'}
  if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('Package integrity check failed: '+$entry.path)}
}
foreach($port in @(43128,43130,43131)){
  $listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if($listener){throw ('Port '+$port+' is already in use. No running service has been stopped.')}
}
Write-Host ('Program: '+$installRoot)
Write-Host ('History: '+$DataRoot)
Write-Host ('Owner: '+$identity.Name)
$createdTasks=@()
try{
  [IO.Directory]::CreateDirectory($installRoot)|Out-Null
  foreach($name in @('src','public','docs','desktop','native','runtime','scripts','LICENSE','NOTICE.md','THIRD_PARTY_NOTICES.md','README.md','README.en.md','README.zh-CN.md','SECURITY.md','CHANGELOG.md','package.json','config.example.json','TrafficWatch-Supervisor.ps1','TrafficWatch-Tray.exe','TrafficWatch-Tray.exe.config','TrafficWatch-Control.exe','TrafficWatch-Control.exe.config','Codex-Netwatch.exe','Codex-Netwatch.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WEBVIEW2-LICENSE.txt','WEBVIEW2-NOTICE.txt','webview2-manifest.json','release-manifest.json')){
    Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination $installRoot -Recurse
  }
  [IO.Directory]::CreateDirectory($DataRoot)|Out-Null
  $acl=Get-Acl -LiteralPath $DataRoot
  $ownerRule=[Security.AccessControl.FileSystemAccessRule]::new($identity.User,[Security.AccessControl.FileSystemRights]::Modify,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($ownerRule);Set-Acl -LiteralPath $DataRoot -AclObject $acl
  $config=Get-Content -LiteralPath (Join-Path $installRoot 'config.example.json') -Raw|ConvertFrom-Json
  $config.codexHome=Join-Path $ownerProfile '.codex'
  [IO.File]::WriteAllText((Join-Path $installRoot 'config.local.json'),($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $settings=@{OwnerUser=$identity.Name;OwnerSid=$identity.User.Value;OwnerProfile=$ownerProfile;DataRoot=$DataRoot;ClashConfigPath=$ClashConfigPath}
  [IO.File]::WriteAllText((Join-Path $installRoot 'suite-settings.json'),($settings|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action=New-ScheduledTaskAction -Execute $shell -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $installRoot 'TrafficWatch-Supervisor.ps1')+'" -Action Run') -WorkingDirectory $installRoot
  $trigger=New-ScheduledTaskTrigger -AtStartup
  $systemPrincipal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $taskSettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $systemPrincipal -Settings $taskSettings -Description 'TrafficWatch: independent ETW and Mihomo histories, system boot capture, unlimited retention.'|Out-Null
  $createdTasks+=,$taskName
  $trayAction=New-ScheduledTaskAction -Execute (Join-Path $installRoot 'TrafficWatch-Tray.exe') -Argument '--attach-suite --no-browser' -WorkingDirectory $installRoot
  $trayTrigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $trayPrincipal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
  $traySettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $trayTask -Action $trayAction -Trigger $trayTrigger -Principal $trayPrincipal -Settings $traySettings -Description 'TrafficWatch user-session tray; exiting the tray keeps collectors running.'|Out-Null
  $createdTasks+=,$trayTask
  $desktop=[Environment]::GetFolderPath('DesktopDirectory')
  $shortcutFile=Join-Path $desktop 'TrafficWatch.lnk'
  if(-not(Test-Path -LiteralPath $shortcutFile)){
    $ws=New-Object -ComObject WScript.Shell
    $shortcut=$ws.CreateShortcut($shortcutFile)
    $shortcut.TargetPath=Join-Path $installRoot 'TrafficWatch-Control.exe'
    $shortcut.WorkingDirectory=$installRoot
    $shortcut.Description='TrafficWatch traffic overview and collection controls'
    $shortcut.Save()
  }
}catch{
  foreach($name in $createdTasks){Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue}
  # Retain the partial installation for inspection; never delete observations.
  throw
}
if(-not $NoStart){
  Start-ScheduledTask -TaskName $taskName
  Start-ScheduledTask -TaskName $trayTask
}
Write-Host 'Installation completed. Open the TrafficWatch desktop shortcut to view or control the suite.'
