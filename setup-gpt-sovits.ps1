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
$kurisuModelDir = Join-Path $repoRoot "TTS-KurisuMakise"

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
& uv pip install --python $python huggingface_hub
if ($LASTEXITCODE -ne 0) {
    throw "Hugging Face download dependency installation failed."
}

$kurisuRequiredFiles = @(
    "牧懒红莉栖-e15.ckpt",
    "牧懒红莉栖_e4_s972.pth",
    "害羞示范.wav",
    "无奈.wav"
)
$missingKurisuFiles = @($kurisuRequiredFiles | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $kurisuModelDir $_))
})
if ($missingKurisuFiles.Count -gt 0) {
    Write-Host "Downloading the Kurisu Makise voice model from Hugging Face..."
    New-Item -ItemType Directory -Path $kurisuModelDir -Force | Out-Null
    $downloadKurisuModel = @'
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="bysq/TTS-KurisuMakise",
    local_dir=r"__MODEL_DIR__",
    allow_patterns=[
        "\u7267\u61d2\u7ea2\u8389\u6816-e15.ckpt",
        "\u7267\u61d2\u7ea2\u8389\u6816_e4_s972.pth",
        "\u5bb3\u7f9e\u793a\u8303.wav",
        "\u65e0\u5948.wav",
    ],
)
'@
    $downloadKurisuModel = $downloadKurisuModel.Replace("__MODEL_DIR__", $kurisuModelDir.Replace("\", "\\"))
    & $python -c $downloadKurisuModel
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to download bysq/TTS-KurisuMakise from Hugging Face."
    }
}

foreach ($requiredFile in $kurisuRequiredFiles) {
    $requiredPath = Join-Path $kurisuModelDir $requiredFile
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Kurisu model setup is incomplete: $requiredPath is missing."
    }
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

Write-Host "Setup complete, including the Kurisu voice model. Start the bot with .\start-bot.cmd"
