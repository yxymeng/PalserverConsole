[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$palworldSaveToolsCommit = "18b9554168ecf684c5f1e1e4d8e583083b942eb9"
$serverToolCommit = "f45a48ef25ce08a5311a27e55b17062ba0bb4362"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$catalogPath = Join-Path $repositoryRoot "frontend\src\features\world\palCatalogData.json"
$assetRoot = Join-Path $repositoryRoot "frontend\public\assets\pals"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "palserver-console-pal-catalog-" + [Guid]::NewGuid().ToString("N")
)

function Checkout-Commit {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string[]]$SparsePaths
    )

    New-Item -ItemType Directory -Path $Destination | Out-Null
    git -C $Destination init --quiet
    git -C $Destination remote add origin $Url
    git -C $Destination sparse-checkout init --cone
    git -C $Destination sparse-checkout set @SparsePaths
    git -C $Destination fetch --quiet --depth 1 origin $Commit
    git -C $Destination checkout --quiet --detach FETCH_HEAD
}

try {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    $saveToolsRoot = Join-Path $temporaryRoot "PalworldSaveTools"
    $serverToolRoot = Join-Path $temporaryRoot "palworld-server-tool"
    Checkout-Commit `
        -Url "https://github.com/deafdudecomputers/PalworldSaveTools.git" `
        -Commit $palworldSaveToolsCommit `
        -Destination $saveToolsRoot `
        -SparsePaths @(
            "resources/game_data/characters.json",
            "resources/game_data/icons/pals",
            "resources/game_data/icons/T_icon_unknown.webp",
            "license"
        )
    Checkout-Commit `
        -Url "https://github.com/zaigie/palworld-server-tool.git" `
        -Commit $serverToolCommit `
        -Destination $serverToolRoot `
        -SparsePaths @("web/src/assets/pal.json", "LICENSE")

    $characters = Get-Content -LiteralPath (
        Join-Path $saveToolsRoot "resources\game_data\characters.json"
    ) -Raw -Encoding UTF8 | ConvertFrom-Json
    $localizations = Get-Content -LiteralPath (
        Join-Path $serverToolRoot "web\src\assets\pal.json"
    ) -Raw -Encoding UTF8 | ConvertFrom-Json
    $chineseNames = @{}
    $localizations.zh.PSObject.Properties | ForEach-Object {
        $chineseNames[$_.Name] = [string]$_.Value
    }
    $englishNames = @{}
    $localizations.en.PSObject.Properties | ForEach-Object {
        $englishNames[$_.Name] = [string]$_.Value
    }
    $palByAsset = @{}
    $characters.pals | ForEach-Object { $palByAsset[[string]$_.asset] = $_ }

    New-Item -ItemType Directory -Force -Path $assetRoot | Out-Null
    $sourceAssetRoot = Join-Path $saveToolsRoot "resources\game_data\icons\pals"
    Copy-Item -Path (Join-Path $sourceAssetRoot "*.webp") -Destination $assetRoot -Force
    Copy-Item -LiteralPath (
        Join-Path $saveToolsRoot "resources\game_data\icons\T_icon_unknown.webp"
    ) -Destination (Join-Path $assetRoot "T_icon_unknown.webp") -Force
    Copy-Item -LiteralPath (Join-Path $saveToolsRoot "license") `
        -Destination (Join-Path $assetRoot "LICENSE-PalworldSaveTools.txt") -Force
    Copy-Item -LiteralPath (Join-Path $serverToolRoot "LICENSE") `
        -Destination (Join-Path $assetRoot "LICENSE-palworld-server-tool.txt") -Force

    $catalog = [ordered]@{}
    foreach ($pal in ($characters.pals | Sort-Object asset)) {
        $characterId = [string]$pal.asset
        $name = if ($chineseNames.ContainsKey($characterId)) {
            $chineseNames[$characterId]
        } else {
            [string]$pal.name
        }
        $fullWidthBoss = [string][char]0xFF08 + "BOSS" + [char]0xFF09
        $name = $name.Replace("(BOSS)", "").Replace($fullWidthBoss, "").Trim()

        $iconFile = Split-Path -Leaf ([string]$pal.icon)
        if (-not (Test-Path -LiteralPath (Join-Path $sourceAssetRoot $iconFile))) {
            $baseId = [regex]::Replace(
                $characterId,
                "^(BOSS_|PREDATOR_|RAID_|GYM_)",
                "",
                "IgnoreCase"
            )
            if ($palByAsset.ContainsKey($baseId)) {
                $candidate = Split-Path -Leaf ([string]$palByAsset[$baseId].icon)
                if (Test-Path -LiteralPath (Join-Path $sourceAssetRoot $candidate)) {
                    $iconFile = $candidate
                }
            }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $sourceAssetRoot $iconFile))) {
            $iconFile = "T_icon_unknown.webp"
        }

        $catalog[$characterId] = [ordered]@{
            name = $name
            englishName = [string]$pal.name
            icon = "/assets/pals/$iconFile"
        }
    }

    # The live save can contain captured humans/NPCs which are absent from the
    # PalworldSaveTools character table. Keep their localized names and use the
    # explicit unknown portrait instead of falling back to an internal ID.
    foreach ($property in ($localizations.zh.PSObject.Properties | Sort-Object Name)) {
        $characterId = [string]$property.Name
        if ($catalog.Contains($characterId)) {
            continue
        }
        $name = [string]$property.Value
        $fullWidthBoss = [string][char]0xFF08 + "BOSS" + [char]0xFF09
        $name = $name.Replace("(BOSS)", "").Replace($fullWidthBoss, "").Trim()
        $catalog[$characterId] = [ordered]@{
            name = $name
            englishName = if ($englishNames.ContainsKey($characterId)) {
                $englishNames[$characterId]
            } else {
                $characterId
            }
            icon = "/assets/pals/T_icon_unknown.webp"
        }
    }

    $json = $catalog | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText(
        $catalogPath,
        $json + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host "Synced $($catalog.Count) Pal catalog rows and $((Get-ChildItem -LiteralPath $assetRoot -Filter '*.webp' -File).Count) image assets."
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        $resolvedTemporary = (Resolve-Path -LiteralPath $temporaryRoot).Path
        $expectedPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $resolvedTemporary.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a temporary path outside the system temp directory."
        }
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
}
