# Recommended setup

Use GPT-SoVITS as the **complete TTS engine**:

```text
AIRI
  │  OpenAI-compatible /v1/audio/speech
  ▼
Local AIRI adapter — 127.0.0.1:9000
  │  Native GPT-SoVITS /tts
  ▼
GPT-SoVITS API — 127.0.0.1:9880
  ├── trained GPT checkpoint:   .ckpt
  ├── trained SoVITS checkpoint: .pth
  ├── reference audio:           3–10 seconds
  └── exact reference transcript
```

AIRI’s merged `main` branch currently has no native GPT-SoVITS provider. A dedicated provider pull request exists, including reference-audio and model-switching settings, but it remains open as of July 28, 2026. AIRI’s merged OpenAI-compatible speech provider therefore remains the safer integration point. ([GitHub][1])

[Download the AIRI GPT-SoVITS bridge](sandbox:/mnt/data/airi-gpt-sovits-bridge.zip)

## Important compatibility warning

The Kurisu RVC files from the previous setup:

```text
KurisuRVCv147.pth
KurisuRVCv147.index
```

are **not GPT-SoVITS models**. GPT-SoVITS needs a matched pair resembling:

```text
something-e15.ckpt    ← GPT/Text2Semantic model
something_e8_sXXX.pth ← SoVITS acoustic model
```

Although both systems use `.pth`, their architectures and checkpoint contents are unrelated. GPT-SoVITS’s inference configuration explicitly loads one Text2Semantic `.ckpt` and one SoVITS `.pth`. ([GitHub][2])

Your trained GPT and SoVITS files should come from the same training project and model generation: v1, v2, v2Pro, v2ProPlus, v3, or v4. Mixing arbitrary generations can cause shape errors, wrong token mappings, missing vocoders, or bad output. The SoVITS loader detects its model family, but the GPT model also relies on the configured version during initialization. ([GitHub][3])

---

# Part 1: Install GPT-SoVITS for RTX 5060 Ti

These steps assume Windows 11 and PowerShell.

## 1. Install prerequisites

Install:

* Current NVIDIA driver
* Git
* Miniconda or Miniforge
* PowerShell 7, which provides `pwsh`
* FFmpeg, although the GPT-SoVITS installer can also install it through Conda

Check:

```powershell
nvidia-smi
git --version
conda --version
pwsh --version
```

The official project currently supports a `CU128` Windows installation option and lists Python 3.11, PyTorch 2.7, and CUDA 12.8 among its tested environments. The installation script retrieves PyTorch from the official `cu128` wheel repository. This is the correct branch for an RTX 50-series Blackwell GPU. ([GitHub][4])

## 2. Clone the repository

```powershell
New-Item -ItemType Directory -Force C:\AI
Set-Location C:\AI

git clone --recurse-submodules https://github.com/RVC-Boss/GPT-SoVITS.git
Set-Location C:\AI\GPT-SoVITS
```

## 3. Create an isolated environment

Follow the project’s Windows installation path:

```powershell
conda create -n GPTSoVits python=3.10 -y
conda activate GPTSoVits

Set-ExecutionPolicy -Scope Process Bypass

pwsh -F .\install.ps1 --Device CU128 --Source HF
```

The installer downloads the required pretrained models and language-processing assets in addition to the CUDA 12.8 PyTorch packages. UVR5 is not needed merely for inference, so omit `--DownloadUVR5`. ([GitHub][4])

If Hugging Face access is unusually slow, retry with:

```powershell
pwsh -F .\install.ps1 --Device CU128 --Source HF-Mirror
```

## 4. Verify actual CUDA execution

Do more than check `torch.cuda.is_available()`. Allocate a real tensor:

```powershell
python -c "import torch; print('PyTorch:', torch.__version__); print('CUDA runtime:', torch.version.cuda); print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0)); x=torch.ones(1024,1024,device='cuda'); print('GPU tensor result:', x.mean().item())"
```

Expected essentials:

```text
CUDA available: True
GPU: NVIDIA GeForce RTX 5060 Ti
GPU tensor result: 1.0
```

There should be no warning that `sm_120` is unsupported.

---

# Part 2: Arrange the trained model files

Create a dedicated voice directory:

```powershell
New-Item -ItemType Directory -Force C:\AI\GPT-SoVITS\voices\kurisu
```

Put the files here:

