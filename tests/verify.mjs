// Model-free checks. Run with `npm test` or `node tests/verify.mjs`.
//
// These cover the parts that must keep working on every platform: output
// naming, atomic writes, progress streams and the POSIX wrappers. The model
// itself is exercised by the existing `verify.mjs` on device.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { outPathFor } from '../src/paths.mjs';
import { translateDocument } from '../src/translate.mjs';
import { writeAtomic } from '../src/atomic.mjs';
import { Progress, formatDuration } from '../src/progress.mjs';
import { validateTranslation, formatValidation } from '../src/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let failures = 0;

async function check(name, fn) {
    try {
        const detail = await fn();
        console.log(`PASS  ${name}${detail ? `  -- ${detail}` : ''}`);
    } catch (err) {
        failures++;
        console.log(`FAIL  ${name}  -- ${err.message}`);
    }
}

await check('output name: .en.srt -> .ar.tran.srt', () => {
    assert.equal(outPathFor('Movie (2010).en.srt'), 'Movie (2010).ar.tran.srt');
});

await check('output name: eng.forced -> one .ar.tran', () => {
    assert.equal(outPathFor('Movie.eng.forced.srt'), 'Movie.ar.tran.srt');
});

await check('output name: untagged .srt', () => {
    assert.equal(outPathFor('/movies/Dune.srt'), '/movies/Dune.ar.tran.srt');
});

await check('output name: existing .ar.sub is not doubled', () => {
    assert.equal(outPathFor('Dune.ar.sub.srt'), 'Dune.ar.tran.srt');
});

await check('output name: explicit --out wins', () => {
    assert.equal(outPathFor('Dune.en.srt', '/tmp/x.srt'), '/tmp/x.srt');
});

await check('formatDuration', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(65), '1m5s');
    assert.equal(formatDuration(3725), '1h2m');
});

await check('atomic write replaces in one step and leaves no .part', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtranslate-atomic-'));
    const file = path.join(dir, 'Movie.ar.tran.srt');
    writeAtomic(file, 'first\n');
    writeAtomic(file, 'second\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'second\n');
    const left = fs.readdirSync(dir).filter(n => n.includes('.part'));
    assert.deepEqual(left, []);
});

await check('JSON progress emits first and final events', () => {
    const lines = [];
    const original = process.stdout.write;
    process.stdout.write = chunk => { lines.push(String(chunk)); return true; };
    try {
        const p = new Progress({ json: true, quiet: false, enabled: false });
        p.start(10);
        p.update(4, 10);
        p.finish();
    } finally {
        process.stdout.write = original;
    }
    const events = lines.map(l => JSON.parse(l));
    assert.equal(events[0].event, 'progress');
    assert.equal(events.at(-1).final, true);
    assert.equal(events.at(-1).percent, 100);
});

await check('quiet progress writes nothing', () => {
    const out = [];
    const err = [];
    const so = process.stdout.write;
    const se = process.stderr.write;
    process.stdout.write = c => { out.push(String(c)); return true; };
    process.stderr.write = c => { err.push(String(c)); return true; };
    try {
        const p = new Progress({ json: true, quiet: true, enabled: true });
        p.start(3);
        p.update(2, 3);
        p.finish();
    } finally {
        process.stdout.write = so;
        process.stderr.write = se;
    }
    assert.deepEqual(out, []);
    assert.deepEqual(err, []);
});

await check('translateDocument reports monotonic progress', async () => {
    const doc = {
        cues: [
            { index: 1, timing: '00:00:01,000 --> 00:00:02,000', lines: ['One.'] },
            { index: 2, timing: '00:00:03,000 --> 00:00:04,000', lines: ['Two.'] },
        ],
    };
    const seen = [];
    const engine = {
        async translateMany(texts, { onProgress } = {}) {
            for (let i = 0; i < texts.length; i++) {
                onProgress?.(i + 1, texts.length);
            }
            return texts.map(() => 'مرحبا');
        },
    };
    await translateDocument(doc, { engine, terms: {}, chunk: 10, onProgress: (d, t) => seen.push([d, t]) });
    assert.deepEqual(seen, [[0, 2], [1, 2], [2, 2]]);
});

const docOf = texts => ({ cues: texts.map((text, i) => ({ index: String(i + 1), timing: '', lines: [text] })) });
const English = ['Hello there.', 'How are you?', 'We leave tonight.', 'The train is late.'];
const Arabic = ['مرحبا بك.', 'كيف حالك؟', 'نرحل الليلة.', 'القطار متأخر.'];

await check('validator accepts a complete Arabic translation', () => {
    const r = validateTranslation(docOf(English), docOf(Arabic));
    assert.equal(r.ok, true, r.reasons.join('; '));
    assert.equal(r.metrics.arabicCueRatio, 1);
    assert.equal(r.metrics.sourceCueCoverage, 1);
});

await check('validator accepts Arabic with a few Latin names', () => {
    const mixed = ['مرحبا FBI.', 'كيف حالك؟', 'نرحل الليلة.', 'القطار متأخر.'];
    const r = validateTranslation(docOf(English), docOf(mixed));
    assert.equal(r.ok, true, r.reasons.join('; '));
});

