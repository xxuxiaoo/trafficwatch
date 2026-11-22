function Read-UpgradeHealth([int]$Port,[int]$TimeoutMs) {
    try {
        $request=[Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/health")
        $request.Proxy=$null
        $request.KeepAlive=$false
        $request.AllowAutoRedirect=$false
        $request.Timeout=$TimeoutMs
        $request.ReadWriteTimeout=$TimeoutMs
        $response=$request.GetResponse()
        try {
            if ([int]$response.StatusCode -ne 200) { throw ('HTTP '+[int]$response.StatusCode) }
            $reader=[IO.StreamReader]::new($response.GetResponseStream())
            try { return @{Health=($reader.ReadToEnd() | ConvertFrom-Json)} }
            finally { $reader.Dispose() }
        } finally { $response.Dispose() }
    } catch {
        $errorCause=$_.Exception.GetBaseException()
        $web=$_.Exception
        while ($web -and $web -isnot [Net.WebException]) { $web=$web.InnerException }
        $detail=if ($web -and $web.Response) {
            try { 'HTTP '+[int]$web.Response.StatusCode }
            finally { $web.Response.Dispose() }
        } elseif ($web) { [string]$web.Status + ' '+ $web.Message }
        else { $errorCause.Message }
        return @{Error=$detail}
    }
}

function Wait-TrafficWatchHealth {
    param([object[]]$Checks,[string]$Version,[int]$DeadlineMs=90000,[int]$ProbeMs=2000)
    if (-not $Checks.Count) { return }
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $last=@{}
    do {
        $remaining=@(foreach ($check in $Checks) {
            $probe=Read-UpgradeHealth $check.Port ([Math]::Max(1,[Math]::Min($ProbeMs,$DeadlineMs-$timer.ElapsedMilliseconds)))
            $health=$probe.Health
            $ready=$false
            if ($probe.Error) { $status=$probe.Error }
            elseif ($health.app -ne $check.App -or $health.version -ne $Version) {
                $status="unexpected app=$($health.app) version=$($health.version), expected $($check.App) $Version"
            } elseif ($check.Collector -and $health.startupStage -ne 'ready') {
                $status="startup=$($health.startupStage) state=$($health.state) pid=$($health.collectorPid)"
            } elseif ($check.Storage -and $health.storage -ne $check.Storage) {
                $status="storage=$($health.storage), expected $($check.Storage)"
            } else {
                $ready=$true
                $status="ready (state=$($health.state))"
            }
            if ($last[$check.Port] -ne $status) {
                Write-Host "TrafficWatch health $($check.Port) +$($timer.ElapsedMilliseconds)ms $status"
                $last[$check.Port]=$status
            }
            if (-not $ready) { "$($check.Port) $status" }
        })
        if (-not $remaining.Count) { return }
        if ($timer.ElapsedMilliseconds -lt $DeadlineMs) { Start-Sleep -Milliseconds 350 }
    } while ($timer.ElapsedMilliseconds -lt $DeadlineMs)
    throw ("New version health checks failed after $($timer.ElapsedMilliseconds)ms: "+($remaining -join ', '))
}
