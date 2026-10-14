param(
    [ValidateSet('Setup','Start','Stop','Status','Test','Restart')][string]$Action = 'Status',
    [ValidateSet('api','chat','catalog','web','stream','workspace','run-control','runtime-dsh','quota','audit','knowledge')][string[]]$Services = @(),
    [string]$PostgresBin,
    [string]$JavaHome = 'D:\jdk23'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateDir = Join-Path $projectRoot '.local\native'
$helper = Join-Path $PSScriptRoot 'platform.mjs'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$applicationServices = @('audit','quota','workspace','catalog','chat','run-control','knowledge','api','stream','runtime-dsh','web')
$ports = @{api=8080;iam=8081;stream=8082;chat=8083;workspace=8084;'run-control'=8085;catalog=8086;quota=8087;audit=8088;'runtime-dsh'=8089;knowledge=8090;nats=4222;web=3000}

function Invoke-Helper([string[]]$Arguments) {
    & $nodeExe $helper @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Platform helper failed: $($Arguments[0]). Logs and data retained." }
}
function Install-Release([string]$Directory,[string]$Archive,[string]$Executable,[string]$Url,[string]$Sha256) {
    $destination = Join-Path $projectRoot $Directory
    if (Test-Path -LiteralPath (Join-Path $destination $Executable)) { return }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $zip = Join-Path $destination $Archive
    if (!(Test-Path -LiteralPath $zip)) { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $zip }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw "Release checksum mismatch: $Archive. File retained for inspection; no extraction attempted." }
    Expand-Archive -LiteralPath $zip -DestinationPath $destination
    if (!(Test-Path -LiteralPath (Join-Path $destination $Executable))) { throw "Release archive does not contain $Executable" }
}
function Get-ManagedProcess([string]$Name) {
    $recordPath = Join-Path $stateDir "$Name-process.json"
    if (!(Test-Path -LiteralPath $recordPath)) { return $null }
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $managed = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if (!$managed) { return $null }
    # Windows can briefly return an empty image path while a newly launched executable loads.
    for ($attempt=0; $attempt -lt 10 -and !$managed.Path; $attempt++) {
        Start-Sleep -Milliseconds 100
        $managed = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if (!$managed) { return $null }
    }
    if ($managed.Path -ne $record.executable -or $managed.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks) {
        throw "Stored PID for $Name was reused; refusing to operate on it. Inspect the process record."
    }
    return $managed
}
function Start-Managed([string]$Name) {
    if (Get-ManagedProcess $Name) { return }
    if (Get-NetTCPConnection -State Listen -LocalPort $ports[$Name] -ErrorAction SilentlyContinue) { throw "Port $($ports[$Name]) is occupied by an unmanaged process; nothing was stopped." }
    $managed = Start-Process -FilePath $nodeExe -ArgumentList @("`"$helper`"",'serve',$Name) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $stateDir "logs\$Name.stdout.log") -RedirectStandardError (Join-Path $stateDir "logs\$Name.stderr.log")
    @{pid=$managed.Id;executable=$nodeExe;startTicks=$managed.StartTime.ToUniversalTime().Ticks.ToString();gracefulStop=($Name -in $applicationServices)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir "$Name-process.json") -Encoding UTF8
    Write-Host "$Name starting (PID $($managed.Id))"
}
function Wait-Ready([string]$Name) {
    $deadline = (Get-Date).AddSeconds($(if ($Name -eq 'iam') { 180 } else { 40 }))
    while ((Get-Date) -lt $deadline) {
        if (!(Get-ManagedProcess $Name)) { throw "$Name exited; inspect .local/native/logs/$Name.stderr.log" }
        try {
            if ($Name -eq 'nats') {
                $client = [Net.Sockets.TcpClient]::new()
                try { if ($client.ConnectAsync('127.0.0.1',4222).Wait(500) -and $client.Connected) { return } } finally { $client.Dispose() }
            } else {
                $path = if ($Name -eq 'iam') { '/realms/agent-local/.well-known/openid-configuration' } else { '/health/ready' }
                $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($ports[$Name])$path" -TimeoutSec 2
                if ($response.StatusCode -eq 200) { Write-Host "$Name ready"; return }
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name readiness timed out; processes and logs retained for diagnosis."
}
function Assert-LocalBindings {
    $owned = @()
    foreach ($name in (@('iam','nats') + $applicationServices)) {
        $managed = Get-ManagedProcess $name
        if ($managed) { $owned += $managed.Id }
    }
    $all = @(Get-CimInstance Win32_Process)
    do {
        $children = @($all | Where-Object { $_.ParentProcessId -in $owned -and $_.ProcessId -notin $owned } | ForEach-Object { [int]$_.ProcessId })
        $owned += $children
    } while ($children.Count -gt 0)
    $public = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $owned -and $_.LocalAddress -notin @('127.0.0.1','::1') })
    if ($public.Count -gt 0) { throw "Managed service has a non-loopback listener on port(s): $($public.LocalPort -join ','). Stop and inspect configuration." }
}

if ($Action -eq 'Setup') {
    Install-Release '.tools\keycloak-26.7.4' 'keycloak-26.7.4.zip' 'keycloak-26.7.4\bin\kc.bat' 'https://github.com/keycloak/keycloak/releases/download/26.7.4/keycloak-26.7.4.zip' 'a286e98b4296d4e75ee88d8527c7cd463b307caa022f088c9f22cffccc741fa1'
    Install-Release '.tools\nats-2.15.0' 'nats-server-v2.15.0-windows-amd64.zip' 'nats-server-v2.15.0-windows-amd64\nats-server.exe' 'https://github.com/nats-io/nats-server/releases/download/v2.15.0/nats-server-v2.15.0-windows-amd64.zip' '2d0861dc2ca3567d17f7d19611d7b346cc2ccbd7086a0a77cc957a2c71663200'
    if (!(Test-Path -LiteralPath (Join-Path $stateDir 'settings.json'))) {
        if (!$PostgresBin) { throw 'Specify the extracted PostgreSQL bin directory using -PostgresBin.' }
        & (Join-Path $PSScriptRoot 'infra.ps1') -Action Setup -PostgresBin $PostgresBin
    } else { & (Join-Path $PSScriptRoot 'infra.ps1') -Action Start }
    & $nodeExe (Join-Path $PSScriptRoot 'infra.mjs') provision
    if ($LASTEXITCODE -ne 0) { throw 'Database provisioning failed' }
    Invoke-Helper @('configure',$JavaHome)
    Push-Location $projectRoot
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Build failed' } } finally { Pop-Location }
    Invoke-Helper @('migrate')
    Invoke-Helper @('seed')
}
if ($Action -in @('Start','Setup')) {
    if (!(Test-Path -LiteralPath (Join-Path $stateDir 'platform.json'))) { throw 'Run Setup first.' }
    & (Join-Path $PSScriptRoot 'infra.ps1') -Action Start
    Start-Managed 'nats'; Wait-Ready 'nats'; Invoke-Helper @('streams')
    Start-Managed 'iam'; Wait-Ready 'iam'
    foreach ($name in $applicationServices) { Start-Managed $name; Wait-Ready $name }
    Assert-LocalBindings
    Write-Host 'Native platform is running: Web http://localhost:3000; API http://127.0.0.1:8080; IAM http://127.0.0.1:8081; SSE http://127.0.0.1:8082'
}
if ($Action -eq 'Stop') {
    $reverse = @($applicationServices); [array]::Reverse($reverse)
    foreach ($name in ($reverse + @('iam','nats'))) {
        $managed = Get-ManagedProcess $name
        if ($managed) {
            $record = Get-Content -LiteralPath (Join-Path $stateDir "$name-process.json") -Raw | ConvertFrom-Json
            if ($name -in $applicationServices -and $record.gracefulStop) {
                @{pid=$managed.Id;requestedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir "$name.stop.json") -Encoding UTF8
                if ($managed.WaitForExit(15000)) { Write-Host "$name stopped gracefully"; continue }
                Write-Warning "$name graceful shutdown timed out; terminating its verified process tree."
            }
            # Verified executable + start time prevents stale PID records killing unrelated processes.
            & taskkill.exe /PID $managed.Id /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Could not stop $name" }
            $managed.WaitForExit(10000) | Out-Null
            Write-Host "$name stopped"
        }
    }
    & (Join-Path $PSScriptRoot 'infra.ps1') -Action Stop
    Write-Host 'Stopped native processes. Persistent data and credentials retained. Apps are gracefully drained when supported; Windows terminates IAM/NATS/SeaweedFS. Use this helper for local development only.'
}
if ($Action -eq 'Status') {
    & (Join-Path $PSScriptRoot 'infra.ps1') -Action Status
    foreach ($name in (@('nats','iam') + $applicationServices)) {
        $managed = Get-ManagedProcess $name
        $status = 'stopped'
        if ($managed) {
            if ($name -eq 'nats') { $status = 'running' }
            else {
                try { $path = if ($name -eq 'iam') { '/realms/agent-local/.well-known/openid-configuration' } else { '/health/ready' }; $null = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$($ports[$name])$path" -TimeoutSec 2; $status='ready' } catch { $status='not-ready' }
            }
        }
        [PSCustomObject]@{Service=$name;Port=$ports[$name];Status=$status;PID=$(if($managed){$managed.Id}else{$null})} | Format-Table -HideTableHeaders
    }
    Assert-LocalBindings
}
if ($Action -eq 'Test') {
    Assert-LocalBindings
    & (Join-Path $PSScriptRoot 'infra.ps1') -Action Test
    & $nodeExe (Join-Path $PSScriptRoot 'client.mjs') test
    if ($LASTEXITCODE -ne 0) { throw 'Native end-to-end verification failed.' }
}
if ($Action -eq 'Restart') {
    if (!$Services.Count) { throw 'Specify only the application services to restart using -Services.' }
    foreach ($name in $Services) {
        $managed = Get-ManagedProcess $name
        if ($managed) {
            $record = Get-Content -LiteralPath (Join-Path $stateDir "$name-process.json") -Raw | ConvertFrom-Json
            if (!$record.gracefulStop) { throw "$name does not support a verified graceful restart. Stop it explicitly first." }
            @{pid=$managed.Id;requestedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir "$name.stop.json") -Encoding UTF8
            if (!$managed.WaitForExit(15000)) { throw "$name did not stop gracefully; refusing to force termination during a targeted restart." }
        }
        Start-Managed $name
        Wait-Ready $name
    }
    Assert-LocalBindings
}