await check('validator rejects English passthrough', () => {
    const r = validateTranslation(docOf(English), docOf(English));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some(x => x.includes('Arabic letter ratio')), r.reasons.join('; '));
    assert.ok(r.reasons.some(x => x.includes('English-only cue ratio')), r.reasons.join('; '));
});

await check('validator rejects a half-translated file', () => {
    const half = [...Arabic.slice(0, 2), ...English.slice(2)];
    const r = validateTranslation(docOf(English), docOf(half));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some(x => x.includes('Arabic cue ratio')), r.reasons.join('; '));
});

await check('validator rejects a source that was only partly translated', () => {
    const r = validateTranslation(docOf(English), docOf(Arabic.slice(0, 2)));
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some(x => x.includes('source cue coverage')), r.reasons.join('; '));
});

await check('validator rejects an empty output', () => {
    const r = validateTranslation(docOf(English), docOf([]));
    assert.equal(r.ok, false);
    assert.match(formatValidation(r), /arabic=0.0%/);
});

if (process.platform !== 'win32') {
    await check('shell wrappers parse', () => {
        for (const file of ['bin/subfind', 'bin/subsync-en', 'bin/subtr', 'lib/wrappers.sh']) {
            const r = spawnSync('sh', ['-n', path.join(ROOT, file)], { encoding: 'utf8' });
            assert.equal(r.status, 0, `${file}: ${r.stderr}`);
        }
    });

    await check('subfind names a downloaded Arabic subtitle .ar.sub.srt', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtranslate-find-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(dir, 'Movie.2026.1080p.mkv'), '');
        const fake = path.join(bin, 'subliminal');
        fs.writeFileSync(fake, `#!/bin/sh
d=
while [ $# -gt 0 ]; do
    case "$1" in
        -d) d=$2; shift 2 ;;
        *) shift ;;
    esac
done
printf '1\\n00:00:01,000 --> 00:00:02,000\\nمرحبا\\n' > "$d/Movie.ar.srt"
`);
        fs.chmodSync(fake, 0o755);

        const r = spawnSync('sh', [path.join(ROOT, 'bin', 'subfind'), path.join(dir, 'Movie.2026.1080p.mkv')], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        });
        assert.equal(r.status, 0, r.stderr);
        const target = path.join(dir, 'Movie.2026.1080p.ar.sub.srt');
        assert.ok(fs.existsSync(target), 'target missing');
        assert.match(fs.readFileSync(target, 'utf8'), /مرحبا/);
    });

    await check('subsync-en writes through a temp file and keeps the name', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtranslate-sync-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const video = path.join(dir, 'Movie.2026.mkv');
        const en = path.join(dir, 'Movie.2026.en.srt');
        fs.writeFileSync(video, '');
        fs.writeFileSync(en, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
        const fake = path.join(bin, 'ffsubsync');
        fs.writeFileSync(fake, `#!/bin/sh
in=
out=
while [ $# -gt 0 ]; do
    case "$1" in
        -i) in=$2; shift 2 ;;
        -o) out=$2; shift 2 ;;
        *) shift ;;
    esac
done
cp "$in" "$out"
`);
        fs.chmodSync(fake, 0o755);
        const r = spawnSync('sh', [path.join(ROOT, 'bin', 'subsync-en'), video], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(en, 'utf8'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
        assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.part')), []);
    });

    await check('subsync-en honors --out for an .srt input', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtranslate-sync-out-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        const input = path.join(dir, 'Movie.en.srt');
        const output = path.join(dir, 'Movie.synced.srt');
        const ref = path.join(dir, 'ref.ar.srt');
        const original = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
        fs.writeFileSync(input, original);
        fs.writeFileSync(ref, original);
        const fake = path.join(bin, 'ffsubsync');
        fs.writeFileSync(fake, `#!/bin/sh
in=
out=
while [ $# -gt 0 ]; do
    case "$1" in
        -i) in=$2; shift 2 ;;
        -o) out=$2; shift 2 ;;
        *) shift ;;
    esac
done
cp "$in" "$out"
`);
        fs.chmodSync(fake, 0o755);
        const r = spawnSync('sh', [
            path.join(ROOT, 'bin', 'subsync-en'),
            '--ref', ref,
            '--out', output,
            input,
        ], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(input, 'utf8'), original);
        assert.equal(fs.readFileSync(output, 'utf8'), original);
    });
}

await check('docs: README has no placeholders', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(!/<this repo>/i.test(readme), 'placeholder <this repo> found');
    assert.ok(!/TODO/i.test(readme), 'TODO found');
});

await check('docs: index.html has no external requests', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(!/<script[^>]+src=["']https?:\/\//i.test(html), 'external script');
    assert.ok(!/<link[^>]+href=["']https?:\/\//i.test(html), 'external stylesheet');
});

if (process.platform !== 'win32') {
    await check('docs: documented commands respond to --help', () => {
        const js = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'subtranslate.js'), '--help'], { encoding: 'utf8' });
        assert.equal(js.status, 0, js.stderr);
        for (const file of ['bin/subfind', 'bin/subsync-en', 'bin/subtr']) {
            const r = spawnSync('sh', [path.join(ROOT, file), '--help'], { encoding: 'utf8' });
            assert.equal(r.status, 0, `${file}: ${r.stderr}`);
        }
    });
}

await check('docs: quick-start fixture exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'examples', 'hello.en.srt')));
});

if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exitCode = 1;
} else {
    console.log('\nall checks passed');
}
