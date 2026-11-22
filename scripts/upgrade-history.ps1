function Get-PlainHistoryFiles([string]$HistoryDirectory) {
    $layout=Get-Item -LiteralPath $HistoryDirectory -Force
    if (-not $layout.PSIsContainer -or ($layout.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The active history-v2 path must be a regular directory.'
    }
    $manifestFile=Get-Item -LiteralPath (Join-Path $HistoryDirectory 'migration.json') -Force
    if ($manifestFile.PSIsContainer -or ($manifestFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The history-v2 migration manifest must be a regular file.'
    }
    $manifest=Get-Content -LiteralPath $manifestFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.version -ne 1 -or $manifest.verified -isnot [bool] -or -not $manifest.verified) {
        throw 'The active history-v2 migration has not been verified.'
    }
    foreach ($lane in @('windows','clash','diagnostics')) {
        $laneManifest=$manifest.lanes.$lane
        if ($laneManifest.outputSHA256 -notmatch '^[0-9a-f]{64}$') { throw "Missing verified history entry for $lane." }
        $dir=Get-Item -LiteralPath (Join-Path $HistoryDirectory $lane) -Force
        if (-not $dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "The active $lane history path must be a regular directory."
        }
        $name=if ($lane -eq 'diagnostics') { 'history.sqlite' } else { 'monitor.sqlite' }
        $file=Get-Item -LiteralPath (Join-Path $dir.FullName $name) -Force
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -lt 100) {
            throw "The active $lane history must be a regular SQLite file."
        }
        # The installed collectors can change both the main file and its WAL.
        # The manifest establishes conversion provenance, not a live-file hash.
        $header=[byte[]]::new(16)
        $share=[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,$share)
        try {
            if ($stream.Read($header,0,$header.Length) -ne $header.Length -or
                [Text.Encoding]::ASCII.GetString($header) -cne ('SQLite format 3'+[char]0)) {
                throw "The active $lane history does not have a plaintext SQLite header."
            }
        } finally { $stream.Dispose() }
        $lane
    }
}

function Get-UpgradeHistoryPlan([string]$DataRoot,[version]$InstalledVersion) {
    $active=Join-Path $DataRoot 'history-v2'
    if (Test-Path -LiteralPath $active) {
        try { $lanes=@(Get-PlainHistoryFiles $active) }
        catch { throw ('Cannot reuse history-v2. No history was changed. '+$_.Exception.Message) }
        return @{Mode='verified-plain'; Lanes=$lanes}
    }
    if (Test-Path -LiteralPath (Join-Path $DataRoot 'vault\vault.json') -PathType Leaf) {
        if ($InstalledVersion -ge [version]'0.10.16') {
            throw 'The installed plaintext version has retained legacy files but its active history-v2 is missing. No history was changed.'
        }
        return @{Mode='legacy-encrypted'; Lanes=@()}
    }
    return @{Mode='native-plain'; Lanes=@()}
}
