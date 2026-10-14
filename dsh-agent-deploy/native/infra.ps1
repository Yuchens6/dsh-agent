param(
    [ValidateSet('Setup', 'Start', 'Stop', 'Status', 'Test')]
    [string]$Action = 'Status',
    [string]$PostgresBin
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateDir = Join-Path $projectRoot '.local\native'
$pgData = Join-Path $stateDir 'postgres'
$weedExe = Join-Path $projectRoot '.tools\seaweedfs-4.47\bin\weed.exe'
$helper = Join-Path $PSScriptRoot 'infra.mjs'
$weedRecord = Join-Path $stateDir 'seaweedfs-process.json'

function Invoke-Helper([string[]]$HelperArgs) {
    & node $helper @HelperArgs
    if ($LASTEXITCODE -ne 0) { throw 'Native infrastructure helper failed. See the preceding diagnostic.' }
}
function Assert-FreePorts([int[]]$Ports) {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $Ports })
    if ($listeners.Count -gt 0) { throw "Required port already in use: $($listeners.LocalPort -join ', '). No existing process was stopped." }
}
function Get-WeedProcess {
    if (!(Test-Path -LiteralPath $weedRecord)) { return $null }
    $record = Get-Content -LiteralPath $weedRecord -Raw | ConvertFrom-Json
    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if (!$process) { return $null }
    if ($process.Path -ne $weedExe -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks) {
        throw 'Stored SeaweedFS PID belongs to another process; refusing to operate on it.'
    }
    return $process
}
function Test-PostgresRunning {
    & (Join-Path $PostgresBin 'pg_ctl.exe') status -D $pgData *> $null
    return $LASTEXITCODE -eq 0
}
function Assert-LocalBindings {
    $weed = Get-WeedProcess
    $owned = @()
    if ($weed) { $owned += $weed.Id }
    if (Test-Path -LiteralPath (Join-Path $pgData 'postmaster.pid')) {
        $owned += [int](Get-Content -LiteralPath (Join-Path $pgData 'postmaster.pid') -TotalCount 1)
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $owned })
    if (@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -gt 0) {
        throw 'A managed service is not bound to loopback. Stop it and inspect configuration before use.'
    }
    $listeners | Sort-Object LocalPort | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table
}

