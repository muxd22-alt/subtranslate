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
}

if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exitCode = 1;
} else {
    console.log('\nall checks passed');
}
