#!/usr/bin/env node
// Compare a Bergamot subtitle with a step-2 subtitle, and optionally with a
// human Arabic subtitle. Run:
//
//   node scripts/bench-step2.mjs <en.srt> <bergamot.srt> <quickmt.srt> [human.srt]
//
// The human subtitle usually has a different cue split, so it is aligned by
// timestamp overlap rather than by cue index.

import fs from 'node:fs';
import { parseSrt, cueText } from '../src/srt.mjs';
import { chrf } from '../src/step2.mjs';

const [enPath, basePath, quickPath, humanPath] = process.argv.slice(2);
if (!enPath || !basePath || !quickPath) {
    console.error('usage: bench-step2.mjs <en.srt> <bergamot.srt> <quickmt.srt> [human.srt]');
    process.exit(2);
}

const read = p => parseSrt(fs.readFileSync(p, 'utf8')).cues;
const en = read(enPath);
const base = read(basePath);
const quick = read(quickPath);
const human = humanPath ? read(humanPath) : null;

const TIME = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;
function span(timing) {
    const m = timing.match(TIME);
    if (!m) return null;
    const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const e = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    return [s, e];
}

function humanAt(s, e) {
    if (!human) return null;
    const parts = [];
    for (const cue of human) {
        const t = span(cue.timing);
        if (!t) continue;
        const overlap = Math.min(e, t[1]) - Math.max(s, t[0]);
        if (overlap > 0.2) parts.push(cueText(cue).trim());
    }
    return parts.length ? parts.join(' ') : null;
}

const n = Math.min(en.length, base.length, quick.length);
let changed = 0;
let aligned = 0;
let baseChrf = 0;
let quickChrf = 0;
const examples = [];

for (let i = 0; i < n; i++) {
    const a = cueText(base[i]).trim();
    const b = cueText(quick[i]).trim();
    if (a !== b) {
        changed++;
        if (examples.length < 15) {
            examples.push({ i, en: cueText(en[i]).trim(), base: a, quick: b });
        }
    }
    const t = span(base[i].timing);
    const h = t ? humanAt(t[0], t[1]) : null;
    if (h) {
        aligned++;
        baseChrf += chrf(a, h);
        quickChrf += chrf(b, h);
    }
}

console.log(JSON.stringify({
    cues: n,
    changed,
    changed_pct: +((changed / n) * 100).toFixed(1),
    human_aligned_cues: aligned,
    bergamot_chrf_vs_human: aligned ? +(baseChrf / aligned).toFixed(4) : null,
    quickmt_chrf_vs_human: aligned ? +(quickChrf / aligned).toFixed(4) : null,
    delta: aligned ? +((quickChrf - baseChrf) / aligned).toFixed(4) : null,
}, null, 2));

for (const e of examples) {
    console.log('\n--- cue', e.i + 1);
    console.log('EN     :', e.en.replace(/\n/g, ' | '));
    console.log('BERGA  :', e.base.replace(/\n/g, ' | '));
    console.log('QUICKMT:', e.quick.replace(/\n/g, ' | '));
}