```text
C:\AI\GPT-SoVITS\voices\kurisu\
├── kurisu-gpt.ckpt
├── kurisu-sovits.pth
├── reference.wav
└── reference.txt
```

You may rename the checkpoints for convenience. Their extensions must remain correct.

Typical training output locations are version-specific folders such as:

```text
GPT_weights_v2\
SoVITS_weights_v2\
```

The folder or training configuration from which the checkpoints came is the most reliable way to determine their generation.

## Which version should you select?

Use the version that produced your trained pair:

```text
Model source                    version value
------------------------------------------------
GPT_weights / SoVITS_weights    v1, for old v1 training
GPT_weights_v2 / ..._v2         v2
v2Pro training/export           v2Pro
v2ProPlus training/export       v2ProPlus
v3 training/export              v3
v4 training/export              v4
```

Do not label a v2 model as v4 merely to request higher-quality output. The version controls architecture and vocoder selection, not just a quality preset.

Current upstream documentation describes v3/v4 as more faithful to the reference audio than v2, while v4 corrects a possible metallic artifact in v3 and produces native 48 kHz output. The newer v2Pro families are intended to provide high similarity with hardware requirements closer to v2. These distinctions matter when choosing a training version, but an already-trained model should simply be loaded with its original generation. ([GitHub][5])

---

# Part 3: Prepare the reference audio

## Hard requirements

The current inference code resamples the reference to 16 kHz for semantic extraction and rejects references shorter than 48,000 samples or longer than 160,000 samples. That corresponds to an enforced duration of **3–10 seconds**. Stereo files are converted to mono internally, but supplying a clean mono WAV avoids ambiguity. ([GitHub][3])

A practical target is:

```text
Duration:     5–8 seconds
Speakers:     exactly one
Background:   no music or sound effects
Reverb:       minimal
Clipping:     none
Speech:       continuous, clearly pronounced
Format:       mono PCM WAV
Transcript:   exact, including spoken words
```

GPT-SoVITS advertises zero-shot inference from approximately five seconds of reference speech, while fine-tuned checkpoints add information learned from the training dataset. ([GitHub][6])

## Trim and convert the reference

Choose a clean interval from your source audio:

```powershell
ffmpeg `
  -ss 00:00:12.500 `
  -i "C:\path\to\source-audio.wav" `
  -t 6 `
  -ac 1 `
  -ar 32000 `
  -c:a pcm_s16le `
  "C:\AI\GPT-SoVITS\voices\kurisu\reference.wav"
```

Inspect its duration:

```powershell
ffprobe `
  -v error `
  -show_entries format=duration `
  -of default=noprint_wrappers=1:nokey=1 `
  C:\AI\GPT-SoVITS\voices\kurisu\reference.wav
```

Do not leave several seconds of silence at either end. The 3–10 second check is based on file duration, not speech-only duration.

## Create the exact transcript

Put the exact spoken sentence in:

```text
C:\AI\GPT-SoVITS\voices\kurisu\reference.txt
```

For example:

```text
これから説明することを、よく覚えておきなさい。
```

Do not add words that are not actually spoken. Preserve meaningful particles and sentence endings.

For v3/v4-style inference, an empty prompt transcript is explicitly rejected. For other versions it can sometimes be omitted, but an exact transcript normally produces more stable linguistic conditioning. ([GitHub][3])

## Reference emotion matters

The reference is not just a speaker-identity sample:

* A calm reference tends to produce stable conversational speech.
* An angry reference can bias generated lines toward a stronger, sharper delivery.
* A whispery reference can reduce energy and clarity.
* A highly emotional clip can be useful for that emotion but less versatile for ordinary AIRI dialogue.

This influence is particularly strong in v3/v4, which upstream describes as being more faithful to reference-audio timbre and delivery than v2. ([GitHub][5])

---

# Part 4: Test the model in the WebUI first

Before involving AIRI or an API bridge, confirm that the model pair itself works.

From the repository root:

```powershell
Set-Location C:\AI\GPT-SoVITS
conda activate GPTSoVits

