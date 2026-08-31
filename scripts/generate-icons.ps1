Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ideRoot = Split-Path -Parent $scriptDir

$appJpeg = Join-Path $ideRoot "Por_do_Sol_Studio_app_202608311418.jpeg"
$fileJpeg = Join-Path $ideRoot "Document_file_icon_design_202608311418.jpeg"
$bannerJpeg = Join-Path $ideRoot "Por_do_Sol_Studio_banner_202608311418.jpeg"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Gerando Ícones e Assets do Por do Sol Studio" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# Criar pastas necessárias
$iconsDir = Join-Path $ideRoot "resources\icons"
$bannerDir = Join-Path $ideRoot "resources\banner"
$win32Dir = Join-Path $ideRoot "resources\win32"
$linuxDir = Join-Path $ideRoot "resources\linux"
$extIconsDir = Join-Path $ideRoot "extensions\pordosol\icons"
$welcomeMediaDir = Join-Path $ideRoot "src\vs\workbench\contrib\welcomeGettingStarted\browser\media"

foreach ($dir in @($iconsDir, $bannerDir, $win32Dir, $linuxDir, $extIconsDir, $welcomeMediaDir)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
}

function Resize-Image {
    param(
        [System.Drawing.Image]$SrcImage,
        [int]$Width,
        [int]$Height
    )
    $destRect = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
    $destImage = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($destImage)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($SrcImage, $destRect, 0, 0, $SrcImage.Width, $SrcImage.Height, [System.Drawing.GraphicsUnit]::Pixel)
    $graphics.Dispose()
    return $destImage
}

