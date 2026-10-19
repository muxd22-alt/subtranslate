// Acceptance test. Run on device: `node verify.mjs`
//
//   1. structure  -- indices, timings and in-cue line counts survive translation
//   2. load       -- a long file does not crash the worker scheduler
//   3. glossary   -- the pruned genre terms land in the output
//
// Exits non-zero on the first failure.

import { parseSrt, serializeSrt } from './src/srt.mjs';
import { Engine } from './src/engine.mjs';
import { GENRES } from './src/glossary.mjs';
import { translateDocument } from './src/cli.mjs';

// One run only ever uses one genre, but the fixture exercises all of them.
const ALL_TERMS = Object.assign({}, GENRES.horror.terms, GENRES['sci-fi'].terms, GENRES.fantasy.terms);

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
    if (!ok) failures++;
}

const FIXTURE = `1
00:00:01,000 --> 00:00:03,000
One zombie is easy. A horde is not.

2
00:00:04,000 --> 00:00:07,000 X1:100 X2:200
<i>The possessed girl whispered a name.</i>

3
00:00:08,000 --> 00:00:11,000
They called in an exorcism.
It failed.

4
00:00:12,000 --> 00:00:14,000
{\\an8}Engage the hyperdrive now.

5
00:00:15,000 --> 00:00:17,000
♪♪

6
00:00:18,000 --> 00:00:21,000
An elf and an orc made peace.
`;

const engine = new Engine({ workers: 4 });
await engine.start();

// ---- 1. structure -------------------------------------------------------
const doc = parseSrt(FIXTURE);
const before = doc.cues.map(c => ({ index: c.index, timing: c.timing, lines: c.lines.length }));
const stats = await translateDocument(doc, { engine, terms: ALL_TERMS, chunk: 8 });
const out = serializeSrt(doc);
const re = parseSrt(out);

check('cue count preserved', re.cues.length === before.length, `${before.length} -> ${re.cues.length}`);
let structural = true;
re.cues.forEach((c, i) => {
    const b = before[i];
    if (c.index !== b.index) { structural = false; console.log(`   index ${b.index} -> ${c.index}`); }
    if (c.timing !== b.timing) { structural = false; console.log(`   timing ${b.timing} -> ${c.timing}`); }
    if (c.lines.length !== b.lines) { structural = false; console.log(`   cue ${c.index} lines ${b.lines} -> ${c.lines.length}`); }
});
check('indices, timings and line counts identical', structural);
check('non-textual cue kept as-is', re.cues[4].lines.join('') === '♪♪', JSON.stringify(re.cues[4].lines));

console.log(`\n--- translated document (${stats.translated}/${stats.total} cues, ${stats.kept} kept) ---`);
console.log(out.trimEnd());
console.log('--- end ---\n');

// ---- 2. load ------------------------------------------------------------
const MANY = 300;
const stamp = s => {
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss},000`;
};
const lines = [];
for (let i = 1; i <= MANY; i++) {
    lines.push(String(i), `${stamp(i * 3)} --> ${stamp(i * 3 + 2)}`,
        i % 3 === 0 ? 'An elf and an orc marched north. They called in an exorcism.' : 'The possessed girl whispered a name.',
        '');
}
const big = parseSrt(lines.join('\n'));
const t0 = Date.now();
const bigStats = await translateDocument(big, { engine, terms: GENRES.fantasy.terms, chunk: 200 });
const secs = (Date.now() - t0) / 1000;
check(`parsed the ${MANY}-cue fixture`, big.cues.length === MANY, `parsed ${big.cues.length}`);
check(`survived ${MANY} cues without crashing`, bigStats.translated === MANY,
    `${bigStats.translated}/${MANY} in ${secs.toFixed(1)}s (${(MANY / secs).toFixed(1)} cues/s)`);

// ---- 3. glossary --------------------------------------------------------
const arabic = re.cues.map(c => c.lines.join(' ')).join('\n');
check('glossary term "exorcism" present', arabic.includes('طرد الأرواح'));
check('glossary term "hyperdrive" present', arabic.includes('المحرك الفائق'));
check('glossary term "elf"/"orc" present', arabic.includes('الإلف') && arabic.includes('الأورك'));

await engine.stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
