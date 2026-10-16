[CmdletBinding()]
param([switch]$PackageOnly)

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
    $npmCommand = Get-Command npm.cmd -ErrorAction Stop
    if (!$PackageOnly) { $codeCommand = Get-Command code.cmd -ErrorAction Stop }

    $package = Get-Content -LiteralPath 'package.json' -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($package.name -ne 'kr-stock-monitor' -or $package.version -notmatch '^\d+\.\d+\.\d+$') {
        throw 'Unexpected extension name or version in package.json.'
    }

    Write-Host 'Running tests...'
    & $npmCommand test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Packaging and installation stopped.' }

    $outputDirectory = Join-Path $PSScriptRoot 'out\local-install'
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $vsixPath = Join-Path $outputDirectory "$($package.name)-$($package.version).vsix"

    Write-Host 'Packaging extension...'
    & $npmCommand exec --offline -- vsce package --skip-license --out $vsixPath
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed. Installation stopped.' }
    if (!(Test-Path -LiteralPath $vsixPath -PathType Leaf) -or (Get-Item -LiteralPath $vsixPath).Length -eq 0) {
        throw 'Packaging did not produce a non-empty VSIX file.'
    }

    if ($PackageOnly) {
        Write-Host "VSIX ready: $vsixPath"
    } else {
        Write-Host 'Installing into the default VS Code profile...'
        & $codeCommand --install-extension $vsixPath --force
        if ($LASTEXITCODE -ne 0) { throw 'VS Code extension installation failed.' }
        Write-Host 'Installed. Run Developer: Reload Window in VS Code, then reconnect the stock monitor.'
    }
}
finally {
    Pop-Location
}