python .\webui.py
```

In the inference interface:

1. Select your trained GPT `.ckpt`.
2. Select your trained SoVITS `.pth`.
3. Choose `reference.wav`.
4. Paste the exact reference transcript.
5. Set the reference language, probably `Japanese`.
6. Enter a short target sentence.
7. Set target language to Japanese or automatic.
8. Generate audio.

Use a target such as:

```text
クリスティーナではない。牧瀬紅莉栖よ。
```

Do not proceed until WebUI inference works. This separates checkpoint/reference problems from API and AIRI integration problems.

---

# Part 5: Configure the native GPT-SoVITS API

GPT-SoVITS provides an official `api_v2.py` server. It binds to `127.0.0.1:9880` by default and accepts a TTS configuration file with `-c`. ([GitHub][7])

There are two valid model-loading methods.

## Method A: Custom startup configuration

This is the best permanent configuration because the desired checkpoints are loaded once during startup.

Copy the original configuration:

```powershell
Set-Location C:\AI\GPT-SoVITS

Copy-Item `
  .\GPT_SoVITS\configs\tts_infer.yaml `
  .\GPT_SoVITS\configs\tts_infer_airi.yaml
```

Open it:

```powershell
notepad .\GPT_SoVITS\configs\tts_infer_airi.yaml
```

Replace the `custom:` section at the beginning. Example for a v2 pair:

```yaml
custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cuda
  is_half: true
  t2s_weights_path: C:/AI/GPT-SoVITS/voices/kurisu/kurisu-gpt.ckpt
  version: v2
  vits_weights_path: C:/AI/GPT-SoVITS/voices/kurisu/kurisu-sovits.pth
```

Use forward slashes in YAML paths.

Change:

```yaml
version: v2
```

to the exact family that produced your pair when necessary:

```yaml
version: v3
```

or:

```yaml
version: v4
```

The version is especially important in this startup configuration because the inference class loads the GPT checkpoint before the SoVITS checkpoint. The SoVITS loader can subsequently detect and update the version, but the GPT model has already used the configured token mapping by then. ([GitHub][3])

Start the service:

```powershell
python .\api_v2.py `
  -a 127.0.0.1 `
  -p 9880 `
  -c .\GPT_SoVITS\configs\tts_infer_airi.yaml
```

Keep this terminal open.

## Method B: Dynamically switch checkpoints

This is useful when testing several pairs or when you are unsure about the startup YAML.

First launch with the official configuration:

```powershell
python .\api_v2.py `
  -a 127.0.0.1 `
  -p 9880 `
  -c .\GPT_SoVITS\configs\tts_infer.yaml
```

Then, from another activated PowerShell terminal, load **SoVITS first**:

```powershell
Invoke-WebRequest `
  -Uri "http://127.0.0.1:9880/set_sovits_weights?weights_path=C%3A%2FAI%2FGPT-SoVITS%2Fvoices%2Fkurisu%2Fkurisu-sovits.pth"
```

Then load GPT:

```powershell
Invoke-WebRequest `
  -Uri "http://127.0.0.1:9880/set_gpt_weights?weights_path=C%3A%2FAI%2FGPT-SoVITS%2Fvoices%2Fkurisu%2Fkurisu-gpt.ckpt"
