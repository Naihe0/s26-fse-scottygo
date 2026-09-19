[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'ScottyGo'
$dataDirectory = Join-Path $runtimeRoot 'data\s26-fse-scottygo'
$logDirectory = Join-Path $runtimeRoot 'logs\s26-fse-scottygo'
$statePath = Join-Path $projectRoot 'tmp\local-runtime.json'
$serverPath = Join-Path $projectRoot '.dist\server\serve.js'
$appPort = 8080
$mongoPort = 27017
$localUrl = "http://localhost:$appPort"
$runtimeState = @{ projectRoot = $projectRoot; mongoPid = $null; appPid = $null }

function Read-RuntimeState {
    if (Test-Path -LiteralPath $statePath) {
        $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($saved.projectRoot -ne $projectRoot) {
            throw "The runtime state belongs to another project: $statePath"
        }
        $runtimeState.mongoPid = $saved.mongoPid
        $runtimeState.appPid = $saved.appPid
    }
}

function Save-RuntimeState {
    $null = New-Item -ItemType Directory -Path (Split-Path $statePath) -Force
    $json = $runtimeState | ConvertTo-Json
    [IO.File]::WriteAllText($statePath, $json, [Text.UTF8Encoding]::new($false))
}

function Quote-Argument([string]$Value) {
    if ($Value.Contains('"')) { throw 'A process argument contains an unsupported quotation mark.' }
    return '"' + $Value + '"'
}

function Get-LocalProcess([int]$ProcessId) {
    if ($ProcessId -le 0) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
}

function Test-Argument([string]$CommandLine, [string]$Argument) {
    $escaped = [regex]::Escape($Argument)
    return $CommandLine -match "(?:^|\s)(?:`"$escaped`"|$escaped)(?=\s|$)"
}

function Test-OwnedProcess($Process, [string]$Kind) {
    if ($null -eq $Process -or [string]::IsNullOrWhiteSpace($Process.ExecutablePath)) {
        return $false
    }
    if ($Kind -eq 'app') {
        return $Process.ExecutablePath -eq $nodePath -and
            (Test-Argument $Process.CommandLine $serverPath)
    }
    return $null -ne $mongoPath -and $Process.ExecutablePath -eq $mongoPath -and
        (Test-Argument $Process.CommandLine '--dbpath') -and
        (Test-Argument $Process.CommandLine $dataDirectory) -and
        (Test-Argument $Process.CommandLine '--bind_ip') -and
        (Test-Argument $Process.CommandLine '127.0.0.1') -and
        (Test-Argument $Process.CommandLine '--port') -and
        (Test-Argument $Process.CommandLine "$mongoPort")
}

function Get-Listeners([int]$Port) {
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Assert-PrivateListener([int]$Port, [int]$ProcessId) {
    $listeners = @(Get-Listeners $Port)
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -ne $ProcessId -or $listener.LocalAddress -ne '127.0.0.1') {
            throw "Port $Port is occupied or is not bound exclusively to 127.0.0.1. No existing process was stopped."
        }
    }
    return $listeners.Count -gt 0
}

function Get-ReusableProcess([string]$Kind, [int]$Port) {
    $stateKey = $Kind + 'Pid'
    $savedId = $runtimeState[$stateKey]
    if ($savedId) {
        $process = Get-LocalProcess $savedId
        if ($null -ne $process) {
            if (-not (Test-OwnedProcess $process $Kind)) {
                Write-Warning "Ignoring stale $Kind PID $savedId; it belongs to a different process."
            } else {
                $null = Assert-PrivateListener $Port $savedId
                return $process
            }
        }
        $runtimeState[$stateKey] = $null
        Save-RuntimeState
    }
    $listeners = @(Get-Listeners $Port)
    if ($listeners.Count -gt 0) {
        $process = Get-LocalProcess $listeners[0].OwningProcess
        if (-not (Test-OwnedProcess $process $Kind)) {
            throw "Port $Port is already in use by another process. Stop it yourself or change the local configuration."
        }
        $null = Assert-PrivateListener $Port $process.ProcessId
        $runtimeState[$stateKey] = $process.ProcessId
        Save-RuntimeState
        return $process
    }
    return $null
}

function Wait-ForListener([string]$Kind, [int]$Port, [int]$ProcessId) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $process = Get-LocalProcess $ProcessId
        if (-not (Test-OwnedProcess $process $Kind)) {
            throw "$Kind exited before becoming ready. Check the logs in $logDirectory"
        }
        if (Assert-PrivateListener $Port $ProcessId) { return }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Kind has not opened port $Port yet. Check status and the logs in $logDirectory"
}

function Show-Status {
    foreach ($item in @(@('mongo', $mongoPort), @('app', $appPort))) {
        $kind = $item[0]
        $processId = $runtimeState[$kind + 'Pid']
        $process = if ($processId) { Get-LocalProcess $processId } else { $null }
        if (Test-OwnedProcess $process $kind) {
            $privateListener = Assert-PrivateListener $item[1] $processId
            $status = if ($privateListener) { 'listening on 127.0.0.1' } else { 'starting, no listener yet' }
            Write-Host "$kind`: PID $processId, $status, port $($item[1])"
        } elseif ($null -ne $process) {
            Write-Host "$kind`: saved PID $processId belongs to a different process; it will not be stopped."
        } else {
            Write-Host "$kind`: stopped"
        }
    }
    Write-Host "App: $localUrl"
    Write-Host "MongoDB: mongodb://127.0.0.1:$mongoPort/ScottyGoLocal"
    Write-Host "Data: $dataDirectory"
    Write-Host "Logs: $logDirectory"
}

