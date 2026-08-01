## Verdict

**Yes—a publicly downloadable, natively compatible GPT-SoVITS model for Makise Kurisu already exists.**

The strongest verified match is **`bysq/TTS-KurisuMakise`** on Hugging Face. It was uploaded on **November 22, 2025**, identifies itself as a **GPT-SoVITS v2Pro** model, supports Japanese and Chinese, and contains the two files expected for GPT-SoVITS inference:

* `牧懒红莉栖-e15.ckpt` — GPT semantic model, approximately 155 MB
* `牧懒红莉栖_e4_s972.pth` — SoVITS acoustic model, approximately 135 MB

The Chinese filename appears to contain `懒` rather than the usual `濑`, but those are the repository’s actual filenames. ([Hugging Face][1])

### Compatibility assessment: **High confidence**

This is not merely an RVC model that happens to use a `.pth` extension. The official GPT-SoVITS code recognizes:

* `GPT_weights_v2Pro/*.ckpt`
* `SoVITS_weights_v2Pro/*.pth`

The repository supplies exactly that `.ckpt` + `.pth` pairing and explicitly identifies the model as v2Pro. The current GPT-SoVITS project supports v2Pro and documents its required pretrained components. ([GitHub][2])

## Important limitation

I could **not verify that it was trained specifically on material from both *Steins;Gate* and *Steins;Gate 0***.

The model card does not document:

* Which games, anime episodes, drama CDs, or other recordings were used
* Whether *Steins;Gate 0* is included
* Dataset duration or number of utterances
* Segmentation and denoising methods
* Training settings beyond the resulting checkpoint names
* A benchmark or independent quality comparison

Neither “Steins;Gate 0” nor “SG0” appears in the published repository description. There are sample WAV files and a larger collection of `crs_...` audio clips, but their origin and relationship to the training set are not explained. The repository also has no public community reviews or discussions, so voice fidelity and stability remain unverified until you test it yourself. ([Hugging Face][3])

My confidence assessment is therefore:

| Question                                 | Assessment                                    |
| ---------------------------------------- | --------------------------------------------- |
| Can GPT-SoVITS load it?                  | **Very likely yes**                           |
| Is it a genuine GPT-SoVITS pair?         | **Yes, based on format and v2Pro labeling**   |
| Does it represent Makise Kurisu?         | **Claimed by the uploader; samples provided** |
| Does it include both S;G and S;G 0 data? | **Unknown**                                   |
| Is the quality better than retraining?   | **Must be tested**                            |
| Is its dataset provenance documented?    | **No**                                        |

## Where to place the files

With a current GPT-SoVITS installation, the layout should be:

```text
GPT-SoVITS/
├── GPT_weights_v2Pro/
│   └── 牧懒红莉栖-e15.ckpt
└── SoVITS_weights_v2Pro/
    └── 牧懒红莉栖_e4_s972.pth
```

You should also install the official **v2Pro pretrained dependencies**, including the v2Pro SoVITS generator/discriminator assets and the speaker-verification checkpoint described by GPT-SoVITS. Then launch the WebUI and select the two Kurisu weights. ([GitHub][4])

## File verification

The Hugging Face file records report these SHA-256 hashes:

```text
牧懒红莉栖-e15.ckpt
43b33267a84853056ab1df047d747b6e2c774ca10e4d95809d05c1fe7540d478

牧懒红莉栖_e4_s972.pth
6d97085ec9373dacf0aa6a35656e264466cbc31bc891dbb51e6e585c9093a21c
```

You can verify them after downloading:

```bash
sha256sum "牧懒红莉栖-e15.ckpt"
sha256sum "牧懒红莉栖_e4_s972.pth"
```

Hugging Face’s inspection found ordinary PyTorch-related pickle imports in the `.ckpt` and no problematic pickle imports in the `.pth`. Nevertheless, model checkpoints are executable serialization formats, so loading them inside a separate Python environment or container is prudent. ([Hugging Face][5])

## Other Kurisu models I found

They are useful alternatives or source leads, but **they are not directly compatible with GPT-SoVITS**.