```

Loading SoVITS first is the safer dynamic order because its loader detects the checkpoint family and updates the inference configuration; the GPT checkpoint is then loaded under that detected version. The official API exposes both switching endpoints. ([GitHub][3])

The supplied AIRI bridge performs this dynamic loading order automatically at startup.

---

# Part 6: Test the native API

The native `/tts` endpoint requires:

* `text`
* `text_lang`
* `ref_audio_path`
* `prompt_lang`

It also accepts `prompt_text` and sampling, splitting, speed, streaming, seed, and output-format options. ([GitHub][7])

Run this in another PowerShell window:

```powershell
$body = @{
  text = "クリスティーナではない。牧瀬紅莉栖よ。"
  text_lang = "ja"

  ref_audio_path = "C:/AI/GPT-SoVITS/voices/kurisu/reference.wav"
  prompt_text = "Paste the exact Japanese transcript here."
  prompt_lang = "ja"

  top_k = 15
  top_p = 1.0
  temperature = 1.0

  text_split_method = "cut5"
  batch_size = 1
  speed_factor = 1.0

  seed = 1234
  repetition_penalty = 1.35

  media_type = "wav"
  streaming_mode = $false
  parallel_infer = $true

  sample_steps = 32
  super_sampling = $false
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri "http://127.0.0.1:9880/tts" `
  -Method POST `
  -ContentType "application/json; charset=utf-8" `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
  -OutFile "C:\AI\GPT-SoVITS\native-test.wav"
```

Play:

```text
C:\AI\GPT-SoVITS\native-test.wav
```

The official endpoint directly supports `wav`, raw PCM, OGG, and AAC. It does not expose the OpenAI `/v1/audio/speech` route, and it does not natively offer MP3 through this endpoint. The bridge requests WAV and uses FFmpeg when AIRI asks for MP3, FLAC, Opus, AAC, or PCM. ([GitHub][7])

---

# Part 7: Install the AIRI bridge

Download and extract:

[Download the AIRI GPT-SoVITS bridge](sandbox:/mnt/data/airi-gpt-sovits-bridge.zip)

Extract it into the repository root so you get:

```text
C:\AI\GPT-SoVITS\airi_bridge\
├── gpt_sovits_openai_bridge.py
├── requirements.txt
├── start_gpt_sovits_api.ps1
├── start_bridge.ps1
├── test_native_api.ps1
├── test_openai_bridge.ps1
├── tts_infer_custom_block.example.yaml
└── README.txt
```

Install its small dependency set in the existing GPT-SoVITS environment:

```powershell
Set-Location C:\AI\GPT-SoVITS
conda activate GPTSoVits

pip install -r .\airi_bridge\requirements.txt
```

## Edit the bridge configuration

Open:

```powershell
notepad .\airi_bridge\start_bridge.ps1
```

Edit these four values:

```powershell
$env:GSV_GPT_WEIGHTS    = "C:\AI\GPT-SoVITS\voices\kurisu\kurisu-gpt.ckpt"
$env:GSV_SOVITS_WEIGHTS = "C:\AI\GPT-SoVITS\voices\kurisu\kurisu-sovits.pth"
$env:GSV_REF_AUDIO      = "C:\AI\GPT-SoVITS\voices\kurisu\reference.wav"
$env:GSV_PROMPT_TEXT    = "The exact transcript spoken in reference.wav."
```

For Japanese reference speech:

```powershell
$env:GSV_PROMPT_LANG = "ja"
```

For target output, choose one:

```powershell
# Japanese, with embedded English handling
$env:GSV_TEXT_LANG = "ja"
```

or:

```powershell
# Automatic multilingual segmentation
$env:GSV_TEXT_LANG = "auto"
```

Version 1 supports Chinese, Japanese, and English language modes. Version 2 and later add Korean and Cantonese modes, including `ko`, `yue`, and expanded automatic segmentation. ([GitHub][3])

## Start the services

### Terminal 1: GPT-SoVITS

```powershell
Set-Location C:\AI\GPT-SoVITS
conda activate GPTSoVits

python .\api_v2.py `
  -a 127.0.0.1 `
  -p 9880 `
  -c .\GPT_SoVITS\configs\tts_infer_airi.yaml
```

### Terminal 2: Bridge

```powershell
Set-Location C:\AI\GPT-SoVITS
conda activate GPTSoVits

Set-ExecutionPolicy -Scope Process Bypass
.\airi_bridge\start_bridge.ps1
```

At startup the bridge:

1. Validates the reference and checkpoint files.
2. Connects to `api_v2.py`.
3. Loads the trained SoVITS checkpoint.
4. Loads the trained GPT checkpoint.
5. Exposes OpenAI-compatible routes on port `9000`.
6. Serializes inference requests to avoid overlapping calls into one local pipeline.

## Test the bridge

```powershell
.\airi_bridge\test_openai_bridge.ps1
```

The result should be:

```text
C:\AI\GPT-SoVITS\airi-bridge-test.mp3
```

Check its model endpoint:

```powershell
Invoke-RestMethod "http://127.0.0.1:9000/v1/models"
```

You should see:

```json
{
  "object": "list",
  "data": [
    {
      "id": "kurisu-gpt-sovits-tts"
    }
  ]
}
```

The `tts` substring is intentional: AIRI’s current OpenAI-compatible speech provider filters `/v1/models` results and retains only model IDs containing `tts`. Its compatible provider currently returns no discoverable voice list, so the voice may need to be entered manually. ([GitHub][1])

---

# Part 8: Configure AIRI

Open AIRI’s provider settings and select:

```text
Speech provider: OpenAI Compatible
```

Enter:

```text
Base URL: http://127.0.0.1:9000/v1/
API Key:  sk-local
Model:    kurisu-gpt-sovits-tts
Voice:    kurisu
```

Then select that provider/model under AIRI’s vocalization or speech body-module settings.

The API key is only a placeholder for AIRI’s configuration validation. The supplied bridge does not authenticate it. Keep both services bound to `127.0.0.1`; do not expose ports `9000` or `9880` to your LAN or the internet without adding authentication. The official API defaults to one worker and a localhost bind address. ([GitHub][7])

Use non-streaming generation initially. GPT-SoVITS supports multiple streaming modes, but the adapter deliberately obtains one complete WAV before returning an OpenAI-compatible response. The native API defines modes 0–3, trading response behavior and quality, but AIRI integration is simpler and more predictable with streaming disabled. ([GitHub][7])

---

# Recommended inference settings

## Stable conversational baseline

```powershell
$env:GSV_TOP_K = "15"
$env:GSV_TOP_P = "1.0"
$env:GSV_TEMPERATURE = "1.0"
$env:GSV_REPETITION_PENALTY = "1.35"
$env:GSV_TEXT_SPLIT_METHOD = "cut5"
$env:GSV_BATCH_SIZE = "1"
$env:GSV_SEED = "1234"
$env:GSV_SAMPLE_STEPS = "32"
$env:GSV_SUPER_SAMPLING = "false"
```

These mostly match current API defaults. ([GitHub][7])

## More variation between lines

```powershell
$env:GSV_SEED = "-1"
```

## More repeatable voice behavior

```powershell
$env:GSV_SEED = "1234"
```

A fixed seed makes comparisons between reference clips and parameter changes easier.

## Faster v3/v4 inference

```powershell
$env:GSV_SAMPLE_STEPS = "8"
```

Upstream describes 32 steps as best quality and 4 or 8 steps as faster options. Sampling steps mainly matter to the v3/v4-style diffusion-based SoVITS path. ([GitHub][5])

## Best v3/v4 quality

```powershell
$env:GSV_SAMPLE_STEPS = "32"
```

## Japanese-only AIRI persona

```powershell
$env:GSV_PROMPT_LANG = "ja"
$env:GSV_TEXT_LANG = "ja"
```

## Japanese and English mixed output

```powershell
$env:GSV_PROMPT_LANG = "ja"
$env:GSV_TEXT_LANG = "auto"
```

Try `ja` first when most dialogue is Japanese. Automatic segmentation is more flexible, but explicit Japanese handling can be more predictable for short lines containing character names or occasional English words.

---

# Troubleshooting

## `sm_120 is not compatible with the current PyTorch installation`

The wrong PyTorch build was installed.

Inside the GPT-SoVITS environment:

```powershell
conda activate GPTSoVits

pip uninstall -y torch torchvision torchaudio torchcodec
pip cache purge

pip install torch torchcodec `
  --index-url https://download.pytorch.org/whl/cu128
```

Then repeat the GPU tensor test. The official installer’s CU128 path uses this same PyTorch index. ([GitHub][8])

## `参考音频在3~10秒范围外`

The reference file is outside the enforced 3–10 second duration.

Check:

```powershell
ffprobe `
  -v error `
  -show_entries format=duration `
  -of default=noprint_wrappers=1:nokey=1 `
  C:\AI\GPT-SoVITS\voices\kurisu\reference.wav
```

Trim it to about six seconds.

## `prompt_text cannot be empty when using SoVITS_V3`

Set:

```powershell
$env:GSV_PROMPT_TEXT = "Exact transcript of the reference recording."
```

This requirement is enforced by the current v3/v4 vocoder path. ([GitHub][3])

## `ref_audio_path ... not exists`

The path is interpreted by the GPT-SoVITS process, not by AIRI.

Use an absolute path:

```text
C:/AI/GPT-SoVITS/voices/kurisu/reference.wav
```

Do not send a browser-style file URL or an AIRI-relative path. The inference code verifies the path with the local filesystem before caching the reference. ([GitHub][3])

## Checkpoint shape mismatch or token-index error

Most likely causes:

* GPT and SoVITS checkpoints are not a matched pair.
* `version:` in the custom YAML is wrong.
* A v1 GPT checkpoint is being combined with v2/v3/v4 SoVITS.
* A LoRA checkpoint is missing its required pretrained base model.
* One file came from a different GPT-SoVITS fork.

Return to the WebUI and verify the pair there. Then check the original training folders and configuration rather than guessing the version.

## Output is the right person but wrong emotion

Change the reference audio, not only the sampling parameters.

Maintain several references:

```text
reference-neutral.wav
reference-happy.wav
reference-serious.wav
reference-annoyed.wav
```

Each needs its own exact transcript. Point `GSV_REF_AUDIO` and `GSV_PROMPT_TEXT` to the desired pair before starting the bridge.

## Repeated words or missing phrases

Try:

```powershell
$env:GSV_REPETITION_PENALTY = "1.40"
$env:GSV_SEED = "1234"
```

Also verify:

* Target text has punctuation.
* Reference transcript is exact.
* Reference audio contains no interruptions.
* The GPT checkpoint is paired with the intended SoVITS checkpoint.

Change one setting at a time.

## Metallic v3 output

Confirm that the model really is v3 rather than a mislabeled checkpoint. Upstream specifically attributes one metallic-artifact issue to v3’s non-integer upsampling and states that v4 corrects it. The proper solution is a corresponding v4 model/export, not relabeling a v3 checkpoint as v4. ([GitHub][5])

## CUDA out of memory

Stop the previous RVC and Kokoro services from the earlier setup:

```powershell
docker stop kokoro-airi
```

Close any RVC API process and monitor:

```powershell
nvidia-smi -l 1
```

AIRI’s local language model may also consume substantial VRAM. GPT-SoVITS should remain in half precision:

```yaml
device: cuda
is_half: true
```

The 16 GB GPU is suitable for local inference, but simultaneous GPT-SoVITS, a larger local LLM, games, image generation, and browser GPU workloads can still exceed available memory.

## Security warning for downloaded models

Only load checkpoints from sources you trust. The GPT checkpoint loader currently uses `torch.load(..., weights_only=False)`, meaning a malicious checkpoint can potentially execute Python reconstruction logic during loading. ([GitHub][3])

---

# Final startup checklist

```text
1. NVIDIA driver current
2. GPTSoVits Conda environment active
3. CUDA tensor test passes
4. Matching GPT .ckpt and SoVITS .pth identified
5. Reference audio is 3–10 seconds
6. Reference transcript is exact
7. WebUI inference works
8. api_v2.py runs on 127.0.0.1:9880
9. AIRI bridge runs on 127.0.0.1:9000
10. AIRI uses http://127.0.0.1:9000/v1/
11. Model ID is kurisu-gpt-sovits-tts
12. Voice is kurisu
```

[Download the prepared GPT-SoVITS-to-AIRI bridge](sandbox:/mnt/data/airi-gpt-sovits-bridge.zip)

[1]: https://raw.githubusercontent.com/moeru-ai/airi/main/packages/stage-ui/src/stores/providers.ts "https://raw.githubusercontent.com/moeru-ai/airi/main/packages/stage-ui/src/stores/providers.ts"
[2]: https://raw.githubusercontent.com/RVC-Boss/GPT-SoVITS/main/GPT_SoVITS/configs/tts_infer.yaml "https://raw.githubusercontent.com/RVC-Boss/GPT-SoVITS/main/GPT_SoVITS/configs/tts_infer.yaml"
[3]: https://raw.githubusercontent.com/RVC-Boss/GPT-SoVITS/main/GPT_SoVITS/TTS_infer_pack/TTS.py "https://raw.githubusercontent.com/RVC-Boss/GPT-SoVITS/main/GPT_SoVITS/TTS_infer_pack/TTS.py"
[4]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/README.md?plain=1 "https://github.com/RVC-Boss/GPT-SoVITS/blob/main/README.md?plain=1"
[5]: https://github.com/RVC-Boss/GPT-SoVITS/wiki/GPT%E2%80%90SoVITS%E2%80%90v3v4%E2%80%90features-%28%E6%96%B0%E7%89%B9%E6%80%A7%29 "https://github.com/RVC-Boss/GPT-SoVITS/wiki/GPT%E2%80%90SoVITS%E2%80%90v3v4%E2%80%90features-%28%E6%96%B0%E7%89%B9%E6%80%A7%29"
[6]: https://github.com/RVC-Boss/GPT-SoVITS "https://github.com/RVC-Boss/GPT-SoVITS"
[7]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py "https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py"
[8]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/install.ps1 "https://github.com/RVC-Boss/GPT-SoVITS/blob/main/install.ps1"
