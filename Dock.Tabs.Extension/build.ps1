param(
    [Parameter(Position = 0)]
    [ValidateSet('chrome', 'firefox', 'all')]
    [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Compress-Archive (PS 5.1) writes backslash entry paths, which AMO rejects;
# build the zip manually with forward slashes instead.
function New-ExtensionZip([string]$Folder, [string]$Zip) {
    $archive = [IO.Compression.ZipFile]::Open($Zip, 'Create')
    try {
        foreach ($file in Get-ChildItem $Folder -Recurse -File) {
            $entry = $file.FullName.Substring($Folder.Length + 1).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entry) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
}

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'

# Files and folders shipped in the extension package (manifest handled separately)
$sources = @(
    'background.js',
    'content.js',
    'main.js',
    'browser-api.js',
    'dock-styles.css',
    'Dock',
    'images'
)

$browsers = if ($Target -eq 'all') { @('chrome', 'firefox') } else { @($Target) }

foreach ($browser in $browsers) {
    $out = Join-Path $dist $browser
    if (Test-Path $out) {
        Remove-Item $out -Recurse -Force -Confirm:$false
    }
    New-Item -ItemType Directory -Force $out | Out-Null

    foreach ($item in $sources) {
        Copy-Item (Join-Path $root $item) -Destination $out -Recurse
    }

    $manifestSource = Join-Path $root "manifest.$browser.json"
    $manifestDest = Join-Path $out 'manifest.json'
    Copy-Item $manifestSource -Destination $manifestDest

    if ($browser -eq 'chrome') {
        # The root manifest.json only exists so the source folder can be loaded
        # unpacked in Chrome; resync it here so it never drifts from the chrome one.
        Copy-Item $manifestSource -Destination (Join-Path $root 'manifest.json')
    }

    $version = (Get-Content $manifestDest -Raw | ConvertFrom-Json).version
    $zip = Join-Path $dist "tabdock-$browser-$version.zip"
    if (Test-Path $zip) {
        Remove-Item $zip -Force -Confirm:$false
    }
    # Zip the folder contents so manifest.json sits at the archive root (store requirement)
    New-ExtensionZip -Folder $out -Zip $zip

    Write-Host "[$browser] v$version"
    Write-Host "  folder: $out"
    Write-Host "  zip:    $zip"
}
