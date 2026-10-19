# Model parallelism

subtranslate runs the translation model in `--workers` WASM worker threads.
This is where the speed comes from, and this file records the measurements
behind the defaults so they are not guesses.

## Engine

`@browsermt/bergamot-translator` (the engine behind Firefox Translations and
TranslateLocally) running the Mozilla **en→ar v2.2** model:

| file | size |
|---|---:|
| `model.enar.intgemm.alphas.bin` | 31,561,787 B |
| `lex.50.50.enar.s2t.bin` | 3,139,692 B |
| `vocab.enar.spm` | 863,591 B |
| **total** | **~34 MB** |

Quantised intgemm (`int8shiftAlphaAll`, the model's native precision), beam
size 1, `mini-batch-words: 1024`, `max-length-break: 128`.

## Throughput

240 subtitle cues, Samsung Z Fold 4 (8-core SoC, 6 cores usable), Termux,
Node 26, `~4.1 GB` RAM free:

| workers | wall time | cues/sec | speedup | notes |
|---:|---:|---:|---:|---|
| 1 | 60.8 s | 3.9 | 1.00× | |
| 2 | 34.8 s | 6.9 | 1.75× | |
| 3 | 23.5 s | 10.2 | 2.59× | |
| **4** | **20.9 s** | **11.5** | **2.91×** | **default** |
| 5 | 21.8 s | 11.0 | 2.80× | |
| 6 | 21.7 s | 11.0 | 2.80× | plateau |

Model load is ~4.5 s and is **flat in the number of workers** — the workers
load their copies concurrently.

### Why it plateaus

Each worker owns a private copy of the model, because the WASM heap is per
thread and the engine has no shared-memory path:

```
34 MB model  ×  workers   (+ ~30 MB WASM runtime per worker)
```

4 workers ≈ 260 MB. Beyond 4 the phone's 6 cores are saturated and the extra
threads only compete for cache. On a desktop with more cores and memory,
`--workers 8` scales further.

### Sizing a run

At the default `--workers 4`, a typical film (800–1200 cues) lands in
**80–110 s**, plus the one-off 4.5 s model load.

`--chunk` (default 200) only controls how many cues are submitted per wave. It
bounds peak memory and makes `progress n/m` show up in the log; it does not
change throughput.

## Method

The numbers above come from `bench.mjs`, kept in the development tree:

```js
const backing  = new LocalBacking({ pivotLanguage: null, downloadTimeout: 0 });
const translator = new BatchTranslator({ workers, batchSize: 8 }, backing);
await translator.translate({ from:'en', to:'ar', text:'Warm up.', html:false }); // load
const t = Date.now();
await Promise.all(lines.map(text =>
    translator.translate({ from:'en', to:'ar', text, html:false })));
```

Cache is off (`cacheSize` defaults to 0), so the figures are cold.

## Sentinel audit

The genre glossary works by masking a term out of the English source, e.g.

```
They called in an exorcism.   ->  They called in an XQ1QX.
اتصلوا في XQ1QX.              ->  اتصلوا في طرد الأرواح.
```

That only works if the sentinel survives the round trip. Six candidate formats
were tested on device:

| format | survives? | note |
|---|---|---|
| `⟦T1⟧` | no | split apart: `⟦ ⟦ ⟧` |
| `[[T1]]` | partial | dropped a bracket when two appeared in one line |
| `{{T1}}` | yes | |
| `<t1>` | yes | collides with subtitle markup |
| `XQT1QX` | **yes** | chosen |
| `⁣T1⁣` | yes | invisible characters, hard to debug |

`XQ{n}QX` was verified mid-sentence, sentence-final, inside quotes, three to a
line, and adjacent to Arabic punctuation — all intact.

## Why the glossary is so short

The first version of this glossary listed ~24 terms, each one chosen after
auditing the word **on its own**. That audit was misleading. Out of context the
model does badly; in a real sentence it is usually right:

| term | alone | in a sentence | verdict |
|---|---|---|---|
| zombie | غيبوبي ("narcotic") | واحد الزومبي سهل | base model wins |
| horde | — | الجحافل قادمة من البوابة | base model wins |
| medic | — | اتصل بالمسعف، إنه ينزف. | base model wins |
| possessed | مملوك ("owned") | كانت ممسوسة | base model wins |
| air strike | إضراب جوي ("labour strike") | الضربة الجوية | base model wins |
| launder | — | يغسلون الأموال | base model wins |

Masking is not free. The engine cannot inflect a sentinel, so it loses exactly
the information Arabic agreement depends on. With the sentinel left in place and
no restore at all, the damage is visible:

```
clean   Call a medic, he is bleeding.        ->  اتصل بالمسعف، إنه ينزف.        correct
sentin  Call a XQ1QX, he is bleeding.        ->  اتصل XQ1QX بـ XQ1QX إنه ينزف    duplicated + dangling

clean   One zombie is easy. A horde is not.  ->  واحد الزومبي سهل. حشد ليس كذلك.
sentin  One XQ1QX is easy. A XQ2QX is not.   ->  واحد XQ1QX سهل. A XQ2QX ليست كذلك.
                                                 ("A" untranslated, wrong gender)
```

So a term is kept only when **both** hold:

1. the base model's in-context rendering is wrong, and
2. masking still leaves a grammatical sentence.

Six terms passed that test:

| genre | term | base model, in context | curated |
|---|---|---|---|
| sci-fi | hyperdrive | اشرب محرك الأقراص الفائقة ("drink the CD-ROM drive") | المحرك الفائق |
| horror | exorcism | طرد الارتجاز / طرد الارتياد (not a word) | طرد الأرواح |
| horror | seance | كانوا يقيمون صناعا / بدأ التسلسل (not a seance) | استحضار الأرواح |
| fantasy | elf | القزم (that is a *dwarf*) | الإلف |
| fantasy | orc | العفاز / العفارات (not a word) | الأورك |
| crime | the mob | الغوغاء ("the rabble") | المافيا |

`war`, `romance` and `general` carry no terms at all — nothing survived.

The sentences in the two tables above are the ones actually used; the audit is
meant to be re-run, not trusted, when the model changes.

## The worker scheduler race

Long files crashed mid-run with:

```
TypeError: Cannot read properties of undefined (reading 'requests')
    at BatchTranslator.consumeBatch (node_modules/@browsermt/bergamot-translator/src/translator.js:585)
```

It is a race in the upstream scheduler. `notify()` awaits
`backing.loadWorker()` and then unconditionally does `queue.shift()`. When a
whole chunk of cues is enqueued at once several `notify()` callbacks run
concurrently; they all see "no idle worker, but room for one more" and each
starts loading a worker. By the time the later callbacks resume, the batches
have already been taken, so `queue.shift()` returns `undefined`.
`consumeBatch(undefined, …)` throws, and the library's own catch block then
dereferences `batch.requests` — an uncaught `TypeError` raised from a timer,
which kills the process part way through a film.

Reproduced on device: 24 cues (3 batches of 8) with 4 workers crashed; 16 cues
(2 batches) happened not to.

Rather than patch `node_modules`, [src/engine.mjs](../src/engine.mjs) subclasses
`BatchTranslator` and returns early for the empty case. The worker stays idle
and usable, and the next real batch loads it as usual.

## Re-running the audit after a model upgrade

If Mozilla ships a newer en→ar model, repeat the audit before trusting the
glossary:

```sh
node scripts/audit-terms.mjs   # "term | model output | curated" for every genre
```

Any row where the model output now equals the curated term should be deleted
from the glossary.

## Acceptance test

```sh
node verify.mjs
```

Three checks, on device:

1. **structure** — a fixture containing `<i>` markup, a `{\an8}` position tag,
   extra timing text on the timing line and a `♪♪` cue is translated and
   re-parsed; cue count, indices, timing lines and the line count *inside* each
   cue must all be identical.
2. **load** — 300 cues in one run must not crash the worker scheduler.
3. **glossary** — the kept terms must actually appear in the Arabic output.

Last run on the Z Fold 4: all checks passed, `300/300 in 6.3s (47.9 cues/s)`.
