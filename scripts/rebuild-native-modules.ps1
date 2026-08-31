# Rebuild all native modules for Electron 42.10.0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ideRoot = Split-Path -Parent $scriptDir

$env:LIB = "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;" + $env:LIB
$env:SpectreMitigation = "false"
$env:CheckMSVCComponents = "false"

$modules = @(
    "node_modules\@vscode\policy-watcher",
    "node_modules\windows-foreground-love",
    "node_modules\@vscode\windows-mutex",
    "node_modules\@vscode\windows-process-tree",
    "node_modules\@vscode\windows-registry",
    "node_modules\@vscode\windows-ca-certs",
    "node_modules\@vscode\spdlog",
    "node_modules\@vscode\sqlite3",
    "node_modules\@vscode\deviceid",
    "node_modules\@vscode\native-watchdog",
    "node_modules\@vscode\fs-copyfile",
    "node_modules\native-keymap",
    "node_modules\native-is-elevated",
    "node_modules\node-pty",
    "node_modules\@parcel\watcher"
)

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Recompilando Módulos Nativos para Electron" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

foreach ($relPath in $modules) {
    $fullPath = Join-Path $ideRoot $relPath
    if (Test-Path -LiteralPath (Join-Path $fullPath "binding.gyp")) {
        Write-Host "Compilando: $relPath..." -ForegroundColor Yellow
        Push-Location $fullPath
        try {
            npx node-gyp rebuild --target=42.10.0 --dist-url=https://electronjs.org/headers
            Write-Host "OK: $relPath compilado com sucesso!" -ForegroundColor Green
        } catch {
            Write-Host "Aviso: Falha ao compilar $relPath : $_" -ForegroundColor Red
        } finally {
            Pop-Location
        }
    }
}

Write-Host "`nTodos os módulos nativos foram processados!" -ForegroundColor Green
