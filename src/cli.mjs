#!/usr/bin/env node
// subtranslate <english.srt> "<Movie Title>"
//
// Translates an English subtitle file into Arabic, on device, and writes
// <Movie>.ar.srt next to it so Jellyfin (or any other player) picks it up
// automatically.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSrt, serializeSrt, cueText, isTranslatable } from './srt.mjs';
import { Engine, defaultModelDir } from './engine.mjs';
import { GENRES, maskTerms, restoreTerms, hasResidualSentinel } from './glossary.mjs';
import { inferGenre } from './brief.mjs';

const USAGE = `subtranslate - offline English -> Arabic subtitle translation

Usage:
  subtranslate <english.srt> "<Movie Title>" [options]

Options:
  --out <path>        write here instead of <Movie>.ar.srt next to the input
  --genre <name>      force a genre instead of inferring it from the title
                      (${Object.keys(GENRES).join(', ')})
  --glossary <file>   JSON file with extra terms: {"english": "عربي", ...}
  --workers <n>       translation worker threads (default 4)
  --chunk <n>         cues translated per wave (default 200)
  --model-dir <path>  where the en->ar model lives (default ${defaultModelDir()})
  --overwrite         re-translate even if the .ar.srt already exists
  --dry-run           do everything except writing the output file
  --json              print a machine readable summary on stdout
  --quiet             only log warnings and errors
  --fetch-model       download the en->ar model, then exit
  -h, --help          show this help
`;

function parseArgs(argv) {
    const opts = { positional: [], workers: 4, chunk: 200, overwrite: false, json: false, quiet: false, dryRun: false };
    const takesValue = new Set(['--out', '--genre', '--glossary', '--workers', '--chunk', '--model-dir']);

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
        if (arg === '--overwrite') { opts.overwrite = true; continue; }
        if (arg === '--json') { opts.json = true; continue; }
        if (arg === '--quiet') { opts.quiet = true; continue; }
        if (arg === '--dry-run') { opts.dryRun = true; continue; }
        if (arg === '--fetch-model') { opts.fetchModel = true; continue; }

        if (takesValue.has(arg)) {
            const value = argv[++i];
            if (value === undefined) throw new Error(`Missing value for ${arg}`);
            if (arg === '--workers') opts.workers = Math.max(1, parseInt(value, 10) || 4);
            else if (arg === '--chunk') opts.chunk = Math.max(1, parseInt(value, 10) || 200);
            else if (arg === '--out') opts.out = value;
            else if (arg === '--genre') opts.genre = value;
            else if (arg === '--glossary') opts.glossary = value;
            else if (arg === '--model-dir') opts.modelDir = value;
            continue;
        }

        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        opts.positional.push(arg);
    }

    return opts;
}

/** Where the Arabic subtitle for `input` should go. */
export function outPathFor(input, explicit) {
    if (explicit) return explicit;
    return input
        .replace(/\.(en|eng)(\.(forced|sdh|hi))?\.srt$/i, '.srt')
        .replace(/\.srt$/i, '.ar.srt');
}

const lineCount = s => s.replace(/\n+$/, '').split('\n').length;

class Log {
    constructor(file, { quiet = false } = {}) {
        this.quiet = quiet;
        this.file = file;
        if (file) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
        }
    }
    write(level, message) {
        const line = `${new Date().toISOString()} [${level}] ${message}`;
        if (this.file) {
            try { fs.appendFileSync(this.file, line + os.EOL); } catch { /* logging must never break a run */ }
        }
        if (level === 'ERROR' || !this.quiet) {
            process.stderr.write(line + '\n');
        }
    }
    info(m) { this.write('INFO', m); }
    warn(m) { this.write('WARN', m); }
    error(m) { this.write('ERROR', m); }
}

/**
 * Translate a parsed document in place.
 * @returns {{total: number, translated: number, kept: number}}
 */
export async function translateDocument(doc, { engine, terms, chunk, onProgress }) {
    const work = [];
    doc.cues.forEach(cue => {
        const text = cueText(cue);
        if (isTranslatable(text)) work.push({ cue, text });
    });

    let kept = 0;
    if (!work.length) return { total: doc.cues.length, translated: 0, kept: 0 };

    // Pass 1: glossary terms masked out, whole cue translated as one string so
    // the line breaks inside the cue are preserved by the model.
    const items = work.map(w => {
        const { masked, restore } = maskTerms(w.text, terms);
        return { cue: w.cue, text: w.text, masked, restore, result: null };
    });

    const out1 = await engine.translateMany(items.map(i => i.masked), { chunkSize: chunk, onProgress });

    const retry = [];
    items.forEach((item, k) => {
        const { text: restored, complete } = restoreTerms(out1[k], item.restore);
        if (complete && !hasResidualSentinel(restored) && restored.trim() && lineCount(restored) === lineCount(item.text)) {
            item.result = restored;
        } else {
            retry.push(item);
        }
    });

    // Pass 2: the sentinel trick upset the model, so translate the cue plainly.
    if (retry.length) {
        const out2 = await engine.translateMany(retry.map(i => i.text), { chunkSize: chunk });
        const retry2 = [];
        retry.forEach((item, k) => {
            const t = out2[k];
            if (t && t.trim() && !hasResidualSentinel(t) && lineCount(t) === lineCount(item.text)) {
                item.result = t;
            } else {
                retry2.push(item);
            }
        });

        // Pass 3: last resort, translate line by line -- the cue keeps its
        // shape even though sentences spanning two lines lose some context.
        if (retry2.length) {
            const jobs = [];
            for (const item of retry2) {
                item.lines = item.text.split('\n');
                item.lines.forEach((line, idx) => {
                    if (line.trim()) jobs.push({ item, idx, line });
                });
            }
            if (jobs.length) {
                const out3 = await engine.translateMany(jobs.map(j => j.line), { chunkSize: chunk });
                jobs.forEach((job, k) => {
                    const t = out3[k];
                    job.item.result ??= job.item.lines.slice();
                    if (t && t.trim() && !hasResidualSentinel(t)) job.item.result[job.idx] = t;
                });
                retry2.forEach(item => {
                    const joined = Array.isArray(item.result) ? item.result.join('\n') : null;
                    item.result = joined && joined.trim() ? joined : null;
                });
            }
        }
    }

    let translated = 0;
    for (const item of items) {
        if (item.result) {
            item.cue.lines = item.result.replace(/\n+$/, '').split('\n');
            translated++;
        } else {
            // Keep the English line rather than dropping the cue. The file stays
            // complete and valid, and the log records what happened.
            kept++;
        }
    }

    return { total: doc.cues.length, translated, kept };
}

