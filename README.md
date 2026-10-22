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
subtranslate --fetch-model
subtranslate examples/hello.en.srt "Hello"
```

The model is ~34 MB and is fetched once. After that everything runs offline.

## Install

Termux:
```
pkg install nodejs-lts git
git clone https://github.com/muxd22-alt/subtranslate.git
cd subtranslate
sh install.sh
```

Linux / WSL:
```
git clone https://github.com/muxd22-alt/subtranslate.git
cd subtranslate
sh install.sh
```

`install.sh` installs the dependencies, fetches the model, links `subtranslate`
and puts `subfind`, `subsync-en`, `subtr` and `subqwen` into `$PREFIX/bin`.

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
| subqwen | Fix a translated Arabic subtitle with a local LLM |

`subtranslate --help` prints the same table.

## subqwen: the second pass

The translator is fast and free, but it is a small model: it gets the gender
wrong, it transliterates names nobody recognises and it writes every film in
the same flat voice. `subqwen` re-reads the result with the English source
and a small local model, and fixes only what is really wrong.

```
subqwen refine Movie.2026.mkv          # fix Movie.2026.ar.tran.srt
subqwen refine Movie.2026.mkv --dry-run # write a report, change nothing
subqwen brief Movie.2026.mkv            # show the movie brief it would use
subqwen doctor --live                   # check the setup and the model
```

What it does:

- It never changes a cue number, a timing or a line break. Only the text of a
  cue is rewritten, and only when the rewrite passes a mechanical gate:
  mostly Arabic, no leftover Latin except known names, no lost italics, no
  changed numbers, at most two lines and about 42 characters per line.
- It keeps the raw translation at `~/.cache/subgrab/raw/<hash>.srt`, so a
  refinement can always be undone.
- It drops the sound only cues ("(gunshot)", "sighs", "Ugh"), because a
  professional subtitle has no stage directions in it.
- It puts the tool name in the first four seconds, without touching the
  timings of the other cues.
- It gives the model a short brief about the film: title, genres, a tone line
  and the main characters with their gender. The gender comes from the
  metadata provider and is never guessed.

Where the brief comes from, in order:

| Provider | Key | Movies | TV | Cast gender |
|---|---|---|---|---|
| TMDB | `~/.config/subgrab/tmdb-key` | yes | yes | yes |
| TVmaze | none | no | yes | yes |
| Cinemeta | none | yes | yes | no |
| the .nfo next to the video | none | yes | yes | no |

The model is `llama-server` from llama.cpp, bound to 127.0.0.1. It is started
when a job needs it and stopped again when it goes idle. Point it at a model
with `REFINE_MODEL_DIR` (default `~/models`); `Qwen3.5-0.8B` Q4_K_M is enough.

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
