# `@proj-airi/stage-ui-live2d`

Shared Vue and Pixi rendering support for Live2D scenes in AIRI's web,
Electron, and pocket applications.

## Use this package for

- Rendering imported Live2D model ZIPs.
- Model previews, motion playback, expressions, focus, blink, and lip sync.
- Validating and caching Cubism 2 and Cubism 3+ model archives.

Do not use it for VRM, MMD, Spine, or static character images; those formats
have separate stage renderers.

## Importing models

Each ZIP must contain exactly one model entry point and all paths referenced by
that manifest:

```text
character-model.zip
└── character-model/
    ├── model.json          # Cubism 2
    └── data/
        ├── model.moc
        ├── physics.json
        ├── textures/
        ├── motions/
        └── expressions/
```

Cubism 3 and newer archives use `.model3.json`, `.moc3`, `.motion3.json`, and
`.exp3.json`. Keep the original relative paths and filename casing when
creating the ZIP.

Models are user-provided content. Do not add third-party model archives to
this repository or AIRI release artifacts unless their redistribution terms
explicitly permit it.

## Enabling Cubism 2

Cubism 2 requires the discontinued proprietary `live2d.min.js` Web core.
AIRI does not download or redistribute this file. A maintainer-approved copy
can be supplied to every app build with:

```powershell
$env:AIRI_CUBISM2_CORE_PATH = 'C:\path\to\live2d.min.js'
$env:AIRI_CUBISM2_CORE_SHA256 = '<approved-sha256>'
pnpm -F @proj-airi/stage-web dev
```

Both variables are required. The build plugin verifies the SHA-256, serves the
core in development, and emits it as `assets/js/live2d.min.js` in production.
Without these variables, Cubism 3+ behavior is unchanged and Cubism 2 imports
receive an actionable validation warning.

The core remains subject to the
[Live2D SDK license](https://www.live2d.com/en/sdk/license/) and is not covered
by AIRI's MIT license.

## Packaging a Bestdori download tree

`bestdori-live2d-downloader` writes `<character>/<model>/model.json` plus a
`data/` directory per model. `scripts/build-dori-zips.ts` turns that tree into one
importable archive per model:

```shell
node_modules/.bin/tsx packages/stage-ui-live2d/scripts/build-dori-zips.ts \
  --src <download-tree> --out apps/stage-web/public/dori
```

For each model it wraps the files in a `<character>_<model>/` folder, validates the
result with `validateLive2DZip`, and writes `index.json`. The output directory is
gitignored; the archives are third-party assets.

`index.json` is a preset manifest that `useDisplayModelsStore` fetches on startup,
so every packaged model shows up in the model selector without being imported by
hand. A checkout without the directory is unaffected.

The rewritten `model.json` keeps every original motion group and adds the
emotion-named groups AIRI plays from LLM emotion tags (`Idle`, `Happy`, `Sad`,
`Angry`, `Think`, `Surprise`, `Awkward`, `Question`, `Curious`), aliasing the
existing `.mtn` files. Alternate-persona families (`mts_`, `maskon_`/`maskoff`) and
`_ingameV2` variants are deliberately left out of those groups so an emotion never
swaps the character's appearance. The run reports any model that cannot fill all
nine.

Cubism 2 models carry no SDK `hit_areas` (Bestdori writes a non-standard
`hit_areas_custom`), so tap interaction is unavailable for them.

## Verification

```shell
pnpm -F @proj-airi/stage-ui-live2d exec vitest run
pnpm -F @proj-airi/stage-ui-live2d typecheck
```

