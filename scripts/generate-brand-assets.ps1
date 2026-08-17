[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$IconSource,
    [Parameter(Mandatory = $true)][string]$HeroSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$publicRoot = Join-Path $projectRoot "frontend\public"
$brandingRoot = Join-Path $projectRoot "branding"
New-Item -ItemType Directory -Path $publicRoot, $brandingRoot -Force | Out-Null

function New-ResizedBitmap {
    param(
        [Parameter(Mandatory = $true)][System.Drawing.Image]$Source,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height
    )

    $bitmap = New-Object System.Drawing.Bitmap(
        $Width,
        $Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($Source, 0, 0, $Width, $Height)
    }
    finally {
        $graphics.Dispose()
    }
    return $bitmap
}

function Save-Png {
    param(
        [Parameter(Mandatory = $true)][System.Drawing.Image]$Source,
        [Parameter(Mandatory = $true)][int]$Width,
        [Parameter(Mandatory = $true)][int]$Height,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $bitmap = New-ResizedBitmap -Source $Source -Width $Width -Height $Height
    try {
        $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }
}

function Save-Ico {
    param(
        [Parameter(Mandatory = $true)][System.Drawing.Image]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $images = @()
    try {
        foreach ($size in $sizes) {
            $bitmap = New-ResizedBitmap -Source $Source -Width $size -Height $size
            $stream = New-Object System.IO.MemoryStream
            try {
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $images += ,$stream.ToArray()
            }
            finally {
                $stream.Dispose()
                $bitmap.Dispose()
            }
        }

        $file = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create)
        $writer = New-Object System.IO.BinaryWriter($file)
        try {
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]$sizes.Count)
            $offset = 6 + (16 * $sizes.Count)
            for ($index = 0; $index -lt $sizes.Count; $index++) {
                $size = $sizes[$index]
                $dimension = if ($size -eq 256) { 0 } else { $size }
                $writer.Write([byte]$dimension)
                $writer.Write([byte]$dimension)
                $writer.Write([byte]0)
                $writer.Write([byte]0)
                $writer.Write([uint16]1)
                $writer.Write([uint16]32)
                $writer.Write([uint32]$images[$index].Length)
                $writer.Write([uint32]$offset)
                $offset += $images[$index].Length
            }
            foreach ($image in $images) {
                $writer.Write($image)
            }
        }
        finally {
            $writer.Dispose()
            $file.Dispose()
        }
    }
    finally {
        $images = @()
    }
}

$icon = [System.Drawing.Image]::FromFile($IconSource)
$hero = [System.Drawing.Image]::FromFile($HeroSource)
try {
    Save-Png -Source $icon -Width 512 -Height 512 -Destination (Join-Path $publicRoot "zoe-console-icon.png")
    Save-Png -Source $icon -Width 32 -Height 32 -Destination (Join-Path $publicRoot "favicon-32.png")
    Save-Png -Source $icon -Width 180 -Height 180 -Destination (Join-Path $publicRoot "apple-touch-icon.png")
    Save-Png -Source $hero -Width 800 -Height 1000 -Destination (Join-Path $publicRoot "zoe-character.png")
    Save-Ico -Source $icon -Destination (Join-Path $brandingRoot "PalServerConsole.ico")
    Copy-Item -LiteralPath (Join-Path $brandingRoot "PalServerConsole.ico") -Destination (Join-Path $publicRoot "favicon.ico") -Force
}
finally {
    $icon.Dispose()
    $hero.Dispose()
}

Write-Host "Brand assets generated in frontend/public and branding."
