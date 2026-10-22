// Fixture tests for the Qwen refine stage.
//
// Run with:  node tests/qwen.mjs
//
// Nothing here touches the network or a real model. The llama server is a
// tiny HTTP server in this process that answers with a scripted JSON, so the
// whole pipeline is exercised the way it runs on a phone, minus the phone.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { config } from '../src/qwen-config.mjs';
import { checkCue } from '../src/qwen-gate.mjs';
import { soundOnly } from '../src/qwen-sounds.mjs';
import { parseMediaInfo, findEnglishSource, cleanTitle } from '../src/qwen-media.mjs';
import { parseModelJson, stripThinking } from '../src/qwen-server.mjs';
import { tmdbGender, toneFor, loadGlossary, buildBrief } from '../src/qwen-brief.mjs';
import { buildSystemPrompt } from '../src/qwen-prompt.mjs';
import { refineOne, alignCues, dropSoundCues, isTrivial } from '../src/qwen.mjs';
import { addWatermark, ensureWatermarkFile } from '../src/watermark.mjs';
import { parseSrt, serializeSrt } from '../src/srt.mjs';

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

const EN_SRT = `1
00:00:01,000 --> 00:00:03,000
Helen, are you coming?

2
00:00:04,000 --> 00:00:06,000
(gunshot)

3
00:00:07,000 --> 00:00:09,000
I said I would handle it.
`;

const AR_SRT = `1
00:00:01,000 --> 00:00:03,000
هلن، هل أنت آcoming؟

2
00:00:04,000 --> 00:00:06,000
(طلقة نارية)

3
00:00:07,000 --> 00:00:09,000
قلت أنني سأتولى ذلك.
`;

/** A llama-server stand-in. The script turns a request into an answer. */
function startFakeServer(script) {
    const requests = [];
    const server = http.createServer((req, res) => {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const request = JSON.parse(body);
            requests.push(request);
            const content = script(request);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
        });
    });
}

const editsAnswer = edits => JSON.stringify({ edits });

await check('media: a movie in a Movies folder', () => {
    const info = parseMediaInfo('/lib/Movies/Masterplan (2026) [1080p]/Masterplan.2026.1080p.x264.mp4');
    assert.equal(info.title, 'Masterplan');
    assert.equal(info.year, 2026);
    assert.equal(info.kind, 'movie');
});

await check('media: an episode in a season folder', () => {
    const info = parseMediaInfo('/lib/TV/Break Bad/Season 1/Break.Bad.S01E02.1080p.mkv');
    assert.equal(info.title, 'Break Bad');
    assert.equal(info.season, 1);
    assert.equal(info.episode, 2);
    assert.equal(info.kind, 'tv');
});

await check('media: a loose folder', () => {
    const info = parseMediaInfo('/lib/Bad Apples 2025 1080p WEB-DL/Bad Apples 2025 1080p.mkv');
    assert.equal(info.title, 'Bad Apples');
    assert.equal(info.year, 2025);
});

await check('media: the title loses the release noise', () => {
    assert.equal(cleanTitle('Masterplan.2026.1080p.WEBRip.x264.AAC5.1'), 'Masterplan');
});

await check('media: the English source is found next to the video', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subqwen-media-'));
    const base = path.join(dir, 'Movie.2026');
    fs.writeFileSync(`${base}.mkv`, '');
    fs.writeFileSync(`${base}.en.srt`, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
    assert.equal(findEnglishSource(base), `${base}.en.srt`);
    fs.rmSync(dir, { recursive: true, force: true });
});

await check('gate: accepts a gender fix', () => {
    const r = checkCue('هلن، هل أنت آcoming؟', 'هلن، هل أنت قادمة؟', new Set());
    assert.equal(r.ok, true, r.reason);
});

await check('gate: accepts a glossary name', () => {
    const r = checkCue('سألت Alice', 'سألت Alice', new Set(['alice']));
    assert.equal(r.ok, true, r.reason);
});

await check('gate: rejects an unknown Latin word', () => {
    const r = checkCue('سألت Alice', 'سألت Bob', new Set(['alice']));
    assert.equal(r.ok, false);
});