export async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        process.stderr.write(`subtranslate: ${err.message}\n\n${USAGE}`);
        return 2;
    }

    if (opts.help || (!opts.positional.length && !opts.fetchModel)) {
        process.stdout.write(USAGE);
        return opts.help ? 0 : 2;
    }

    if (opts.fetchModel) {
        const { fetchModel } = await import('./fetch-model.mjs');
        await fetchModel(opts.modelDir || defaultModelDir(), { log: console.error });
        return 0;
    }

    if (opts.positional.length < 2) {
        process.stderr.write(`subtranslate: expected <english.srt> and "<Movie Title>"\n\n${USAGE}`);
        return 2;
    }

    const input = path.resolve(opts.positional[0]);
    const title = opts.positional.slice(1).join(' ');
    const log = new Log(process.env.SUBTRANSLATE_LOG || path.join(os.homedir(), '.local', 'share', 'subtranslate', 'subtranslate.log'), opts);
    const started = Date.now();

    if (!fs.existsSync(input)) {
        log.error(`input not found: ${input}`);
        if (opts.json) process.stdout.write(JSON.stringify({ status: 'error', reason: 'input-not-found', input }) + '\n');
        return 1;
    }

    const output = outPathFor(input, opts.out);

    // Idempotency: a movie that already has an Arabic subtitle is never re-done.
    if (!opts.overwrite && fs.existsSync(output) && fs.statSync(output).size > 0) {
        log.info(`skip title="${title}" reason=already-translated out="${output}"`);
        if (opts.json) process.stdout.write(JSON.stringify({ status: 'skipped', reason: 'already-translated', output }) + '\n');
        return 0;
    }

    const genre = opts.genre || inferGenre(title);
    if (!GENRES[genre] && !opts.glossary) {
        log.warn(`unknown genre "${genre}", falling back to general`);
    }
    const terms = { ...(GENRES[genre]?.terms || {}) };
    if (opts.glossary) {
        Object.assign(terms, JSON.parse(fs.readFileSync(opts.glossary, 'utf8')));
    }

    const doc = parseSrt(fs.readFileSync(input, 'utf8'));
    if (!doc.cues.length) {
        log.error(`no cues found in ${input}`);
        if (opts.json) process.stdout.write(JSON.stringify({ status: 'error', reason: 'no-cues', input }) + '\n');
        return 1;
    }

    const engine = new Engine({ modelDir: opts.modelDir || defaultModelDir(), workers: opts.workers });
    let stats;
    try {
        await engine.start();
        stats = await translateDocument(doc, {
            engine,
            terms,
            chunk: opts.chunk,
            onProgress: (done, total) => log.info(`progress ${done}/${total} cues`),
        });
    } catch (err) {
        log.error(`translation failed for "${title}": ${err.message}`);
        if (opts.json) process.stdout.write(JSON.stringify({ status: 'error', reason: 'translation-failed', message: err.message }) + '\n');
        return 1;
    } finally {
        await engine.stop().catch(() => {});
    }

    if (stats.kept) {
        log.warn(`title="${title}" ${stats.kept} cue(s) could not be translated and were left in English`);
    }

    const elapsed = (Date.now() - started) / 1000;

    if (opts.dryRun) {
        log.info(`dry-run title="${title}" genre=${genre} cues=${stats.total} translated=${stats.translated} elapsed=${elapsed.toFixed(1)}s`);
        if (opts.json) process.stdout.write(JSON.stringify({ status: 'dry-run', genre, ...stats }) + '\n');
        return 0;
    }

    // Atomic write: a crashed run must never leave a half written .ar.srt.
    const tmp = `${output}.tmp-${process.pid}`;
    try {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(tmp, serializeSrt(doc), 'utf8');
        fs.renameSync(tmp, output);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
        log.error(`could not write "${output}": ${err.message}`);
        if (opts.json) process.stdout.write(JSON.stringify({ status: 'error', reason: 'write-failed', message: err.message }) + '\n');
        return 1;
    }

    log.info(`translated title="${title}" genre=${genre} cues=${stats.total} translated=${stats.translated} elapsed=${elapsed.toFixed(1)}s out="${output}"`);
    if (opts.json) {
        process.stdout.write(JSON.stringify({
            status: 'translated', genre, output,
            cues: stats.total, translated: stats.translated, kept: stats.kept,
            elapsed_seconds: +elapsed.toFixed(1),
        }) + '\n');
    }
    return 0;
}
