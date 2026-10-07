param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$incoming = Join-Path $Root 'incoming'
$results = Join-Path $Root 'results'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$runner = Join-Path $Root 'desktop-runner.cjs'
$testApk = Join-Path $Root 'current\app-release-androidTest.apk'
$probeApk = Get-ChildItem (Join-Path $Root 'current') -Filter 'jeff-*.apk' | Select-Object -First 1 -ExpandProperty FullName

function Save-Result($Path, $Value) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $Path = Join-Path $Path 'outcome.json'
  $tmp = "$Path.tmp"
  $Value | ConvertTo-Json -Depth 12 | Set-Content -Path $tmp -Encoding utf8
  Move-Item -Force $tmp $Path
}
function Capture-AndroidDiagnostics([string]$Serial, [string]$Tag) {
  & $adb -s $Serial logcat -d -b crash 2>&1 | Out-File "$script:runEvidence\android-crash-$Tag.log"
  & $adb -s $Serial shell dumpsys activity exit-info app.jeff.mobile 2>&1 | Out-File "$script:runEvidence\android-exit-info-$Tag.txt"
}
function Invoke-AndroidTests([string]$Serial, [string]$Tag) {
  & $adb -s $Serial install -r $probeApk | Out-File "$script:runEvidence\adb-install-$Tag.log"
  if ($LASTEXITCODE -ne 0) { throw "APK install failed on $Serial" }
  & $adb -s $Serial install -r $testApk | Out-File "$script:runEvidence\adb-test-install-$Tag.log"
  if ($LASTEXITCODE -ne 0) { throw "Android test APK install failed on $Serial" }
  & $adb -s $Serial shell am instrument -w -e class "app.jeff.mobile.$env:JEFF_DEPLOY_ANDROID_TEST_CLASS" app.jeff.mobile.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | Tee-Object -FilePath "$script:runEvidence\android-tests-$Tag.log"
  if ($LASTEXITCODE -ne 0 -or (Select-String -Path "$script:runEvidence\android-tests-$Tag.log" -Pattern 'FAILURES!!!|INSTRUMENTATION_FAILED' -Quiet) -or -not (Select-String -Path "$script:runEvidence\android-tests-$Tag.log" -Pattern 'OK \([1-9][0-9]* tests?\)' -Quiet)) { throw "Android instrumentation failed on $Serial" }
  Capture-AndroidDiagnostics $Serial $Tag
  & $adb -s $Serial shell screencap -p /sdcard/jeff-deploy.png
  & $adb -s $Serial pull /sdcard/jeff-deploy.png "$script:runEvidence\android-$Tag.png" | Out-Null
}

