function Copy-TrafficWatchUpgradeStage([string]$PackageRoot,[string]$InstalledRoot,[string]$StageRoot) {
    $manifest=Get-Content -LiteralPath (Join-Path $PackageRoot 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Test-Path -LiteralPath $StageRoot) { throw 'The program staging directory already exists.' }
    [IO.Directory]::CreateDirectory($StageRoot) | Out-Null
    foreach ($entry in $manifest.files) {
        $relative=[string]$entry.path
        $source=[IO.Path]::GetFullPath((Join-Path $PackageRoot $relative))
        $destination=[IO.Path]::GetFullPath((Join-Path $StageRoot $relative))
        if (-not $source.StartsWith($PackageRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or
            -not $destination.StartsWith($StageRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe manifest path.' }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
            throw "Staged file failed hash verification: $relative"
        }
    }
    Copy-Item -LiteralPath (Join-Path $PackageRoot 'release-manifest.json') -Destination $StageRoot
    foreach ($name in @('suite-settings.json','config.local.json')) {
        $file=Join-Path $InstalledRoot $name
        if (Test-Path -LiteralPath $file -PathType Leaf) { Copy-Item -LiteralPath $file -Destination $StageRoot }
    }
}