| Model                                           | Technology                  |              GPT-SoVITS compatible? | Notes                                                                                    |
| ----------------------------------------------- | --------------------------- | ----------------------------------: | ---------------------------------------------------------------------------------------- |
| `bysq/TTS-KurisuMakise`                         | GPT-SoVITS v2Pro            |                             **Yes** | Best existing match                                                                      |
| `xuanyaox/TTS-KurisuMakise`                     | GPT-SoVITS v2Pro            |              **Yes, but duplicate** | Recent mirror of the `bysq` repository                                                   |
| `Codename0/Makise_Kurisu_RVC-V2-48khz_e540-535` | RVC v2                      |                              **No** | About 14–15 minutes of VN and drama-CD material; voice conversion, not TTS               |
| `FrancescoCaracciolo/Kurisu-RVC`                | RVC                         |                              **No** | Voice changer trained from Japanese VN audio                                             |
| `Loke-60000/christina-TTS`                      | Qwen3-TTS                   |                              **No** | Kurisu-inspired synthetic voice; explicitly not presented as Asami Imai’s official voice |
| `FrancescoCaracciolo/Amadeus`                   | One-shot GPT-SoVITS project | **Not a published fine-tuned pair** | Includes reference-audio workflow and related resources                                  |

The RVC models use a `.pth` model plus an `.index` file. Despite the `.pth` suffix, they cannot be placed in `SoVITS_weights_v2Pro` and paired with a GPT `.ckpt`; their architecture and inference workflow are different. ([Hugging Face][6])

I also found a Chinese post advertising approximately **2,905 complete Kurisu voice clips** for RVC/VITS-related training. That may be a corpus lead if you ultimately retrain, but it is presented as audio material rather than a ready GPT-SoVITS checkpoint, and its provenance and redistribution permissions should be checked independently. ([Bilibili][7])

## Recommendation

Test the existing **v2Pro checkpoint pair first** before assembling a new dataset. Use several Japanese reference clips covering:

* Kurisu’s ordinary conversational voice
* Irritated or tsundere delivery
* Quiet or vulnerable speech
* Longer technical sentences
* *Steins;Gate 0*-style subdued or emotionally restrained delivery

Pay particular attention to whether it captures the tonal difference between the original series and *Steins;Gate 0*. Because the training sources are undocumented, it may reproduce a general Kurisu voice while performing poorly on the more restrained S;G 0 delivery.

Across publicly indexed GitHub, Hugging Face, ModelScope and voice-model listings, this was the **only independent, verifiable native GPT-SoVITS Kurisu checkpoint pair I found**; the other results were a duplicate mirror, RVC models, a Qwen3-TTS recreation, datasets, or one-shot inference projects. Private Discord, cloud-drive and unindexed community releases may still exist.

[1]: https://huggingface.co/bysq/TTS-KurisuMakise "bysq/TTS-KurisuMakise · Hugging Face"
[2]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/config.py "GPT-SoVITS/config.py at main · RVC-Boss/GPT-SoVITS · GitHub"
[3]: https://huggingface.co/bysq/TTS-KurisuMakise/blob/main/README.md "README.md · bysq/TTS-KurisuMakise at main"
[4]: https://github.com/RVC-Boss/GPT-SoVITS "GitHub - RVC-Boss/GPT-SoVITS: 1 min voice data can also be used to train a good TTS model! (few shot voice cloning) · GitHub"
[5]: https://huggingface.co/bysq/TTS-KurisuMakise/blob/main/%E7%89%A7%E6%87%92%E7%BA%A2%E8%8E%89%E6%A0%96-e15.ckpt "牧懒红莉栖-e15.ckpt · bysq/TTS-KurisuMakise at main"
[6]: https://huggingface.co/xuanyaox/TTS-KurisuMakise/tree/2f4df06fba634262b4ed30e93ebd1c2371a3b151/WAV?utm_source=chatgpt.com "apache-2.0"
[7]: https://www.bilibili.com/video/BV1XV4y117NY/?utm_source=chatgpt.com "【RVC,VITS通用】AI语音_模型训练_素材处理流程讲解_附牧濑 ..."
