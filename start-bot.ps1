[CmdletBinding()]
param(
    [string]$AsrModel = "Qwen/Qwen3-ASR-0.6B",
    [string]$AsrDevice = "cuda:0",
    [ValidateSet("bfloat16", "float16", "float32")]
    [string]$AsrDtype = "bfloat16",
    [string]$GeminiModel = "",
    [string]$TtsPython = "",
    # Bounded readiness wait (seconds) for slow CUDA/model startup. 0 = skip.
    [int]$ReadinessTimeoutSec = 180,
    # Polling interval for ASR /health and GPT-SoVITS TCP probes.
    [int]$ReadinessPollIntervalSec = 2
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$botDir = Join-Path $repoRoot "airi\services\discord-bot"
$asrDir = Join-Path $repoRoot "qwen3-asr"
$ttsDir = Join-Path $repoRoot "GPT-SoVITS"
$envFile = Join-Path $botDir ".env"
$envExample = Join-Path $botDir ".env.example"
$asrPython = Join-Path $asrDir ".venv\Scripts\python.exe"
$ttsConfig = Join-Path $ttsDir "GPT_SoVITS\configs\tts_infer_kurisu.yaml"
$ttsModuleDir = Join-Path $ttsDir "GPT_SoVITS"
$nltkDataDir = Join-Path $ttsDir "nltk_data"
$condaGptSoVits = Join-Path $env:USERPROFILE "miniforge3\envs\GPTSoVits\python.exe"

function Test-ListeningPort([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-TcpConnect([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 1500) {
    # Conservative readiness probe: GPT-SoVITS loads its model synchronously
    # before uvicorn binds the socket, so an accepted TCP connection on 9880
    # means the model is loaded and the server is ready to synthesize. No
    # expensive /tts request is issued.
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if ($ok) { $client.EndConnect($iar); return $true }
        return $false
    }
    catch {
        return $false
    }
    finally {
        if ($client) { $client.Close() }
    }
}

function Wait-AsrReady([int]$TimeoutSec, [int]$IntervalSec) {
    # ASR exposes a real readiness endpoint: GET /health returns { ready: true }
    # only after the Qwen model finishes loading.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $url = "http://127.0.0.1:8765/health"
    Write-Host "Waiting for Qwen3-ASR readiness ($url)..."
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 5 -ErrorAction Stop
            if ($r.ready) {
                Write-Host "Qwen3-ASR is ready."
                return $true
            }
        }
        catch {
            # Not up yet; keep polling.
        }
        Start-Sleep -Seconds $IntervalSec
        Write-Host "  ...still waiting for ASR model load"
    }
    return $false
}

function Wait-GptSoVitsReady([int]$TimeoutSec, [int]$IntervalSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    Write-Host "Waiting for GPT-SoVITS readiness (TCP 127.0.0.1:9880)..."
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpConnect "127.0.0.1" 9880) {
            Write-Host "GPT-SoVITS is accepting connections (model loaded)."
            return $true
        }
        Start-Sleep -Seconds $IntervalSec
        Write-Host "  ...still waiting for GPT-SoVITS model load"
    }
    return $false
}

if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath $envExample -Destination $envFile
    throw "Created $envFile. Add DISCORD_TOKEN and GEMINI_API_KEY, then run this script again."
}

$envText = Get-Content -LiteralPath $envFile -Raw
foreach ($required in @("DISCORD_TOKEN", "GEMINI_API_KEY")) {
    if ($envText -notmatch "(?m)^\s*$required\s*=\s*\S+") {
        throw "$required is missing or empty in $envFile."
    }
}

if (-not (Test-Path -LiteralPath $asrPython)) {
    throw "Qwen ASR environment not found at $asrPython. Follow the README first-time setup."
}
if (-not (Test-Path -LiteralPath $ttsConfig)) {
    throw "Kurisu GPT-SoVITS config not found at $ttsConfig."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is not on PATH."
}

if (-not $TtsPython) {
    # Detect whichever GPT-SoVITS interpreter is present: the bundled runtime,
    # the .venv that setup-gpt-sovits provisions, the conda env used in the
    # RUNBOOK, or `python` on PATH as a last resort.
    $ttsCandidates = @(
        (Join-Path $ttsDir "runtime\python.exe"),
        (Join-Path $ttsDir ".venv\Scripts\python.exe"),
        $condaGptSoVits
    )
    $TtsPython = $ttsCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $TtsPython) {
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonCommand) {
            $TtsPython = $pythonCommand.Source
        }
    }
}
if (-not $TtsPython -or -not (Test-Path -LiteralPath $TtsPython)) {
    throw "No GPT-SoVITS Python interpreter found. Run .\setup-gpt-sovits.cmd, point at the conda env with -TtsPython, or pass its full path."
}
Write-Host "Using GPT-SoVITS interpreter: $TtsPython"

