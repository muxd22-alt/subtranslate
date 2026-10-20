# subtranslate

Offline English to Arabic subtitle translation on device.

## Before / After

English:
```
Hello world.
```
Arabic:
```
مرحبا بالعالم.
```

## Quick start

```
npm install -g subtranslate
subtranslate examples/hello.en.srt "Hello"
```

## Install

Termux / Linux / WSL:
```
git clone https://github.com/muxd22-alt/subtranslate.git
cd subtranslate
npm install
npm link
```

Or via npm:
```
npm install -g subtranslate
```

## Commands

| Command | Purpose |
|---|---|
| subtranslate | Translate an English SRT to Arabic |
| subtr | Find and translate a movie subtitle |
| subfind | Download a subtitle next to a video |
| subsync-en | Re-time an English subtitle |

`subtranslate --help` prints the same table.

## File and folder layouts

Good movie tree:
```
Movies/Movie (2010)/Movie (2010).en.srt -> Movie (2010).ar.tran.srt
```
Good TV tree:
```
TV/Show/Season 1/Show.s01e01.en.srt -> Show.s01e01.ar.tran.srt
```
Bad movie tree:
```
Movies/Movie (2010)/Movie (2010).ar.sub.srt  (human track; never overwritten)
```
Bad TV tree:
```
TV/Show/Season 1/Show.s01e01.srt  (untagged; still becomes .ar.tran.srt)
```

## Recipes

Translate one file:
```
subtranslate movie.en.srt "Movie Title"
```

## Output and exit codes

- `.en.srt` -> `.ar.tran.srt`
- untagged `.srt` -> `.ar.tran.srt`
- `.eng.forced` normalized to one `.ar.tran.srt`
- explicit `--out` wins
- `.ar.sub.srt` is the human track; `.ar.tran.srt` is machine translation only
- Exit code 4 = validator rejection; use `--reject-out` to keep rejected output.

## Troubleshooting

- Missing model: run `subtranslate --fetch-model`.
- Validator rejection: inspect with `--reject-out`.

## Guarantees, speed, validator

- Offline, on device, no network after model download.
- Validator guards against English passthrough and incomplete translations.

## Self-contained automation recipe

```
subtranslate movie.en.srt "Movie Title" --json --quiet
```

## Licence

MIT