if ($Action -eq 'Setup') {
    if (!$PostgresBin) { throw 'Specify -PostgresBin with the extracted PostgreSQL bin directory.' }
    $PostgresBin = (Resolve-Path -LiteralPath $PostgresBin).Path
    foreach ($name in @('postgres.exe', 'initdb.exe', 'pg_ctl.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $PostgresBin $name))) { throw "Missing PostgreSQL binary: $name" }
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    # Restrict new files through inherited ACLs, before any credentials are generated.
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($sid in @($currentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $stateDir -AclObject $acl
    Invoke-Helper @('download')
    if (!(Test-Path -LiteralPath $weedExe)) {
        Expand-Archive -LiteralPath (Join-Path $projectRoot '.tools\seaweedfs-4.47\windows_amd64.zip') -DestinationPath (Split-Path $weedExe)
    }
    Invoke-Helper @('init', $PostgresBin)
    if (!(Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
        Assert-FreePorts @(5432)
        if ((Test-Path -LiteralPath $pgData) -and @(Get-ChildItem -LiteralPath $pgData -Force).Count -gt 0) {
            throw 'PostgreSQL data directory is nonempty but not initialized. Inspect manually; it will not be deleted.'
        }
        & (Join-Path $PostgresBin 'initdb.exe') -D $pgData -U platform_admin --encoding=UTF8 --locale=C --auth-host=scram-sha-256 --auth-local=scram-sha-256 "--pwfile=$(Join-Path $stateDir 'postgres-password.txt')"
        if ($LASTEXITCODE -ne 0) { throw 'initdb failed; existing files have been retained.' }
    }
    $passwordFile = Join-Path $stateDir 'postgres-password.txt'
    if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile }
} else {
    $settingsPath = Join-Path $stateDir 'settings.json'
    if (!(Test-Path -LiteralPath $settingsPath)) { throw 'Run Setup first.' }
    $saved = (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).postgresBin
    if ($PostgresBin -and $PostgresBin -ne $saved) { throw 'PostgresBin does not match this local cluster.' }
    $PostgresBin = $saved
}

if ($Action -in @('Setup', 'Start')) {
    if (!(Test-PostgresRunning)) {
        Assert-FreePorts @(5432)
        $pgArgs = "start -D `"$pgData`" -l `"$(Join-Path $stateDir 'postgres.log')`" -o `"-h 127.0.0.1 -p 5432`" -w -t 30"
        # Start-Process -Wait also waits for PostgreSQL descendants, which never exit during startup.
        $launcher = Start-Process -FilePath (Join-Path $PostgresBin 'pg_ctl.exe') -ArgumentList $pgArgs -WindowStyle Hidden -PassThru
        if (!$launcher.WaitForExit(40000)) { throw 'pg_ctl startup timed out; inspect the retained PostgreSQL log.' }
        $launcher.Refresh()
        if ($launcher.ExitCode -ne 0) { throw 'PostgreSQL startup failed. Check .local/native/postgres.log.' }
    }
    if (!(Get-WeedProcess)) {
        Assert-FreePorts @(8333, 9333, 9340, 8888, 18333, 19333, 19340, 18888)
        $weedData = Join-Path $stateDir 'seaweedfs'
        New-Item -ItemType Directory -Path $weedData -Force | Out-Null
        # mini 4.47 starts an administrative gRPC listener on all interfaces even with admin.ui=false.
        # server uses the same master/volume/filer data layout without starting that admin service.
        $weedArgs = @('server', "-dir=`"$weedData`"", '-ip=127.0.0.1', '-ip.bind=127.0.0.1',
            '-filer', '-s3', '-volume.port=9340', "-s3.config=`"$(Join-Path $stateDir 'seaweedfs.json')`"",
            '-s3.port=8333', '-s3.iam=false', '-s3.autoCreateBucket=false', '-s3.allowDeleteBucketNotEmpty=false',
            '-s3.port.iceberg=0', '-s3.port.lance=0', '-webdav=false', '-master.telemetry=false',
            '-volume.max=8', '-master.volumeSizeLimitMB=128', '-filer.disableDirListing', '-filer.exposeDirectoryData=false')
        $weed = Start-Process -FilePath $weedExe -ArgumentList $weedArgs -WorkingDirectory $weedData -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $stateDir 'seaweedfs.stdout.log') -RedirectStandardError (Join-Path $stateDir 'seaweedfs.stderr.log')
        @{ pid = $weed.Id; startTicks = $weed.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json | Set-Content -LiteralPath $weedRecord -Encoding UTF8
        $ready = $false
        for ($i = 0; $i -lt 40; $i++) {
            if (!(Get-WeedProcess)) { throw 'SeaweedFS exited; check .local/native/seaweedfs.stderr.log.' }
            try {
                $tcp = New-Object Net.Sockets.TcpClient
                $task = $tcp.ConnectAsync('127.0.0.1', 8333)
                if ($task.Wait(250) -and $tcp.Connected) { $ready = $true; break }
            } catch { } finally { if ($tcp) { $tcp.Dispose() } }
            Start-Sleep -Milliseconds 500
        }
        if (!$ready) { throw 'SeaweedFS startup timed out; inspect logs. Processes were retained for diagnosis.' }
    }
    Assert-LocalBindings
    Invoke-Helper @('bucket')
    if ($Action -eq 'Setup') { Invoke-Helper @('provision') }
    Write-Host 'Native PostgreSQL and S3 started. No application servers or model calls were started.'
}
if ($Action -eq 'Stop') {
    if (Test-PostgresRunning) {
        & (Join-Path $PostgresBin 'pg_ctl.exe') stop -D $pgData -m fast -w -t 30
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL stop failed; no force-kill was attempted.' }
    }
    $weed = Get-WeedProcess
    if ($weed) {
        Write-Warning 'Windows terminates SeaweedFS here. Stop application writers first; do not use this local helper for production shutdown.'
        Stop-Process -Id $weed.Id -ErrorAction Stop
        $weed.WaitForExit(10000) | Out-Null
    }
    Write-Host 'Managed local processes stopped; data and credentials retained.'
}
if ($Action -eq 'Status') {
    Write-Host "PostgreSQL running: $(Test-PostgresRunning)"
    Write-Host "SeaweedFS running: $([bool](Get-WeedProcess))"
    Assert-LocalBindings
}
if ($Action -eq 'Test') {
    Assert-LocalBindings
    Invoke-Helper @('verify')
}