function Save-Png {
    param([System.Drawing.Image]$Image, [string]$Path)
    $Image.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Save-Bmp {
    param([System.Drawing.Image]$Image, [string]$Path)
    $Image.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
}

function Create-MultiIco {
    param(
        [System.Drawing.Image]$SrcImage,
        [string]$OutIcoPath,
        [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
    )
    $pngStreams = [System.Collections.Generic.List[byte[]]]::new()
    $dimList = [System.Collections.Generic.List[int]]::new()

    foreach ($size in $Sizes) {
        $resized = Resize-Image -SrcImage $SrcImage -Width $size -Height $size
        $ms = [System.IO.MemoryStream]::new()
        $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngStreams.Add($ms.ToArray())
        $dimList.Add($size)
        $ms.Dispose()
        $resized.Dispose()
    }

    $fs = [System.IO.FileStream]::new($OutIcoPath, [System.IO.FileMode]::Create)
    $bw = [System.IO.BinaryWriter]::new($fs)

    # ICONDIR Header
    $bw.Write([uint16]0) # Reserved
    $bw.Write([uint16]1) # Type (1 = ICO)
    $bw.Write([uint16]$Sizes.Length) # Count

    $offset = 6 + (16 * $Sizes.Length)

    # ICONDIRENTRY Entries
    for ($i = 0; $i -lt $Sizes.Length; $i++) {
        $size = $dimList[$i]
        $w = if ($size -ge 256) { 0 } else { [byte]$size }
        $h = if ($size -ge 256) { 0 } else { [byte]$size }
        $bytes = $pngStreams[$i]

        $bw.Write([byte]$w)          # Width
        $bw.Write([byte]$h)          # Height
        $bw.Write([byte]0)           # Color count
        $bw.Write([byte]0)           # Reserved
        $bw.Write([uint16]1)         # Color planes
        $bw.Write([uint16]32)        # Bits per pixel
        $bw.Write([uint32]$bytes.Length) # Bytes in resource
        $bw.Write([uint32]$offset)   # Image offset
        $offset += $bytes.Length
    }

    # Image Data
    for ($i = 0; $i -lt $Sizes.Length; $i++) {
        $bw.Write($pngStreams[$i])
    }

    $bw.Flush()
    $bw.Dispose()
    $fs.Dispose()
    Write-Host "OK: Gerado $OutIcoPath (tamanhos: $($Sizes -join ', '))" -ForegroundColor Green
}

# 1. Processar Ícone Principal do App
if (Test-Path -LiteralPath $appJpeg) {
    Write-Host "`n[1/3] Processando Ícone Principal do App..." -ForegroundColor Yellow
    $imgApp = [System.Drawing.Image]::FromFile($appJpeg)
    
    # Salvar cópia mestre PNG
    $appPng = Join-Path $iconsDir "app-icon.png"
    Save-Png -Image $imgApp -Path $appPng
    Write-Host "OK: $appPng" -ForegroundColor Green

    # Gerar code.ico multi-resolução
    $codeIco = Join-Path $win32Dir "code.ico"
    Create-MultiIco -SrcImage $imgApp -OutIcoPath $codeIco

    # Gerar code_150x150.png e code_70x70.png
    $img150 = Resize-Image -SrcImage $imgApp -Width 150 -Height 150
    Save-Png -Image $img150 -Path (Join-Path $win32Dir "code_150x150.png")
    $img150.Dispose()

    $img70 = Resize-Image -SrcImage $imgApp -Width 70 -Height 70
    Save-Png -Image $img70 -Path (Join-Path $win32Dir "code_70x70.png")
    $img70.Dispose()

    # Gerar Linux code.png
    $img512 = Resize-Image -SrcImage $imgApp -Width 512 -Height 512
    Save-Png -Image $img512 -Path (Join-Path $linuxDir "code.png")
    $img512.Dispose()

    # Gerar inno-small bitmaps para instalador Windows
    foreach ($item in @(@{w=55;h=55;n="inno-small-100.bmp"}, @{w=82;h=82;n="inno-small-150.bmp"}, @{w=110;h=110;n="inno-small-200.bmp"})) {
        $resized = Resize-Image -SrcImage $imgApp -Width $item.w -Height $item.h
        Save-Bmp -Image $resized -Path (Join-Path $win32Dir $item.n)
        $resized.Dispose()
    }

    $imgApp.Dispose()
}

# 2. Processar Ícone de Arquivo de Código (.pr)
if (Test-Path -LiteralPath $fileJpeg) {
    Write-Host "`n[2/3] Processando Ícone de Arquivo de Código (.pr)..." -ForegroundColor Yellow
    $imgFile = [System.Drawing.Image]::FromFile($fileJpeg)
    
    # Salvar cópia mestre PNG
    $filePng = Join-Path $iconsDir "file-icon.png"
    Save-Png -Image $imgFile -Path $filePng
    Write-Host "OK: $filePng" -ForegroundColor Green

    # Gerar pordosol.ico para associação no Windows
    $fileIco = Join-Path $win32Dir "pordosol.ico"
    Create-MultiIco -SrcImage $imgFile -OutIcoPath $fileIco

    # Gerar ícone para a extensão
    $extPng = Resize-Image -SrcImage $imgFile -Width 256 -Height 256
    Save-Png -Image $extPng -Path (Join-Path $extIconsDir "pordosol.png")
    $extPng.Dispose()
    Write-Host "OK: $(Join-Path $extIconsDir 'pordosol.png')" -ForegroundColor Green

    $imgFile.Dispose()
}

# 3. Processar Banner de Boas-Vindas
if (Test-Path -LiteralPath $bannerJpeg) {
    Write-Host "`n[3/3] Processando Banner de Boas-Vindas..." -ForegroundColor Yellow
    $imgBanner = [System.Drawing.Image]::FromFile($bannerJpeg)
    
    # Salvar cópia mestre PNG
    $bannerPng = Join-Path $bannerDir "welcome-banner.png"
    Save-Png -Image $imgBanner -Path $bannerPng
    Write-Host "OK: $bannerPng" -ForegroundColor Green

    # Copiar para a Welcome Page do VS Code
    $welcomeBanner = Join-Path $welcomeMediaDir "welcome-banner.png"
    Save-Png -Image $imgBanner -Path $welcomeBanner
    Write-Host "OK: $welcomeBanner" -ForegroundColor Green

    # Gerar inno-big bitmaps para o instalador Windows
    foreach ($item in @(
        @{w=164;h=314;n="inno-big-100.bmp"},
        @{w=205;h=392;n="inno-big-125.bmp"},
        @{w=246;h=471;n="inno-big-150.bmp"},
        @{w=328;h=628;n="inno-big-200.bmp"},
        @{w=410;h=785;n="inno-big-250.bmp"}
    )) {
        $resized = Resize-Image -SrcImage $imgBanner -Width $item.w -Height $item.h
        Save-Bmp -Image $resized -Path (Join-Path $win32Dir $item.n)
        $resized.Dispose()
    }

    $imgBanner.Dispose()
}

Write-Host "`n==============================================" -ForegroundColor Cyan
Write-Host " Todos os ícones e banners foram gerados e integrados!" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
