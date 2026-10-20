#!/usr/bin/env node
// subtranslate <english.srt> "<Movie Title>"
//
// Translates an English subtitle file into Arabic, on device, and writes
// <Movie>.ar.tran.srt next to it. `tran` marks the machine translation so it
// can live alongside a downloaded Arabic subtitle (`<Movie>.ar.sub.srt`) in
// Jellyfin and Plex.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSrt, serializeSrt } from './srt.mjs';
import { Engine, defaultModelDir } from './engine.mjs';
import { GENRES } from './glossary.mjs';
import { inferGenre } from './brief.mjs';
import { Progress } from './progress.mjs';
import { writeAtomic } from './atomic.mjs';
import { outPathFor } from './paths.mjs';
import { translateDocument } from './translate.mjs';
import { validateTranslation, formatValidation } from './validate.mjs';

export { outPathFor, translateDocument };

const USAGE = `subtranslate - offline English -> Arabic subtitle translation

Usage:
  subtranslate <english.srt> "<Movie Title>" [options]

Options:
  --out <path>        write here instead of <Movie>.ar.tran.srt next to the input
  --reject-out <path> keep a rejected translation here for inspection
  --genre <name>      force a genre instead of inferring it from the title
                      (${Object.keys(GENRES).join(', ')})
  --glossary <file>   JSON file with extra terms: {"english": "عربي", ...}
  --workers <n>       translation worker threads (default 4)
  --chunk <n>         cues translated per wave (default 200)
  --model-dir <path>  where the en->ar model lives (default ${defaultModelDir()})
  --overwrite         re-translate even if the output already exists
  --dry-run           do everything except writing the output file
  --json              print progress and a final result as JSON on stdout
  --quiet             only log warnings and errors (no progress)
  --fetch-model       download the en->ar model, then exit
  -h, --help          show this help
`;

function parseArgs(argv) {
    const opts = { positional: [], workers: 4, chunk: 200, overwrite: false, json: false, quiet: false, dryRun: false };
    const takesValue = new Set(['--out', '--reject-out', '--genre', '--glossary', '--workers', '--chunk', '--model-dir']);

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
            else if (arg === '--reject-out') opts.rejectOut = value;
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
        if (opts.json) process.stdout.write(JSON.stringify({ event: 'result', status: 'error', reason: 'input-not-found', input }) + '\n');
        return 1;
    }

    const output = outPathFor(input, opts.out);

    // Idempotency: a movie that already has a translation is never re-done.
    if (!opts.overwrite && fs.existsSync(output) && fs.statSync(output).size > 0) {
        log.info(`skip title="${title}" reason=already-translated out="${output}"`);
        if (opts.json) process.stdout.write(JSON.stringify({ event: 'result', status: 'skipped', reason: 'already-translated', output }) + '\n');
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
    const sourceDoc = {
        ...doc,
        cues: doc.cues.map(cue => ({ ...cue, lines: [...cue.lines] })),
    };
    if (!doc.cues.length) {
        log.error(`no cues found in ${input}`);
        if (opts.json) process.stdout.write(JSON.stringify({ event: 'result', status: 'error', reason: 'no-cues', input }) + '\n');
        return 1;
    }

    const engine = new Engine({ modelDir: opts.modelDir || defaultModelDir(), workers: opts.workers });
    let stats;
    let progress = null;
    const onProgress = (done, total) => {
        if (!progress) {
            progress = new Progress({ json: opts.json, quiet: opts.quiet });
            progress.start(total);
        }
        progress.update(done, total);
    };

    try {
        await engine.start();
        stats = await translateDocument(doc, { engine, terms, chunk: opts.chunk, onProgress });
    } catch (err) {
        progress?.abort();
        log.error(`translation failed for "${title}": ${err.message}`);
        if (opts.json) process.stdout.write(JSON.stringify({ event: 'result', status: 'error', reason: 'translation-failed', message: err.message }) + '\n');
        return 1;
    } finally {
        await engine.stop().catch(() => {});
    }

    progress?.finish();

    if (stats.kept) {
        log.warn(`title="${title}" ${stats.kept} cue(s) could not be translated and were left in English`);
    }

    const elapsed = (Date.now() - started) / 1000;

    if (opts.dryRun) {
        log.info(`dry-run title="${title}" genre=${genre} cues=${stats.total} translated=${stats.translated} elapsed=${elapsed.toFixed(1)}s`);
        if (opts.json) process.stdout.write(JSON.stringify({ event: 'result', status: 'dry-run', genre, ...stats }) + '\n');
        return 0;
    }

    const validation = validateTranslation(sourceDoc, doc);
    if (!validation.ok) {
        log.warn(`rejected title="${title}" ${formatValidation(validation)} reason="${validation.reasons.join('; ')}"`);
        if (opts.rejectOut) {
            try {
                writeAtomic(opts.rejectOut, serializeSrt(doc));
            } catch (err) {
                log.error(`could not write rejected translation "${opts.rejectOut}": ${err.message}`);
            }
        }
        if (opts.json) {
            process.stdout.write(JSON.stringify({
                event: 'result',
                status: 'rejected',
                reason: 'validation',
                reasons: validation.reasons,
                metrics: validation.metrics,
            }) + '\n');
        }
        return 4;
    }

    // Atomic write: a crashed run must never leave a half written translation.
    try {
        writeAtomic(output, serializeSrt(doc));
    } catch (err) {
        log.error(`could not write "${output}": ${err.message}`);
        if (opts.json) process.stdout.write(JSON.stringify({ event: 'result', status: 'error', reason: 'write-failed', message: err.message }) + '\n');
        return 1;
    }

    log.info(`translated title="${title}" genre=${genre} cues=${stats.total} translated=${stats.translated} elapsed=${elapsed.toFixed(1)}s out="${output}"`);
    if (opts.json) {
        process.stdout.write(JSON.stringify({
            event: 'result',
            status: 'translated', genre, output,
            cues: stats.total, translated: stats.translated, kept: stats.kept,
            elapsed_seconds: +elapsed.toFixed(1),
        }) + '\n');
    }
    return 0;
}
