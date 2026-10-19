$ErrorActionPreference = 'Stop'

$framework = if ([Environment]::Is64BitOperatingSystem) {
    Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
} else {
    Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
$compiler = Join-Path $framework 'csc.exe'
$output = Join-Path $PSScriptRoot 'AthenaPaperDesk.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw "C# compiler not found at $compiler. Install the .NET Framework 4.x developer tools."
}

& $compiler /nologo /target:winexe /platform:anycpu /optimize+ `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
    "/out:$output" `
    (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) {
    throw "Launcher build failed with exit code $LASTEXITCODE."
}
Write-Host "Built $output"