$portableNode = Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-v24*-win-x64' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'node.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
$nodePath = if ($portableNode) { $portableNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$mongoPath = Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'mongodb-*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'bin\mongod.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
Read-RuntimeState

if ($Action -eq 'status') {
    Show-Status
    return
}

if ($Action -eq 'stop') {
    foreach ($kind in @('app', 'mongo')) {
        $stateKey = $kind + 'Pid'
        $processId = $runtimeState[$stateKey]
        if (-not $processId) { continue }
        $process = Get-LocalProcess $processId
        if ($null -ne $process) {
            if (-not (Test-OwnedProcess $process $kind)) {
                Write-Warning "Skipping stale $kind PID $processId; it belongs to a different process."
            } else {
                Stop-Process -Id $processId -ErrorAction Stop
                Wait-Process -Id $processId -Timeout 15 -ErrorAction SilentlyContinue
                Write-Host "Stopped $kind (PID $processId)."
            }
        }
        $runtimeState[$stateKey] = $null
        Save-RuntimeState
    }
    Show-Status
    return
}

if (-not $mongoPath) {
    throw "MongoDB is not installed under $runtimeRoot\mongodb-*\bin\mongod.exe. Install the portable runtime first."
}
if ([int]((& $nodePath --version).TrimStart('v').Split('.')[0]) -ne 24) {
    throw 'Install Node.js 24 LTS, or unpack its official Windows zip under %LOCALAPPDATA%\ScottyGo.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env'))) {
    throw "Create $projectRoot\.env before starting the app. See docs/LocalDevelopmentWindows.md."
}
$gitPath = (Get-Command git.exe -ErrorAction Stop).Source
$gitRoot = Split-Path (Split-Path $gitPath)
$gitUsrBin = Join-Path $gitRoot 'usr\bin'
if (-not (Test-Path -LiteralPath (Join-Path $gitUsrBin 'unzip.exe'))) {
    throw "Git's unzip.exe was not found in $gitUsrBin. Install standard Git for Windows before starting."
}

# Check both ports before launching anything; never take over an unrelated service.
$mongoProcess = Get-ReusableProcess 'mongo' $mongoPort
$appProcess = Get-ReusableProcess 'app' $appPort
if (-not (Test-Path -LiteralPath $serverPath)) {
    Push-Location $projectRoot
    try {
        & $nodePath (Join-Path $projectRoot 'node_modules\parcel\lib\bin.js') build
        if ($LASTEXITCODE -ne 0) { throw 'The application build failed.' }
    } finally { Pop-Location }
}
$null = New-Item -ItemType Directory -Path $dataDirectory, $logDirectory -Force

if ($null -eq $mongoProcess) {
    $mongoArguments = @(
        '--dbpath', (Quote-Argument $dataDirectory),
        '--bind_ip', '127.0.0.1', '--port', "$mongoPort",
        '--logpath', (Quote-Argument (Join-Path $logDirectory 'mongodb.log')), '--logappend'
    )
    $startedMongo = Start-Process -FilePath $mongoPath -ArgumentList $mongoArguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDirectory 'mongodb.stdout.log') `
        -RedirectStandardError (Join-Path $logDirectory 'mongodb.stderr.log')
    $runtimeState.mongoPid = $startedMongo.Id
    Save-RuntimeState
}
Wait-ForListener 'mongo' $mongoPort $runtimeState.mongoPid

if ($null -eq $appProcess) {
    # Scoped overrides keep this helper's child process local even if the shell
    # contains deployment variables. Restore every value after process creation.
    $childEnvironment = @{
        PATH = "$gitUsrBin;$env:PATH"
        ENV = 'LOCAL'
        STAGE = 'DEV'
        ALLOW_DB_RESET = 'false'
        BIND_ADDRESS = '127.0.0.1'
        LOCAL_HOST = 'http://localhost'
        PORT = "$appPort"
        DB_URL = "mongodb://127.0.0.1:$mongoPort"
        PROD_DB = '/ScottyGoLocal'
        DEV_DB = '/ScottyGoLocal'
        TEST_DB_URL = "mongodb://127.0.0.1:$mongoPort/scottygo_test_local"
    }
    $previousEnvironment = @{}
    try {
        foreach ($name in $childEnvironment.Keys) {
            $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $childEnvironment[$name], 'Process')
        }
        $startedApp = Start-Process -FilePath $nodePath `
            -ArgumentList @('--max-old-space-size=320', '--expose-gc', (Quote-Argument $serverPath)) `
            -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDirectory 'app.stdout.log') `
            -RedirectStandardError (Join-Path $logDirectory 'app.stderr.log')
        $runtimeState.appPid = $startedApp.Id
        Save-RuntimeState
    } finally {
        foreach ($name in $previousEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
        }
    }
}
Wait-ForListener 'app' $appPort $runtimeState.appPid
Show-Status
Write-Host 'Transit feeds may need another minute to finish loading. Re-run status or inspect app.stdout.log.'
