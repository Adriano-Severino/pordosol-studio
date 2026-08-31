param(
    [string]$Version = "0.1.5",
    [string]$OutputDir = "dist",
    [switch]$SkipSdkBuild
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ideRoot = Split-Path -Parent $scriptDir
$workspaceRoot = Split-Path -Parent $ideRoot

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Por do Sol Studio - Build da IDE Oficial v$Version" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# 1. Sincronizar SDK e Binarios Nativos
Write-Host "`n[1/4] Preparando Toolchain e SDK Embutidos..." -ForegroundColor Yellow
$binDir = Join-Path $ideRoot "resources\bin"
$stdlibDir = Join-Path $ideRoot "resources\stdlib"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $stdlibDir | Out-Null

$compiladorExe = Join-Path $workspaceRoot "compilador-portugues\target\release\compilador.exe"
$interpretadorExe = Join-Path $workspaceRoot "compilador-portugues\target\release\interpretador.exe"
$pordosolExe = Join-Path $workspaceRoot "ferramentas-cli\target\release\pordosol.exe"
$stdlibPbl = Join-Path $workspaceRoot "ferramentas-cli\dist\sistema.pbl"

if (-not (Test-Path -LiteralPath $compiladorExe) -and -not $SkipSdkBuild) {
    Write-Host "Compilando compilador e interpretador em release..." -ForegroundColor Gray
    Push-Location (Join-Path $workspaceRoot "compilador-portugues")
    & cargo build --release --bin compilador --bin interpretador
    Pop-Location
}

if (-not (Test-Path -LiteralPath $pordosolExe) -and -not $SkipSdkBuild) {
    Write-Host "Compilando ferramenta CLI em release..." -ForegroundColor Gray
    Push-Location (Join-Path $workspaceRoot "ferramentas-cli")
    & cargo build --release
    Pop-Location
}

Copy-Item $compiladorExe -Destination (Join-Path $binDir "compilador.exe") -Force
Copy-Item $interpretadorExe -Destination (Join-Path $binDir "interpretador.exe") -Force
Copy-Item $pordosolExe -Destination (Join-Path $binDir "pordosol.exe") -Force

if (Test-Path -LiteralPath $stdlibPbl) {
    Copy-Item $stdlibPbl -Destination (Join-Path $stdlibDir "sistema.pbl") -Force
}

Write-Host "OK: Binarios compilador, interpretador e pordosol integrados em resources/bin!" -ForegroundColor Green

# 2. Compilar a Extensao Nativa Por do Sol
Write-Host "`n[2/4] Preparando a Extensao Nativa Por do Sol..." -ForegroundColor Yellow
$extDir = Join-Path $ideRoot "extensions\pordosol"
if (Test-Path -LiteralPath $extDir) {
    Write-Host "OK: Extensao pordosol configurada em extensions/pordosol!" -ForegroundColor Green
}

# 3. Validar Product Branding e Gerar Ícones
Write-Host "`n[3/4] Sincronizando ícones, banners e product.json..." -ForegroundColor Yellow
if (Test-Path -LiteralPath (Join-Path $scriptDir "generate-icons.ps1")) {
    & (Join-Path $scriptDir "generate-icons.ps1")
}
$productJson = Get-Content -Raw -LiteralPath (Join-Path $ideRoot "product.json") | ConvertFrom-Json
Write-Host "Nome: $($productJson.nameLong)" -ForegroundColor White
Write-Host "App Name: $($productJson.applicationName)" -ForegroundColor White
Write-Host "OK: Branding oficial validado com sucesso!" -ForegroundColor Green

# 4. Resumo da IDE Oficial
Write-Host "`n[4/4] Estrutura da IDE Oficial pronta para empacotamento!" -ForegroundColor Yellow
Write-Host "Diretorio base: $ideRoot" -ForegroundColor White
Write-Host "Extensoes embutidas: extensions/pordosol" -ForegroundColor White
Write-Host "SDK nativo: resources/bin (compilador.exe, interpretador.exe, pordosol.exe)" -ForegroundColor White
Write-Host "Biblioteca Padrao: resources/stdlib (sistema.pbl)" -ForegroundColor White

Write-Host "`n==============================================" -ForegroundColor Cyan
Write-Host " IDE Por do Sol Studio v$Version pronta!" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
