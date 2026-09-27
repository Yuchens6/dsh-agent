[CmdletBinding()]
param(
    [ValidateSet("development", "staging", "production")]
    [string]$Environment = "development",

    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OverlayPath = Join-Path $ProjectRoot "manifests/overlays/$Environment"

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    throw "kubectl was not found in PATH."
}

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $ProjectRoot ".rendered"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputFile = Join-Path $OutputDirectory "$Environment.yaml"

$Rendered = & kubectl kustomize $OverlayPath
if ($LASTEXITCODE -ne 0) {
    throw "Kustomize rendering failed for environment '$Environment'."
}

$Rendered | Set-Content -LiteralPath $OutputFile -Encoding utf8NoBOM
Write-Output $OutputFile

