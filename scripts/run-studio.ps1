# Script para iniciar o Por do Sol Studio em Modo Desenvolvedor

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ideRoot = Split-Path -Parent $scriptDir

Push-Location $ideRoot
try {
    $exePath = Join-Path $ideRoot ".build\electron\Por do Sol Studio.exe"

    if (-not (Test-Path -LiteralPath $exePath)) {
        Write-Host "Preparando o runtime do Por do Sol Studio..." -ForegroundColor Yellow
        node build/lib/preLaunch.ts
    }

    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host " 🌅 Iniciando Por do Sol Studio (Modo Dev)" -ForegroundColor Cyan
    Write-Host "==============================================" -ForegroundColor Cyan

    $env:VSCODE_DEV = "1"
    $env:NODE_ENV = "development"
    $env:ELECTRON_ENABLE_LOGGING = "1"

    $argsList = @(".", "--disable-extension=vscode.vscode-api-tests")
    if ($args) {
        $argsList += $args
    }

    Start-Process -FilePath $exePath -ArgumentList $argsList
    Write-Host "Por do Sol Studio iniciado com sucesso!" -ForegroundColor Green
} finally {
    Pop-Location
}
