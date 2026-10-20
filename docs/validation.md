# Translation validation

A translation is rejected when it is not actually Arabic, is only partly
translated, or was built from a source that does not cover the film. The check
runs after translation and before the final `.ar.tran.srt` is written. Rejected
runs exit `4`; `subgrab` keeps the candidate under
`$SUBGRAB_STATE/rejected/<name>.rejected`.

## Thresholds

| check | default | rejects |
|---|---|---|
| Arabic letter ratio | `0.88` | English passthrough, mostly-English output |
| Arabic cue ratio | `0.90` | half-translated files |
| English-only cue ratio | at most `0.10` | blocks of untouched English |
| source cue coverage | `0.85` | output missing many source cues |

The source cue coverage here compares Arabic cues in the output with
translatable source cues, capped at 100%.

## Five-movie calibration

Measured on the five complete Arabic outputs in the phone library:

| movie | output cues | Arabic by letter | Arabic cues | English-only cues |
|---|---:|---:|---:|---:|
| Buddy | 1501 | 0.9994 | 1.0000 | 0.0000 |
| By Any Means | 1391 | 0.9960 | 1.0000 | 0.0000 |
| Hopeu | 1419 | 0.9947 | 1.0000 | 0.0000 |
| Masterplan | 1662 | 0.9954 | 0.9988 | 0.0012 |
| Tenzing | 1328 | 0.9863 | 1.0000 | 0.0000 |

The defaults leave about a ten-point margin below the worst good result:
`0.88` against `0.9863`, `0.90` against `0.9988`, and `0.10` against `0.0012`.
The old placeholder threshold of `0.20` would have accepted a file with only a
fifth of its letters in Arabic; the fixtures in `tests/verify.mjs` fail it.

Cue-count and source-side checks matter too. Two of the library's current
English sidecars are incomplete (218 and 352 cues, against complete Arabic
outputs with 1662 and 1328 cues). That is why `subgrab` checks source coverage
before translating rather than trusting cue count alone.

## Source coverage

`subgrab` checks two things against the video duration:

1. the last source cue ends at least at `SUBGRAB_MIN_COVERAGE` (default `0.70`)
   of the runtime;
2. cue intervals cover at least `SUBGRAB_MIN_DIALOGUE` (default `0.15`) of the
   runtime.

The second check catches subtitles that end near the end but have large holes.
Measured source coverage:

| source | last cue | cue coverage |
|---|---:|---:|
| Buddy | 99.9% | 58.3% |
| By Any Means | 94.5% | 42.5% |
| Hopeu | 95.8% | 31.1% |
| Masterplan (partial) | 91.9% | 6.1% |
| Tenzing (partial) | 91.7% | 8.9% |

Both thresholds must pass. An incomplete local source is skipped, then an
embedded English track is tried, then a network download. A source that cannot
be checked because `ffprobe` is missing is allowed, and the reason is logged.
