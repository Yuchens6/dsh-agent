[CmdletBinding()]
param(
    [ValidateSet("development", "staging", "production")]
    [string]$Environment = "development",

    [switch]$AllowPlaceholders
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OverlayPath = Join-Path $ProjectRoot "manifests/overlays/$Environment"

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    throw "kubectl was not found in PATH."
}

$RenderedLines = & kubectl kustomize $OverlayPath
if ($LASTEXITCODE -ne 0) {
    throw "Kustomize rendering failed for environment '$Environment'."
}

$Rendered = $RenderedLines -join [Environment]::NewLine
$Errors = [System.Collections.Generic.List[string]]::new()

$RequiredKinds = @(
    "GatewayClass",
    "Gateway",
    "HTTPRoute",
    "SecurityPolicy",
    "BackendTrafficPolicy",
    "NetworkPolicy"
)

foreach ($Kind in $RequiredKinds) {
    if ($Rendered -notmatch "(?m)^kind:\s+$([regex]::Escape($Kind))\s*$") {
        $Errors.Add("Required kind '$Kind' is missing.")
    }
}

$HttpRouteCount = [regex]::Matches($Rendered, "(?m)^kind:\s+HTTPRoute\s*$").Count
if ($HttpRouteCount -ne 2) {
    $Errors.Add("Exactly 2 public HTTPRoute resources are required; found $HttpRouteCount.")
}

foreach ($ExpectedBackend in @("dsh-agent-api", "dsh-agent-stream")) {
    if ($Rendered -notmatch "(?m)^\s+name:\s+$([regex]::Escape($ExpectedBackend))\s*$") {
        $Errors.Add("Required public backend '$ExpectedBackend' is missing.")
    }
}

if ($Rendered -notmatch "(?m)^\s+requestBuffer:\s*$") {
    $Errors.Add("The API request body limit is missing.")
}

if ([regex]::Matches($Rendered, "(?m)^\s+type:\s+ResponseHeaderModifier\s*$").Count -ne 2) {
    $Errors.Add("Both public routes must set security response headers.")
}

$AllowedPaths = @("/api/v1", "/events/v1")
$PathMatches = [regex]::Matches($Rendered, "(?m)^\s+value:\s+(/[^\s]+)\s*$")
foreach ($Match in $PathMatches) {
    $Path = $Match.Groups[1].Value
    if ($Path -notin $AllowedPaths) {
        $Errors.Add("Unexpected public path '$Path'.")
    }
}

foreach ($RequiredPath in $AllowedPaths) {
    if ($Rendered -notmatch "(?m)^\s+value:\s+$([regex]::Escape($RequiredPath))\s*$") {
        $Errors.Add("Required public path '$RequiredPath' is missing.")
    }
}

$ForbiddenBackends = @(
    "dsh-agent-runtime",
    "dsh-agent-workspace",
    "dsh-agent-worker",
    "dsh-agent-run-control",
    "postgres",
    "redis",
    "nats",
    "minio"
)

foreach ($Backend in $ForbiddenBackends) {
    if ($Rendered -match "(?im)^\s+name:\s+$([regex]::Escape($Backend))\s*$") {
        $Errors.Add("Forbidden public or edge resource reference '$Backend' was found.")
    }
}

if ($Rendered -match "(?m)^\s+protocol:\s+HTTP\s*$") {
    $Errors.Add("A plaintext HTTP listener was found. The public listener must be HTTPS only.")
}

if ($Environment -ne "development") {
    if ($Rendered -notmatch "(?m)^\s+jwt:\s*$") {
        $Errors.Add("JWT validation is required outside development.")
    }

    if (-not $AllowPlaceholders -and $Rendered -match "(?i)change-me") {
        $Errors.Add("Unresolved 'change-me' values are not allowed in $Environment.")
    }
}

if ($Errors.Count -gt 0) {
    Write-Error ("Manifest validation failed:`n - " + ($Errors -join "`n - "))
    exit 1
}

Write-Output "Manifest validation passed for '$Environment'."
