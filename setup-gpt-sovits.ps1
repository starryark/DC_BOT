[CmdletBinding()]
param(
    [ValidateSet("cu128", "cu126", "cpu")]
    [string]$TorchBuild = "cu128"
)

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$ttsDir = Join-Path $repoRoot "GPT-SoVITS"
$venvDir = Join-Path $ttsDir ".venv"
$python = Join-Path $venvDir "Scripts\python.exe"
$nltkDataDir = Join-Path $ttsDir "nltk_data"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is required but is not on PATH. Install uv, then rerun this command."
}

if (-not (Test-Path -LiteralPath $python)) {
    Write-Host "Creating an isolated Python 3.11 environment..."
    & uv venv --python 3.11 $venvDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the GPT-SoVITS Python environment."
    }
}

$torchIndex = "https://download.pytorch.org/whl/$TorchBuild"
Write-Host "Installing PyTorch ($TorchBuild)..."
& uv pip install --python $python torch torchaudio --index-url $torchIndex
if ($LASTEXITCODE -ne 0) {
    throw "PyTorch installation failed."
}

Write-Host "Installing GPT-SoVITS dependencies. This can take several minutes..."
& uv pip install --python $python -r (Join-Path $ttsDir "extra-req.txt") --no-deps
if ($LASTEXITCODE -ne 0) {
    throw "GPT-SoVITS extra dependency installation failed."
}
& uv pip install --python $python -r (Join-Path $ttsDir "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    throw "GPT-SoVITS dependency installation failed."
}

Write-Host "Installing the English text-to-phoneme data..."
New-Item -ItemType Directory -Path $nltkDataDir -Force | Out-Null
& $python -m nltk.downloader -d $nltkDataDir averaged_perceptron_tagger_eng
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install the NLTK English tagger required by GPT-SoVITS."
}

# Verify the resource actually landed on disk — the downloader can report
# success yet leave nltk_data/taggers empty if the download was interrupted.
$taggerDir = Join-Path $nltkDataDir "taggers\averaged_perceptron_tagger_eng"
if (-not (Test-Path -LiteralPath (Join-Path $taggerDir "english.pickle"))) {
    throw "NLTK download reported success but $taggerDir is missing its pickle. Re-run this setup, or run: $python -m nltk.downloader -d `"$nltkDataDir`" averaged_perceptron_tagger_eng"
}

Write-Host "Verifying the environment..."
$env:NLTK_DATA = $nltkDataDir
# Use a single-quoted here-string so PowerShell does not try to parse the
# Python brackets/quotes; the embedded NLTK tagger is exercised with
# NLTK_DATA exported, mirroring real runtime conditions.
$verifyPy = @'
import soundfile, torch, fastapi, pyopenjtalk
from nltk import pos_tag
pos_tag(['English'])
print(pyopenjtalk.run_frontend('こんにちは')[0])
print('GPT-SoVITS Japanese and English frontends are ready.')
'@
& $python -c $verifyPy
if ($LASTEXITCODE -ne 0) {
    throw "Environment verification failed."
}

Write-Host "Setup complete. Start the bot with .\start-bot.cmd"
