# subtranslate

Offline **English → Arabic** subtitle translation, on device.

Point it at an English `.srt` and the movie's title; it writes `Movie.ar.srt`
next to it so Jellyfin, Plex, Kodi or VLC pick it up automatically. Nothing is
uploaded anywhere: the translation model runs locally.

```sh
subtranslate "Movie (2010).en.srt" "Movie (2010)"
# -> Movie (2010).ar.srt
```

Built in the spirit of [subliminal](https://github.com/Diaoul/subliminal):
standalone, scriptable, and meant to be pointed at a folder.

---

## Why a genre glossary instead of a prompt

The engine underneath is Mozilla's
[Bergamot](https://github.com/browsermt/bergamot-translator) / Marian, the same
translator that ships in Firefox. It is fast, tiny and fully offline — but it
takes **no free-text context**, so you cannot hand it a paragraph about the film
and expect the word choice to follow.

What it *does* let us control is terminology. subtranslate infers a genre from
the movie title ("Zombie", "Dawn of the Dead" → horror; "Alien", "Dune",
"Interstellar" → sci-fi), then uses a curated **terminology glossary** for that
genre. Terms are masked out of the English source, the rest of the sentence is
translated normally, and the curated Arabic term is substituted back in.

```
                 ┌─────────────────────────────┐
  Movie Title ──▶│ inferGenre()                │──▶ sci-fi
                 └─────────────────────────────┘
                 ┌─────────────────────────────┐
  English cue ──▶│ maskTerms()  "hyperdrive"   │──▶ "Engage the XQ1QX now."
                 └─────────────────────────────┘
                              │
                              ▼  Bergamot, N worker threads
                 "الاشتباط XQ1QX الآن."
                              │
                 ┌─────────────────────────────┐
                              ▼  restoreTerms()
                 "الاشتباط المحرك الفائق الآن."
```

If a term survives as a mangled sentinel, that cue is re-translated plainly, so
a glossary miss can never make things worse than no glossary at all.

The list is deliberately short: it only holds terms the base model gets **wrong**
in real dialogue. Masking a word the model already knows makes the sentence
*worse*, because the model no longer sees the real word and falls back to
default agreement. Only six terms survived that test — the audit, with the
sentences it used, is in [docs/model-parallelism.md](docs/model-parallelism.md).

Use your own terms any time — they merge on top of the genre list:

```sh
subtranslate "Dune.en.srt" "Dune" --glossary ./dune-terms.json
```

```json
{ "spice": "التابل", "the sleeper must awaken": "النائم يجب أن يستيقظ" }
```

---

## Install

Requires Node 18+.

**Termux (Android)**

```sh
pkg install nodejs-lts
git clone <this repo> && cd subtranslate
sh install.sh
```

**Anywhere else**

```sh
npm install -g subtranslate
subtranslate --fetch-model
```

The en→ar model (~34 MB, MPL-2.0) is downloaded once from Mozilla's public CDN
into `~/.local/share/subtranslate/models/en-ar/`. After that, subtranslate never
touches the network.

---

## Usage

```
subtranslate <english.srt> "<Movie Title>" [options]

  --out <path>        write here instead of <Movie>.ar.srt next to the input
  --genre <name>      force a genre         (general, sci-fi, horror, fantasy,
                                             crime, war, romance)
  --glossary <file>   extra terms: {"english": "عربي", ...}
  --workers <n>       worker threads        (default 4)
  --chunk <n>         cues per wave         (default 200)
  --model-dir <path>  where the model lives
  --overwrite         re-translate even if the .ar.srt exists
  --dry-run           parse and translate, write nothing
  --json              machine readable summary on stdout
  --quiet             warnings and errors only
  --fetch-model       download the model, then exit
```

### Guarantees

| | |
|---|---|
| **Structure preserved** | cue indices, timing lines, cue order and the line breaks *inside* a cue are copied through untouched. Only the text changes. |
| **Idempotent** | if `Movie.ar.srt` already exists and is non-empty, the run is a no-op. |
| **Atomic** | the file is written to a temp name and renamed, so a crash never leaves a half-written subtitle. |
| **Never loses a cue** | if a single cue cannot be translated it is kept in English and counted in the log, rather than being dropped or emitted as an empty line. |
| **Retries** | a failed run exits non-zero and leaves no output, so a scheduled retry is safe. |

Encoding is UTF-8 in, UTF-8 out (a BOM is preserved if present). Convert
Windows-1256 subtitles first: `iconv -f WINDOWS-1256 -t UTF-8 in.srt > out.srt`.

---

## Speed

Measured on a 6-core Android phone (Samsung Z Fold 4, Termux), 240 subtitle
cues:

| workers | cues/sec | speedup | notes |
|---:|---:|---:|---|
| 1 | 3.9 | 1.0× | |
| 2 | 6.9 | 1.8× | |
| 3 | 10.2 | 2.6× | |
| **4** | **11.5** | **2.9×** | **default** |
| 5 | 11.0 | 2.8× | |
| 6 | 11.0 | 2.8× | plateau, more RAM |

Roughly a **full-length film in 80–100 seconds**, plus ~4.5 s once to load the
model. Scaling flattens after 4 workers because the phone has 6 cores and each
worker loads its own 34 MB copy of the model. `--workers 4` is a good default
for phones; on a desktop try 6–8.

---

## Running it over a library

subtranslate has no opinion about *where* English subtitles come from. Pair it
with any subtitle downloader:

```sh
#!/bin/sh
# for every movie in the library
find /path/to/movies -name '*.srt' ! -name '*.ar.srt' | while read -r en; do
    ar="${en%.srt}.ar.srt"
    [ -f "$ar" ] && continue
    subtranslate "$en" "$(basename "${en%.srt}")" || true
done
```

A worked example with `subliminal`, cron and Jellyfin is in
[termux-media-stack](https://github.com/muxd22-alt/termux-media-stack) — that
repo wires this into a fully automatic pipeline on an Android phone.

---

## Troubleshooting

**`Model is incomplete`** — run `subtranslate --fetch-model`.

**`require is not defined in ES module scope`** — the upstream bergamot package
ships a CommonJS worker inside a `"type": "module"` package. `scripts/postinstall.mjs`
patches this on install; re-run `npm install` if you wiped `node_modules`.

**`Cannot read properties of undefined (reading 'requests')`** — a race in the
upstream worker scheduler, triggered by long files with several workers. Already
worked around in [src/engine.mjs](src/engine.mjs); see
[docs/model-parallelism.md](docs/model-parallelism.md#the-worker-scheduler-race).

**Arabic renders as boxes in the terminal** — a font issue, not a data issue.
The file itself is UTF-8.

**Subtitles are out of sync** — that is a timing problem, not a translation one.
Fix it with [ffsubsync](https://github.com/smacke/ffsubsync) first.

---

## Licence

MIT. The en→ar model is MPL-2.0, © Mozilla.