# NLTK_DATA must reach the GPT-SoVITS *child* process. Prefer the repo's
# provisioned nltk_data; fall back to the interpreter-local copy if the chosen
# interpreter lives in the conda env (which carries its own nltk_data).
$nltkCandidates = @($nltkDataDir)
if ($TtsPython -like "*miniforge3*") {
    $condaNltk = Join-Path (Split-Path (Split-Path $TtsPython)) "nltk_data"
    if (Test-Path -LiteralPath $condaNltk) { $nltkCandidates += $condaNltk }
}
$resolvedNltkData = $nltkCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($resolvedNltkData) {
    $env:NLTK_DATA = $resolvedNltkData
    Write-Host "NLTK_DATA = $resolvedNltkData"
}

# Verify the English frontend works *with NLTK_DATA exported*, mirroring real
# runtime conditions. This catches the averaged_perceptron_tagger_eng gap early.
& $TtsPython -c "import sys; sys.path.insert(0, r'$ttsModuleDir'); import soundfile, torch, torchaudio, fastapi; from text.english import g2p; g2p('English')"
if ($LASTEXITCODE -ne 0) {
    throw "The selected GPT-SoVITS Python ($TtsPython) is missing required packages or a working English frontend (NLTK averaged_perceptron_tagger_eng). Run .\setup-gpt-sovits.cmd."
}

$env:ASR_MODEL = $AsrModel
$env:ASR_DEVICE = $AsrDevice
$env:ASR_DTYPE = $AsrDtype
$env:PYTHONUTF8 = "1"
if ($GeminiModel) {
    $env:GEMINI_MODEL = $GeminiModel
}

$asrCommand = "& '$asrPython' -m app.server"
$ttsCommand = "& '$TtsPython' api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer_kurisu.yaml"
$botCommand = "pnpm.cmd start"
# Forward NLTK_DATA into every child PowerShell so the GPT-SoVITS process
# actually searches the populated location (the original race left it set only
# in this parent shell).
$childEnvPreamble = if ($resolvedNltkData) { "`$env:NLTK_DATA='$resolvedNltkData'; " } else { "" }
$childPowerShellArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command")

if (Test-ListeningPort 8765) {
    Write-Host "Port 8765 is already listening; reusing the existing ASR service."
    $asrAlreadyUp = $true
}
else {
    Write-Host "Starting Qwen3-ASR ($AsrModel on $AsrDevice)..."
    Start-Process powershell.exe -WindowStyle Normal -WorkingDirectory $asrDir -ArgumentList ($childPowerShellArgs + ($childEnvPreamble + $asrCommand))
    $asrAlreadyUp = $false
}

if (Test-ListeningPort 9880) {
    Write-Host "Port 9880 is already listening; reusing the existing GPT-SoVITS service."
    $ttsAlreadyUp = $true
}
else {
    Write-Host "Starting GPT-SoVITS with the Kurisu weights..."
    Start-Process powershell.exe -WindowStyle Normal -WorkingDirectory $ttsDir -ArgumentList ($childPowerShellArgs + ($childEnvPreamble + $ttsCommand))
    $ttsAlreadyUp = $false
}

# Enforce readiness instead of relying on human timing (Language_Fix_Proposal
# §18–§19). Bounded: a timeout prints a clear error and does NOT launch the bot
# into a known-broken state. Bot readiness is independent of Gemini.
if ($ReadinessTimeoutSec -gt 0) {
    if (-not $asrAlreadyUp) {
        if (-not (Wait-AsrReady $ReadinessTimeoutSec $ReadinessPollIntervalSec)) {
            throw "Qwen3-ASR did not become ready within ${ReadinessTimeoutSec}s. Check the ASR terminal window for errors."
        }
    }
    if (-not $ttsAlreadyUp) {
        if (-not (Wait-GptSoVitsReady $ReadinessTimeoutSec $ReadinessPollIntervalSec)) {
            throw "GPT-SoVITS did not become ready within ${ReadinessTimeoutSec}s. Check the TTS terminal window for model-load errors."
        }
    }
}
else {
    Write-Host "Readiness wait skipped (-ReadinessTimeoutSec 0). Make sure both services are fully loaded before using the bot."
}

Write-Host "Starting the Discord bot..."
Start-Process powershell.exe -WindowStyle Normal -WorkingDirectory $botDir -ArgumentList ($childPowerShellArgs + $botCommand)

Write-Host "Services launched and ready. Use /summon in Discord (then /voice-test to validate TTS)."
