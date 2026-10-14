param([switch]$LiveModel)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateDir=Join-Path $projectRoot '.local\native'
$runId=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)
$reportDir=Join-Path $stateDir "test-reports\$runId"
if (!(Test-Path -LiteralPath (Join-Path $stateDir 'platform.json'))) {throw 'Run native platform Setup and Start before testing.'}
New-Item -ItemType Directory -Path $reportDir | Out-Null
$phases=@()
function Invoke-Phase([string]$Name,[scriptblock]$Command) {
    Write-Host "Running $Name ..."
    $started=[DateTimeOffset]::UtcNow
    & $Command *> (Join-Path $reportDir "$Name.log")
    $code=$LASTEXITCODE
    if ($null -eq $code) {$code=0}
    $script:phases += [PSCustomObject]@{name=$Name;exitCode=$code;startedAt=$started.ToString('o');durationMs=[math]::Round(([DateTimeOffset]::UtcNow-$started).TotalMilliseconds)}
    if ($code -ne 0) {throw "$Name failed (exit $code). See $reportDir\$Name.log"}
    Write-Host "PASS $Name"
}
$savedNatsServer=$env:NATS_SERVER_BIN
$failure=$null
Push-Location $projectRoot
try {
    $os=Get-CimInstance Win32_OperatingSystem
    $cpu=Get-CimInstance Win32_Processor
    $gitHead=(& git -c "safe.directory=$($projectRoot.Replace('\','/'))" rev-parse HEAD).Trim()
    $gitState=@(& git -c "safe.directory=$($projectRoot.Replace('\','/'))" status --porcelain)
    [PSCustomObject]@{capturedAt=[DateTimeOffset]::Now.ToString('o');timezone='Asia/Shanghai';os=$os.Caption;build=$os.BuildNumber;lastBoot=$os.LastBootUpTime;cpu=$cpu.Name;cores=$cpu.NumberOfCores;logicalProcessors=$cpu.NumberOfLogicalProcessors;memoryGiB=[math]::Round($os.TotalVisibleMemorySize/1MB,2);freeMemoryGiB=[math]::Round($os.FreePhysicalMemory/1MB,2);diskFreeGiB=[math]::Round((Get-PSDrive D).Free/1GB,2);node=(& node --version);npm=(& npm.cmd --version);gitHead=$gitHead;dirty=($gitState.Count -gt 0);changedPaths=$gitState} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDir 'environment.json') -Encoding UTF8
    $manifest=@()
    $sourceFiles=@(& rg --files -g '*.ts' -g '*.mjs' -g '*.ps1' -g '*.sql' -g 'package*.json' -g '!node_modules/**' -g '!deepseek-harness/**' -g '!dist/**' -g '!.local/**' -g '!.tools/**')
    foreach ($path in ($sourceFiles | Sort-Object)) { $manifest += [PSCustomObject]@{path=$path;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()} }
    $manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $reportDir 'source-sha256.json') -Encoding UTF8
    Invoke-Phase 'status-before' { & (Join-Path $PSScriptRoot 'platform.ps1') -Action Status; if ($?) {$global:LASTEXITCODE=0} }
    Invoke-Phase 'typecheck' { & npm.cmd run typecheck }
    Invoke-Phase 'build' { & npm.cmd run build }
    $env:NATS_SERVER_BIN=Join-Path $projectRoot '.tools\nats-2.15.0\nats-server-v2.15.0-windows-amd64\nats-server.exe'
    if (!(Test-Path -LiteralPath $env:NATS_SERVER_BIN)) {throw 'Real NATS binary missing; refusing to silently skip its regression test.'}
    Invoke-Phase 'regression' { & node --import tsx --test --test-concurrency=4 --test-reporter=tap @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') | Where-Object { $_.Name -match '\.test\.(ts|mjs)$' } | Sort-Object Name | ForEach-Object FullName) }
    Invoke-Phase 'infrastructure' { & node (Join-Path $PSScriptRoot 'infra.mjs') verify }
    Invoke-Phase 'acceptance' { & node (Join-Path $PSScriptRoot 'acceptance.mjs') $reportDir }
    foreach ($file in @('verification.json','verification-2026-10-10.json','workflow-verification.json')) {
        if (Test-Path -LiteralPath (Join-Path $stateDir $file)) {Copy-Item -LiteralPath (Join-Path $stateDir $file) -Destination (Join-Path $reportDir "prior-$file")}
    }
    if ($LiveModel) {
        Write-Host 'Live model test explicitly enabled: synthetic content only; provider charges may apply.'
        Invoke-Phase 'live-model' { & node (Join-Path $PSScriptRoot 'client.mjs') test }
        Copy-Item -LiteralPath (Join-Path $stateDir 'verification.json') -Destination (Join-Path $reportDir 'live-model.json')
    }
    Invoke-Phase 'status-after' { & (Join-Path $PSScriptRoot 'platform.ps1') -Action Status; if ($?) {$global:LASTEXITCODE=0} }
} catch {$failure=$_.Exception.Message;Write-Warning $failure}
finally {
    $env:NATS_SERVER_BIN=$savedNatsServer
    [PSCustomObject]@{runId=$runId;finishedAt=[DateTimeOffset]::Now.ToString('o');liveModel=[bool]$LiveModel;complete=($null -eq $failure);failure=$failure;phases=$phases} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDir 'suite.json') -Encoding UTF8
    Pop-Location
    Write-Host "Evidence directory: $reportDir"
}
if ($failure) {exit 1}
