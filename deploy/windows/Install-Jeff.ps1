param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$queue = Join-Path $Root 'install-requests'
New-Item -ItemType Directory -Force -Path $queue | Out-Null

while ($true) {
  Get-ChildItem $queue -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    $requestFile = $_.FullName
    try {
      $request = Get-Content $requestFile -Raw | ConvertFrom-Json
      $installer = [IO.Path]::GetFullPath([string]$request.installer)
      $current = [IO.Path]::GetFullPath((Join-Path $Root 'current'))
      if (-not $installer.StartsWith("$current\", [StringComparison]::OrdinalIgnoreCase) -or
          [IO.Path]::GetFileName($installer) -notmatch '^jeff-Setup-[0-9]+\.[0-9]+\.[0-9]+\.exe$' -or
          $request.scope -notin @('currentuser', 'allusers')) {
        throw 'Rejected invalid installer request.'
      }
      $installerHash = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
      if ($installerHash -ne $request.sha256) { throw 'Installer hash changed before elevation.' }
      $args = @('/S', "/$($request.scope)")
      if ($request.directory) {
        $directory = [IO.Path]::GetFullPath([string]$request.directory)
        if (-not (Test-Path (Join-Path $directory 'Jeff.exe'))) { throw 'Original Jeff installation directory no longer exists.' }
        $args += "/D=$directory"
      }
      $process = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru
      $result = [ordered]@{ ok = ($process.ExitCode -eq 0); exitCode = $process.ExitCode }
    } catch {
      $result = [ordered]@{ ok = $false; error = $_.Exception.Message }
    }
    $resultPath = [string]$request.result
    $result | ConvertTo-Json | Set-Content "$resultPath.tmp" -Encoding utf8
    Move-Item -Force "$resultPath.tmp" $resultPath
    Remove-Item $requestFile -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}