while ($true) {
  Get-ChildItem $incoming -Filter '*.request.json' -ErrorAction SilentlyContinue | ForEach-Object {
    $requestPath = $_.FullName
    $request = $null
    try {
      $request = Get-Content $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $runId = [string]$request.runId
      if ($runId -notmatch '^[0-9TZ-]+$') { throw 'Invalid run id.' }
      $script:runEvidence = Join-Path $results $runId
      New-Item -ItemType Directory -Force -Path $script:runEvidence | Out-Null
      $ok = $false
      $message = 'unknown failure'
      $androidResult = 'not run'
      $androidRetryRequired = $false
      try {
        foreach ($artifact in $request.artifacts) {
          $file = Join-Path (Join-Path $Root 'incoming') $artifact.name
          if (-not (Test-Path $file)) { throw "Missing artifact $($artifact.name)" }
          $info = Get-Item $file
          $hash = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
          if ($info.Length -ne $artifact.size -or $hash -ne $artifact.sha256) { throw "Artifact integrity check failed: $($artifact.name)" }
        }
        $manifest = $request.artifacts | ConvertTo-Json -Depth 8
        $manifest | Set-Content (Join-Path $script:runEvidence 'manifest.json') -Encoding utf8
        $current = Join-Path $Root 'current'
        New-Item -ItemType Directory -Force -Path $current | Out-Null
        foreach ($artifact in $request.artifacts) {
          Copy-Item (Join-Path (Join-Path $Root 'incoming') $artifact.name) (Join-Path $current $artifact.name) -Force
        }
        Copy-Item (Join-Path (Join-Path $Root 'incoming') "$($request.suite).json") (Join-Path $current "$($request.suite).json") -Force
        $request.androidTestClass = [string](Get-Content (Join-Path $current "$($request.suite).json") -Raw -Encoding UTF8 | ConvertFrom-Json).androidTestClass
        if ($request.androidTestClass -notmatch '^[A-Za-z][A-Za-z0-9_]*$') { throw 'Invalid Android instrumentation class in suite.' }
        $env:JEFF_DEPLOY_ANDROID_TEST_CLASS = $request.androidTestClass

        $probeApk = Join-Path $current "jeff-$($request.version).apk"
        if ($request.windowsAdb) { $adb = [string]$request.windowsAdb }
        $physical = $null
        if ($request.androidMode -eq 'physical' -and (Test-Path $adb)) {
          $devices = & $adb devices | Select-Object -Skip 1
          $line = $devices | Where-Object { $_ -match "^$([regex]::Escape([string]$request.phoneSerial))\s+device$" } | Select-Object -First 1
          if (-not $line) {
            & $adb connect '192.168.3.121:5555' | Out-Null
            $devices = & $adb devices | Select-Object -Skip 1
            $line = $devices | Where-Object { $_ -match '^192\.168\.3\.121:5555\s+device$' } | Select-Object -First 1
          }
          if ($line) {
            $physical = if ($line -match '^192\.168\.3\.121:5555') { '192.168.3.121:5555' } else { [string]$request.phoneSerial }
          }
        }
        $deviceLocked = $false
        if ($physical) {
          $windowState = & $adb -s $physical shell dumpsys window | Out-String
          $deviceLocked = $windowState -match 'mDreamingLockscreen=true|mShowingLockscreen=true|keyguardShowing=true'
          if ($deviceLocked) { $windowState | Set-Content (Join-Path $script:runEvidence 'android-lock-state.txt') }
        }
        if ($deviceLocked -and $request.androidPolicy -eq 'physical') { throw 'Required physical Android device is locked and cannot be operated.' }
        if ($physical) {
          if ($deviceLocked) {
            $androidResult = 'Ubuntu 模拟器通过；Windows 真机处于锁屏，真机待验收'
          } else {
            $env:JEFF_DEPLOY_SUITE = [string]$request.suite
            try {
              Invoke-AndroidTests $physical 'physical'
              $actualConnection = if ($physical -eq '192.168.3.121:5555') { 'network' } else { 'usb' }
              $androidResult = "Windows $actualConnection 真机通过"
            } catch {
              $physicalError = $_.Exception.Message
              Capture-AndroidDiagnostics $physical 'physical-failure'
              $latestDevices = & $adb devices | Out-String
              $isDisconnected = $latestDevices -notmatch "(?m)^$([regex]::Escape([string]$physical))\s+device$"
              if ($request.androidPolicy -eq 'auto' -and $isDisconnected) {
                $androidRetryRequired = $true
                $androidResult = "真机测试中断连：$physicalError；待 Ubuntu AVD 重跑完整测试集"
                $_ | Out-String | Set-Content (Join-Path $script:runEvidence 'physical-disconnect.txt')
                $latestDevices | Set-Content (Join-Path $script:runEvidence 'adb-devices-after-disconnect.txt')
              } else { throw }
            }
          }
        } elseif ($request.androidPolicy -eq 'physical') {
          throw 'Required physical Android device was not available on Windows.'
        } elseif (-not $deviceLocked) { $androidResult = 'Ubuntu 模拟器通过；Windows USB/网络 ADB 真机不可用' }

        $desktop = Join-Path $current "jeff-Setup-$($request.version).exe"
        if (-not (Test-Path $desktop)) { throw 'Windows installer missing.' }
        if (Get-Process Jeff -ErrorAction SilentlyContinue) {
          throw 'Jeff is still running. Finish or stop active chats, close Jeff normally, then retry deployment.'
        }
        $data = Join-Path $env:USERPROFILE '.jeff'
        if (Test-Path $data) {
          $backup = Join-Path (Join-Path $Root 'backups') $runId
          New-Item -ItemType Directory -Force -Path $backup | Out-Null
          $backup = Join-Path $backup 'jeff'
          Copy-Item $data $backup -Recurse -Force
        }
        $existing = @(
          Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
          Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
          Get-ItemProperty 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
        ) | Where-Object { $_.DisplayName -match '^Jeff(?: [0-9]+\.[0-9]+\.[0-9]+)?$' } | Select-Object -First 1
        $originalExe = if ($existing.DisplayIcon) { ([string]$existing.DisplayIcon -split ',')[0].Trim('"') } elseif ($existing.InstallLocation) { Join-Path $existing.InstallLocation 'Jeff.exe' } else { $null }
        $originalDirectory = if ($originalExe -and (Test-Path $originalExe)) { Split-Path $originalExe -Parent } else { $null }
        $scope = if ($existing.PSPath -like 'Microsoft.PowerShell.Core\Registry::HKEY_LOCAL_MACHINE*') { 'allusers' } else { 'currentuser' }
        $installerResult = Join-Path $script:runEvidence 'installer-result.json'
        $installRequestPath = Join-Path (Join-Path $Root 'install-requests') "$runId.json"
        $installRequest = [ordered]@{
          installer = $desktop; scope = $scope; directory = $originalDirectory
          sha256 = (Get-FileHash -Algorithm SHA256 $desktop).Hash.ToLowerInvariant()
          result = $installerResult
        }
        $installRequest | ConvertTo-Json | Set-Content "$installRequestPath.tmp" -Encoding utf8
        Move-Item -Force "$installRequestPath.tmp" $installRequestPath
        Start-ScheduledTask -TaskName 'JeffDeployInstaller'
        $installDeadline = (Get-Date).AddMinutes(3)
        while (-not (Test-Path $installerResult) -and (Get-Date) -lt $installDeadline) { Start-Sleep -Milliseconds 500 }
        if (-not (Test-Path $installerResult)) { throw 'Elevated Jeff installer task timed out.' }
        $installOutcome = Get-Content $installerResult -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $installOutcome.ok) {
          $installerFailure = $installOutcome.error
          if (-not $installerFailure) { $installerFailure = "exit code $($installOutcome.exitCode)" }
          throw "Jeff installer failed: $installerFailure"
        }

        $exe = if ($originalExe) { $originalExe } elseif ($existing.InstallLocation) { Join-Path $existing.InstallLocation 'Jeff.exe' } else { Join-Path $env:LOCALAPPDATA 'Programs\Jeff\Jeff.exe' }
        if (-not (Test-Path $exe)) {
          $uninstall = @(
            Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
            Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
            Get-ItemProperty 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
          ) | Where-Object { $_.DisplayName -match '^Jeff(?: [0-9]+\.[0-9]+\.[0-9]+)?$' } | Select-Object -First 1
          if ($uninstall.DisplayIcon) { $exe = ([string]$uninstall.DisplayIcon -split ',')[0].Trim('"') }
        }
        if (-not (Test-Path $exe)) { throw 'Installed Jeff.exe could not be resolved from the installer registration.' }
        $resources = Join-Path (Split-Path $exe -Parent) 'resources'
        $installedAsar = Join-Path $resources 'app.asar'
        $installedOpencode = Join-Path $resources 'oc-bin\windows-x64\opencode.exe'
        if (-not (Test-Path $installedAsar) -or
            (Get-FileHash -Algorithm SHA256 $installedAsar).Hash.ToLowerInvariant() -ne [string]$request.desktopAsarSha256) {
          throw 'Installed app.asar is missing or does not match this deployment.'
        }
        if (-not (Test-Path $installedOpencode)) { throw 'Installed bundled opencode.exe is missing.' }
        $env:JEFF_HOME = Join-Path $Root "runs\$runId\desktop-home"
        $env:JEFF_E2E = '1'
        $env:JEFF_RELAY_URL = [string]$request.relayUrl
        $env:JEFF_DEPLOY_EXPECTED_VERSION = [string]$request.version
        $env:JEFF_DEPLOY_SUITE = [string]$request.suite
        $env:JEFF_DEPLOY_SUITE_FILE = Join-Path $current "$($request.suite).json"
        $env:NODE_PATH = Join-Path $Root 'node_modules'
        $proc = Start-Process -FilePath $exe -ArgumentList @('--remote-debugging-port=0', "--user-data-dir=$(Join-Path $Root "runs\$runId\electron-data")") -PassThru
        try {
          $activePort = Join-Path (Join-Path $Root "runs\$runId\electron-data") 'DevToolsActivePort'
          $until = (Get-Date).AddSeconds(90)
          while (-not (Test-Path $activePort) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 500 }
          if (-not (Test-Path $activePort)) { throw 'Installed Jeff did not expose its test endpoint.' }
          $port = (Get-Content $activePort -TotalCount 1).Trim()
          & $node $runner "http://127.0.0.1:$port" $script:runEvidence
          if ($LASTEXITCODE -ne 0) { throw 'Installed desktop UI acceptance failed.' }
        } finally {
          if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        }
        $ok = $true
        $message = 'Windows installation and UI acceptance passed.'
      } catch {
        $message = $_.Exception.Message
        $_ | Out-String | Set-Content (Join-Path $script:runEvidence 'error.txt')
      }
      Save-Result (Join-Path $results $runId) ([ordered]@{ ok = $ok; message = $message; androidResult = $androidResult; androidRetryRequired = $androidRetryRequired; runId = $runId })
      Remove-Item $requestPath -Force -ErrorAction SilentlyContinue
    } catch {
      if ($request -and $request.runId) {
        Save-Result (Join-Path $results ([string]$request.runId)) ([ordered]@{ ok = $false; message = $_.Exception.Message; androidResult = 'not run'; runId = $request.runId })
      }
      Remove-Item $requestPath -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 500
}
