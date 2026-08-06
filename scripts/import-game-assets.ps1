param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$CatalogPath,
    [Parameter(Mandatory = $true)]
    [string]$IconsPath,
    [Parameter(Mandatory = $true)]
    [string]$Revision
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$catalog = (Resolve-Path -LiteralPath $CatalogPath).Path
$icons = (Resolve-Path -LiteralPath $IconsPath).Path

foreach ($candidate in @($catalog, $icons)) {
    if (-not $candidate.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CatalogPath and IconsPath must stay inside SourceRoot.'
    }
}
if ([IO.Path]::GetExtension($catalog) -ne '.json') {
    throw 'CatalogPath must be a JSON file.'
}
if ((Get-Item -LiteralPath $catalog).LinkType -or (Get-Item -LiteralPath $icons).LinkType) {
    throw 'Symbolic links and junctions are not accepted as import sources.'
}

$destination = Join-Path $projectRoot 'frontend\public\game-assets'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -LiteralPath $catalog -Destination (Join-Path $destination 'catalog.json') -Force

$iconDestination = Join-Path $destination 'icons'
New-Item -ItemType Directory -Path $iconDestination -Force | Out-Null
$copied = 0
Get-ChildItem -LiteralPath $icons -File | Where-Object {
    $_.Extension.ToLowerInvariant() -in @('.png', '.webp') -and -not $_.LinkType
} | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $iconDestination $_.Name) -Force
    $copied++
}

$manifest = [ordered]@{
    source = 'deafdudecomputers/PalworldSaveTools'
    revision = $Revision
    importedAt = [DateTimeOffset]::UtcNow.ToString('o')
    catalog = 'catalog.json'
    iconCount = $copied
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding utf8
Write-Host "Imported catalog and $copied icons into frontend/public/game-assets."