await check('gate: rejects an explanation', () => {
    const r = checkCue('مرحبا', 'الترجمة: مرحبا', new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects a thinking block', () => {
    const r = checkCue('مرحبا', '<think>hmm</think> مرحبا', new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects English passthrough', () => {
    const r = checkCue('مرحبا', 'Hello there', new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects more lines than the original', () => {
    const r = checkCue('سطر واحد', 'سطر أول\nسطر ثان', new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects lost italics', () => {
    const r = checkCue('<i>استمع</i>', 'استمع', new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects a lost music note', () => {
    const r = checkCue('♪ موسيقى ♪', 'موسيقى', new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects a lost speaker dash', () => {
    const r = checkCue('- قال ذلك', 'قال ذلك', new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects changed numbers', () => {
    const r = checkCue('عام 2026', 'عام 2025', new Set());
    assert.equal(r.ok, false);
});

await check('gate: Arabic-Indic digits are the same numbers', () => {
    const r = checkCue('عام ٢٠٢٦', 'عام 2026', new Set());
    assert.equal(r.ok, true, r.reason);
});

await check('gate: rejects a line that is too long', () => {
    const r = checkCue('جملة', 'ا'.repeat(90), new Set());
    assert.equal(r.ok, false);
});

await check('gate: rejects an empty line', () => {
    const r = checkCue('جملة', '   ', new Set());
    assert.equal(r.ok, false);
});

await check('sounds: a bracketed cue is a sound', () => {
    assert.equal(soundOnly('(gunshot)'), true);
    assert.equal(soundOnly('[door creaks]'), true);
});

await check('sounds: a bare interjection is a sound', () => {
    assert.equal(soundOnly('Ugh.'), true);
    assert.equal(soundOnly('sighs'), true);
});

await check('sounds: a sentence is dialogue', () => {
    assert.equal(soundOnly('Are you coming?'), false);
    assert.equal(soundOnly('سألت أليس'), false);
});

await check('sounds: the sound cues are dropped from the Arabic', () => {
    const english = parseSrt(EN_SRT);
    const arabic = parseSrt(AR_SRT);
    const { cues, count } = dropSoundCues(arabic.cues, english);
    assert.equal(count, 1);
    assert.equal(cues.length, 2);
    assert.match(cues[0].lines.join('\n'), /هلن/);
});

await check('answer: a plain answer', () => {
    const { edits, error } = parseModelJson(editsAnswer([{ i: 1, ar: 'مرحبا' }]));
    assert.equal(error, null);
    assert.deepEqual(edits, [{ i: 1, ar: 'مرحبا' }]);
});

await check('answer: a fenced answer', () => {
    const { edits, error } = parseModelJson('```json\n' + editsAnswer([{ i: 2, ar: 'مرحبا' }]) + '\n```');
    assert.equal(error, null);
    assert.equal(edits[0].i, 2);
});

await check('answer: a truncated answer is salvaged', () => {
    const { edits, error } = parseModelJson('{"edits": [{"i": 3, "ar": "مرحبا"}, {"i": 4, "ar": "وداعا"}');
    assert.equal(error, null);
    assert.equal(edits[0].i, 3);
});

await check('answer: a thinking block is stripped', () => {
    assert.equal(stripThinking('<think>hmm</think>  ok'), 'ok');
    const { edits, error } = parseModelJson('<think>hmm</think>' + editsAnswer([{ i: 5, ar: 'مرحبا' }]));
    assert.equal(error, null);
    assert.equal(edits[0].i, 5);
});

await check('answer: garbage is an error', () => {
    const { edits, error } = parseModelJson('لا يوجد شيء هنا');
    assert.notEqual(error, null);
    assert.equal(edits.length, 0);
});

await check('brief: the TMDB gender mapping', () => {
    assert.equal(tmdbGender(1), 'female');
    assert.equal(tmdbGender(2), 'male');
    assert.equal(tmdbGender(0), 'unknown');
    assert.equal(tmdbGender(null), 'unknown');
});

await check('brief: the tone comes from the genre', () => {
    assert.equal(toneFor(['Science Fiction']).key, 'sci-fi');
    assert.equal(toneFor(['Horror']).key, 'horror');
    assert.equal(toneFor(['Drama', 'Thriller']).key, 'drama');
});

await check('prompt: it carries the characters and their gender', () => {
    const prompt = buildSystemPrompt({
        title: 'Masterplan',
        year: 2026,
        genres: ['Drama'],
        overview: 'A story.',
        characters: [
            { character: 'Helen', actor: 'Jane Doe', gender: 'female' },
            { character: 'Sam', actor: 'John Doe', gender: 'male' },
            { character: 'Ash', actor: 'Pat Doe', gender: 'unknown' },
        ],
    }, { names: {}, terms: {}, tone: '' });
    assert.match(prompt, /Helen \| actor Jane Doe \| female/);
    assert.match(prompt, /Ash \| actor Pat Doe \| unknown/);
    assert.match(prompt, /never guess it/);
    assert.match(prompt, /Masterplan \(2026\)/);
});

await check('watermark: the cue sits in the first four seconds', () => {
    const doc = parseSrt(EN_SRT);
    const before = doc.cues.map(c => c.timing);
    const { doc: marked, added } = addWatermark(doc, 'SubTranslate');
    assert.equal(added, true);
    assert.equal(marked.cues[0].timing, '00:00:00,000 --> 00:00:04,000');
    assert.equal(marked.cues[0].lines[0], 'SubTranslate');
    // The other timings did not move.
    assert.deepEqual(marked.cues.slice(1).map(c => c.timing), before);
    // The numbering is sequential again.
    assert.deepEqual(marked.cues.map(c => c.index), ['1', '2', '3', '4']);
});

await check('watermark: it is added once', () => {
    const doc = parseSrt(EN_SRT);
    const first = addWatermark(doc, 'SubTranslate').doc;
    const second = addWatermark(first, 'SubTranslate');
    assert.equal(second.added, false);
    assert.equal(second.doc.cues.length, first.cues.length);
});

await check('alignment: the English is found by the timing', () => {
    const english = parseSrt(EN_SRT);
    const arabic = parseSrt(AR_SRT);
    const pairs = alignCues(arabic, english);
    assert.match(pairs[0].english, /Helen/);
    assert.match(pairs[2].english, /handle it/);
});

await check('trivial cues are skipped', () => {
    assert.equal(isTrivial('♪'), true);
    assert.equal(isTrivial('مرحبا'), false);
});

// ---------------------------------------------------------------- the stage --

function withStage(fn) {
    const saved = {
        cacheDir: config.cacheDir,
        rawDir: config.rawDir,
        briefDir: config.briefDir,
        refinedDir: config.refinedDir,
        reportDir: config.reportDir,
        serverUrl: config.serverUrl,
        modelDir: config.modelDir,
        tmdbKeyFile: config.tmdbKeyFile,
        glossaryFile: config.glossaryFile,
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subqwen-stage-'));
    config.cacheDir = path.join(tmp, 'cache');
    config.rawDir = path.join(config.cacheDir, 'raw');
    config.briefDir = path.join(config.cacheDir, 'brief');
    config.refinedDir = path.join(config.cacheDir, 'refined');
    config.reportDir = path.join(config.cacheDir, 'reports');
    config.tmdbKeyFile = path.join(tmp, 'tmdb-key');
    config.glossaryFile = path.join(tmp, 'glossary.json');

    const dir = path.join(tmp, 'Masterplan (2026)');
    fs.mkdirSync(dir, { recursive: true });
    const video = path.join(dir, 'Masterplan.2026.mkv');
    const base = path.join(dir, 'Masterplan.2026');
    fs.writeFileSync(video, 'video');
    fs.writeFileSync(`${base}.en.srt`, EN_SRT);
    fs.writeFileSync(`${base}.ar.tran.srt`, AR_SRT);
    fs.writeFileSync(`${base}.ar.sub.srt`, '1\n00:00:01,000 --> 00:00:03,000\nالترجمة البشرية\n');

    return Promise.resolve()
        .then(() => fn({ video, base, tmp }))
        .finally(() => {
            Object.assign(config, saved);
            fs.rmSync(tmp, { recursive: true, force: true });
        });
}

async function runStage(video, script, options = {}) {
    const fake = await startFakeServer(script);
    config.serverUrl = fake.url;
    try {
        return await refineOne(video, { allowNetwork: false, ...options });
    } finally {
        fake.close();
    }
}

await check('stage: a gender fix is written and nothing else moves', async () => {
    await withStage(async ({ video, base }) => {
        const script = request => {
            const payload = JSON.parse(request.messages[1].content);
            const edits = payload.cues.map(cue =>
                cue.i === 0 ? { i: cue.i, ar: 'هلن، هل أنت قادمة؟' } : { i: cue.i, ar: cue.ar });
            return editsAnswer(edits);
        };
        const result = await runStage(video, script);
        assert.equal(result.status, 'refined', result.reason);
        assert.equal(result.changed, 1);

        const doc = parseSrt(fs.readFileSync(`${base}.ar.tran.srt`, 'utf8'));
        assert.equal(doc.cues.length, 2, 'the sound cue is dropped');
        assert.equal(doc.cues[0].index, '1');
        assert.equal(doc.cues[0].timing, '00:00:01,000 --> 00:00:03,000');
        assert.deepEqual(doc.cues[0].lines, ['هلن، هل أنت قادمة؟']);
        assert.equal(doc.cues[1].timing, '00:00:07,000 --> 00:00:09,000');

        // The human track is never touched.
        assert.match(fs.readFileSync(`${base}.ar.sub.srt`, 'utf8'), /الترجمة البشرية/);

        // The raw copy is kept out of the library.
        const rawFiles = fs.readdirSync(config.rawDir);
        assert.equal(rawFiles.length, 1);
        assert.match(fs.readFileSync(path.join(config.rawDir, rawFiles[0]), 'utf8'), /آcoming/);

        // The sidecar records what happened.
        const sidecars = fs.readdirSync(config.refinedDir);
        assert.equal(sidecars.length, 1);
        const sidecar = JSON.parse(fs.readFileSync(path.join(config.refinedDir, sidecars[0]), 'utf8'));
        assert.equal(sidecar.promptVersion, config.promptVersion);
        assert.equal(sidecar.refined, true);
    });
});

await check('stage: a second run is skipped', async () => {
    await withStage(async ({ video }) => {
        const script = request => {
            const payload = JSON.parse(request.messages[1].content);
            return editsAnswer(payload.cues.map(cue => ({ i: cue.i, ar: cue.ar })));
        };
        await runStage(video, script);
        const second = await runStage(video, script);
        assert.equal(second.status, 'already-refined');
    });
});

await check('stage: a dry run writes a report and changes nothing', async () => {
    await withStage(async ({ video, base }) => {
        const before = fs.readFileSync(`${base}.ar.tran.srt`, 'utf8');
        const script = request => {
            const payload = JSON.parse(request.messages[1].content);
            return editsAnswer(payload.cues.map(cue =>
                cue.i === 0 ? { i: cue.i, ar: 'سطر جديد تمامًا' } : { i: cue.i, ar: cue.ar }));
        };
        const result = await runStage(video, script, { dryRun: true });
        assert.equal(result.status, 'refined', result.reason);
        assert.equal(fs.readFileSync(`${base}.ar.tran.srt`, 'utf8'), before);
        assert.ok(fs.existsSync(result.report));
        const report = fs.readFileSync(result.report, 'utf8');
        assert.match(report, /آcoming/);
        assert.match(report, /سطر جديد تمامًا/);
    });
});

await check('stage: a model that changes everything is discarded', async () => {
    await withStage(async ({ video, base }) => {
        const before = fs.readFileSync(`${base}.ar.tran.srt`, 'utf8');
        const script = request => {
            const payload = JSON.parse(request.messages[1].content);
            return editsAnswer(payload.cues.map(cue => ({ i: cue.i, ar: 'نص مختلف تماما' })));
        };
        const result = await runStage(video, script);
        assert.equal(result.status, 'discarded');
        assert.equal(fs.readFileSync(`${base}.ar.tran.srt`, 'utf8'), before);
    });
});

await check('stage: a model that fails the gate is discarded', async () => {
    await withStage(async ({ video, base }) => {
        const before = fs.readFileSync(`${base}.ar.tran.srt`, 'utf8');
        const script = request => {
            const payload = JSON.parse(request.messages[1].content);
            return editsAnswer(payload.cues.map(cue => ({ i: cue.i, ar: 'This is English' })));
        };
        const result = await runStage(video, script);
        assert.equal(result.status, 'discarded');
        assert.equal(fs.readFileSync(`${base}.ar.tran.srt`, 'utf8'), before);
    });
});

await check('stage: a broken answer keeps the raw line', async () => {
    await withStage(async ({ video, base }) => {
        const before = fs.readFileSync(`${base}.ar.tran.srt`, 'utf8');
        const result = await runStage(video, () => 'not json at all');
        assert.equal(fs.readFileSync(`${base}.ar.tran.srt`, 'utf8'), before);
        assert.ok(result.failed > 0);
    });
});

await check('stage: a server that is not there changes nothing', async () => {
    await withStage(async ({ video, base, tmp }) => {
        const before = fs.readFileSync(`${base}.ar.tran.srt`, 'utf8');
        // No model dir, so nothing can be started to answer the request,
        // on a computer as well as on a phone that has llama-server.
        config.modelDir = path.join(tmp, 'no-models');
        const result = await refineOne(video, { allowNetwork: false });
        assert.equal(fs.readFileSync(`${base}.ar.tran.srt`, 'utf8'), before);
        assert.equal(result.status, 'no-model');
    });
});

await check('brief: without a TMDB key the generic brief is used', async () => {
    await withStage(async ({ video }) => {
        const brief = await buildBrief({ title: 'Some Movie', year: 2020, kind: 'movie', path: '' },
            { allowNetwork: false });
        assert.equal(brief.provider, 'generic');
        assert.equal(brief.title, 'Some Movie');
    });
});

await check('brief: the nfo is used when there is no network', async () => {
    await withStage(async ({ tmp }) => {
        const dir = path.join(tmp, 'Movie (2020)');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'movie.nfo'),
            '<movie><title>Some Movie</title><year>2020</year><plot>A story.</plot>' +
            '<genre>Drama</genre><actor><name>Helen</name><character>Helen</character></actor></movie>');
        const brief = await buildBrief({
            title: 'Some Movie',
            year: 2020,
            kind: 'movie',
            path: path.join(dir, 'Movie (2020).mkv'),
        }, { allowNetwork: false });
        assert.equal(brief.provider, 'nfo');
        assert.equal(brief.title, 'Some Movie');
        assert.deepEqual(brief.genres, ['Drama']);
        assert.equal(brief.characters[0].gender, 'unknown');
    });
});

await check('glossary: the flat form is a term list', async () => {
    await withStage(async ({ tmp }) => {
        const file = path.join(tmp, 'glossary.json');
        fs.writeFileSync(file, JSON.stringify({ exorcism: 'طرد الأرواح' }));
        const glossary = loadGlossary(file);
        assert.equal(glossary.terms.exorcism, 'طرد الأرواح');
    });
});

await check('glossary: the structured form carries names', async () => {
    await withStage(async ({ tmp }) => {
        const file = path.join(tmp, 'glossary.json');
        fs.writeFileSync(file, JSON.stringify({ names: { Helen: 'هيلين' } }));
        const glossary = loadGlossary(file);
        assert.equal(glossary.names.Helen, 'هيلين');
    });
});

await check('watermark: the file gets the cue and stays valid', async () => {
    await withStage(async ({ base }) => {
        const file = `${base}.ar.tran.srt`;
        assert.equal(ensureWatermarkFile(file, 'SubTranslate'), true);
        assert.equal(ensureWatermarkFile(file, 'SubTranslate'), false);
        const doc = parseSrt(fs.readFileSync(file, 'utf8'));
        assert.equal(doc.cues[0].timing, '00:00:00,000 --> 00:00:04,000');
        assert.equal(doc.cues[0].lines[0], 'SubTranslate');
        assert.equal(doc.cues[1].timing, '00:00:01,000 --> 00:00:03,000');
    });
});

await check('srt: the round trip keeps the index and the timing', () => {
    const source = '1\n00:00:01,000 --> 00:00:03,000\n<i>Hello</i>\n\n2\n00:00:04,000 --> 00:00:06,000\nTwo\nlines\n';
    const doc = parseSrt(source);
    assert.equal(doc.cues.length, 2);
    assert.equal(doc.cues[0].index, '1');
    assert.equal(doc.cues[0].timing, '00:00:01,000 --> 00:00:03,000');
    assert.deepEqual(doc.cues[1].lines, ['Two', 'lines']);
    assert.equal(serializeSrt(doc), source);
});

if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exitCode = 1;
} else {
    console.log('\nall checks passed');
}
