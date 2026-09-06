[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [ValidateRange(5, 600)][int]$ReadinessTimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
$ownedServices = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$runtimeExitCode = 1
Push-Location -LiteralPath $PSScriptRoot

function Test-ServiceReady([string]$Name, [uri]$Address) {
    try {
        $endpoint = if ($Name -eq 'ASR') { 'health' } else { 'openapi.json' }
        $response = Invoke-RestMethod -Uri ($Address.AbsoluteUri.TrimEnd('/') + '/' + $endpoint) -TimeoutSec 3
        if ($Name -eq 'ASR') { return $response.ready -eq $true }
        return $response.paths.PSObject.Properties.Name -contains '/tts'
    }
    catch { return $false }
}

function Start-VoiceService([string]$Name, [uri]$Address, [string]$Project, [string]$Python, [string[]]$Arguments) {
    if (Test-ServiceReady $Name $Address) {
        Write-Host "$Name is ready; reusing the existing service."
        return
    }
    if ($Address.Host -notin @('127.0.0.1', 'localhost', '[::1]', '::1')) {
        throw "$Name is not ready at its configured remote address. Start that service on its host."
    }
    if (Get-NetTCPConnection -LocalPort $Address.Port -State Listen -ErrorAction SilentlyContinue) {
        throw "$Name port $($Address.Port) is occupied but its readiness check failed. Check the existing service."
    }
    if (-not (Test-Path -LiteralPath $Project -PathType Container)) {
        throw "$Name project not found at $Project. Configure its external project directory in .env.local."
    }
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
        throw "$Name Python interpreter not found at $Python. Configure its interpreter in .env.local."
    }
    $logRoot = Join-Path $PSScriptRoot '.local\services'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $service = Start-Process -FilePath $Python -ArgumentList $Arguments -WorkingDirectory $Project `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot "$Name.stdout.log") `
        -RedirectStandardError (Join-Path $logRoot "$Name.stderr.log")
    $ownedServices.Add($service)
    Write-Host "Starting $Name (PID $($service.Id)); logs: $logRoot"
    $deadline = (Get-Date).AddSeconds($ReadinessTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-ServiceReady $Name $Address) {
            Write-Host "$Name is ready."
            return
        }
        $service.Refresh()
        if ($service.HasExited) { throw "$Name exited during startup. Check $Name.stderr.log in $logRoot." }
        Start-Sleep -Seconds 2
    }
    throw "$Name was not ready after $ReadinessTimeoutSec seconds. Check its logs in $logRoot."
}

function Stop-OwnedProcessTree([int]$ProcessId) {
    # Windows venv launchers can have a child Python process. Capture that
    # relationship before stopping the parent; never stop a reused service.
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) { Stop-OwnedProcessTree $child.ProcessId }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

try {
    $settingsJson = & pnpm.cmd exec tsx --env-file=.env --env-file-if-exists=.config --env-file-if-exists=.env.local scripts/runtime-check.ts --settings
    if ($LASTEXITCODE -ne 0) { throw 'Runtime configuration check failed.' }
    $settings = ($settingsJson -join "`n") | ConvertFrom-Json
    if ($settings.backend -ne 'direct') { throw 'The local voice launcher requires BOT_BACKEND=direct. Use pnpm start:bot for another backend.' }

    $externalRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'DC_BOT'
    $asrProject = if ($settings.asrProject) { $settings.asrProject } else { Join-Path $externalRoot 'qwen3-asr' }
    $ttsProject = if ($settings.ttsProject) { $settings.ttsProject } else { Join-Path $externalRoot 'GPT-SoVITS' }
    $asrPython = if ($settings.asrPython) { $settings.asrPython } else { Join-Path $asrProject '.venv\Scripts\python.exe' }
    $ttsPython = $settings.ttsPython
    if (-not $ttsPython) {
        $ttsPython = @(
            (Join-Path $ttsProject 'runtime\python.exe'),
            (Join-Path $ttsProject '.venv\Scripts\python.exe'),
            (Join-Path $env:USERPROFILE 'miniforge3\envs\GPTSoVits\python.exe')
        ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    $asrAddress = [uri]$settings.asrUrl
    $ttsAddress = [uri]$settings.ttsUrl
    $env:ASR_HOST = $asrAddress.Host
    $env:ASR_PORT = [string]$asrAddress.Port
    $env:PYTHONUTF8 = '1'
    $env:PYTHONUNBUFFERED = '1'
    if (-not $env:NLTK_DATA) {
        $nltkRoot = @(
            (Join-Path $ttsProject 'nltk_data'),
            (Join-Path $env:USERPROFILE 'miniforge3\nltk_data'),
            (Join-Path $env:APPDATA 'nltk_data')
        ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
        if ($nltkRoot) { $env:NLTK_DATA = $nltkRoot }
    }
    Start-VoiceService 'ASR' $asrAddress $asrProject $asrPython @('-u', '-m', 'app.server')
    Start-VoiceService 'TTS' $ttsAddress $ttsProject $ttsPython @(
        '-u', 'api_v2.py', '-a', $ttsAddress.Host, '-p', [string]$ttsAddress.Port,
        '-c', 'GPT_SoVITS/configs/tts_infer_kurisu.yaml'
    )

    if ($CheckOnly) { & pnpm.cmd runtime:check }
    else { & pnpm.cmd start:bot }
    $runtimeExitCode = $LASTEXITCODE
}
catch { Write-Host $_.Exception.Message -ForegroundColor Red }
finally {
    foreach ($service in $ownedServices) {
        $service.Refresh()
        if (-not $service.HasExited) {
            Write-Host "Stopping model service started by this launcher (PID $($service.Id))."
            Stop-OwnedProcessTree $service.Id
        }
    }
    Pop-Location
}
exit $runtimeExitCode
