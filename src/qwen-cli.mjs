#!/usr/bin/env node
// subqwen - post-edit a machine translated Arabic subtitle with a local LLM.
//
// The translator is fast and free but it makes the mistakes a small offline
// model makes: wrong gender agreement, transliterated names that nobody
// recognises, and a flat register that does not fit the genre.
//
// subqwen reads the English source and the raw Arabic, asks a small local
// model (llama-server, Qwen) for a careful rewrite of the Arabic, and keeps
// the rewrite only when every change passes a mechanical gate. The timings
// and the cue numbers are never changed, and the raw translation is kept so
// the whole thing can be undone.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { config } from './qwen-config.mjs';
import { refineOne, mediaHash } from './qwen.mjs';
import { buildBrief } from './qwen-brief.mjs';
import { parseMediaInfo, findEnglishSource, baseFor } from './qwen-media.mjs';
import { LlamaServer, askModel, findModel } from './qwen-server.mjs';
import { buildSystemPrompt, buildBatchPayload } from './qwen-prompt.mjs';
import { ensureWatermarkFile, DEFAULT_WATERMARK } from './watermark.mjs';

const USAGE = `subqwen - fix a machine translated Arabic subtitle with a local LLM

Usage:
  subqwen refine <video|srt> [options]   refine the Arabic next to a video
  subqwen watermark <srt> [options]      put the tool name in the first 4s
  subqwen doctor [--live]               check the setup
  subqwen verify                        load the model and ask it something
  subqwen brief <video>                 print the movie brief

Options for refine:
  --dry-run           write a report, change nothing
  --force             refine again even if the sidecar matches
  --provider <name>   auto, tmdb, tvmaze, cinemeta or nfo (default auto)
  --offline           do not use the network for the brief
  --no-sounds         keep the sound cues instead of dropping them
  --watermark [text]  add the watermark cue (default "${DEFAULT_WATERMARK}")

Options for watermark:
  --text <text>       the watermark text (default "${DEFAULT_WATERMARK}")

Files:
  key        ${config.tmdbKeyFile}
  glossary   ${config.glossaryFile}
  raw        ${config.rawDir}
  briefs     ${config.briefDir}
  sidecars   ${config.refinedDir}
`;

function parseArgs(argv) {
    const opts = { positional: [], dryRun: false, force: false, provider: 'auto', offline: false, dropSounds: true };
    const takesValue = new Set(['--provider', '--text', '--model', '--server']);

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
        if (arg === '--dry-run') { opts.dryRun = true; continue; }
        if (arg === '--force' || arg === '-f') { opts.force = true; continue; }
        if (arg === '--offline') { opts.offline = true; continue; }
        if (arg === '--no-sounds') { opts.dropSounds = false; continue; }
        if (arg === '--live') { opts.live = true; continue; }
        if (arg === '--watermark') {
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) { opts.watermark = next; i++; }
            else opts.watermark = DEFAULT_WATERMARK;
            continue;
        }
        if (takesValue.has(arg)) {
            const value = argv[++i];
            if (value === undefined) throw new Error(`Missing value for ${arg}`);
            opts[arg.replace(/^--/, '')] = value;
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        opts.positional.push(arg);
    }
    return opts;
}

/** One line per film: cues, sent, changed, fell back, seconds, model. */
export function reportLine(result) {
    const parts = [
        `cues=${result.cues}`,
        `sent=${result.sent}`,
        `changed=${result.changed}`,
        `fallback=${result.failed}`,
    ];
    if (result.dropped) parts.push(`dropped=${result.dropped}`);
    parts.push(`seconds=${Math.round(result.seconds)}`);
    parts.push(`model=${result.model || 'none'}`);
    parts.push(`status=${result.status}`);
    if (result.reason) parts.push(`reason=${result.reason}`);
    process.stderr.write(`subqwen: ${path.basename(result.video)} ${parts.join(' ')}\n`);
    if (result.report) process.stderr.write(`subqwen: report written to ${result.report}\n`);
}

function resolveVideos(target) {
    if (!target) return [];
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return [target];
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        const found = [];
        const walk = dir => {
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir, name);
                let stat;
                try { stat = fs.statSync(full); } catch { continue; }
                if (stat.isDirectory()) walk(full);
                else if (/\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|mpg|mpeg|ts)$/i.test(name)) found.push(full);
            }
        };
        walk(target);
        return found.sort();
    }

    const needle = target.toLowerCase();
    const lib = process.env.SUBGRAB_LIB || '/sdcard/Download/Flud';
    const found = [];
    const walk = dir => {
        let names;
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            const full = path.join(dir, name);
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.isDirectory()) walk(full);
            else if (/\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|mpg|mpeg|ts)$/i.test(name) && name.toLowerCase().includes(needle)) {
                found.push(full);
            }
        }
    };
    walk(lib);
    return found.sort();
}

function lockPath() {
    return path.join(config.cacheDir, 'refine.lock.d');
}

/**
 * One refine job at a time.
 *
 * The lock is a directory, because that is the one thing every filesystem on
 * Android creates atomically. The owner pid is written inside it, so a lock
 * left behind by a killed job can be taken over.
 */
function acquireLock() {
    const dir = lockPath();
    fs.mkdirSync(config.cacheDir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.mkdirSync(dir);
            fs.writeFileSync(path.join(dir, 'owner'), `${process.pid}\n`, 'utf8');
            return true;
        } catch (err) {
            if (err.code !== 'EEXIST') {
                process.stderr.write(`subqwen: cannot take the lock: ${err.message}\n`);
                return false;
            }
            let pid = 0;
            try {
                pid = Number(String(fs.readFileSync(path.join(dir, 'owner'), 'utf8')).trim());
            } catch {
                pid = 0;
            }
            let alive = false;
            if (pid > 0) {
                try {
                    process.kill(pid, 0);
                    alive = true;
                } catch (probe) {
                    alive = probe.code !== 'ESRCH';
                }
            }
            if (alive) return false;
            process.stderr.write('subqwen: clearing a stale lock\n');
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* keep going */ }
        }
    }
    return false;
}

function releaseLock() {
    try { fs.rmSync(lockPath(), { recursive: true, force: true }); } catch { /* already gone */ }
}

/** Keep the phone awake for the length of a job. */
function wakeLock(enable) {
    const binary = enable ? 'termux-wake-lock' : 'termux-wake-unlock';
    try {
        spawnSync(binary, [], { stdio: 'ignore' });
    } catch {
        // termux-tools is optional.
    }
}

async function commandRefine(opts) {
    const videos = resolveVideos(opts.positional[0]);
    if (!videos.length) {
        process.stderr.write(`subqwen: nothing matches ${opts.positional[0]}\n`);
        return 3;
    }

    if (!acquireLock()) {
        process.stderr.write('subqwen: another refine job is running\n');
        return 5;
    }

    wakeLock(true);
    try {
        for (const video of videos) {
            const result = await refineOne(video, {
                dryRun: opts.dryRun,
                force: opts.force,
                provider: opts.provider,
                allowNetwork: !opts.offline,
                dropSounds: opts.dropSounds,
                watermark: opts.watermark || null,
            });
            reportLine(result);
        }
    } finally {
        wakeLock(false);
        releaseLock();
    }
    return 0;
}

function commandWatermark(opts) {
    const file = opts.positional[0];
    if (!file || !fs.existsSync(file)) {
        process.stderr.write('subqwen: watermark: file not found\n');
        return 3;
    }
    const text = opts.text || DEFAULT_WATERMARK;
    const changed = ensureWatermarkFile(file, text);
    process.stderr.write(`subqwen: watermark ${changed ? 'added to' : 'already in'} ${file}\n`);
    return 0;
}

async function commandDoctor(opts) {
    let failures = 0;
    let warnings = 0;
    const ok = (label, detail) => console.log(`  ${label.padEnd(12)} ok    ${detail}`);
    const warn = (label, detail) => { warnings++; console.log(`  ${label.padEnd(12)} warn  ${detail}`); };
    const bad = (label, detail) => { failures++; console.log(`  ${label.padEnd(12)} FAIL  ${detail}`); };

    console.log('subqwen doctor\n');

    const model = findModel(opts.model || process.env.REFINE_MODEL);
    if (model) {
        const size = (fs.statSync(model).size / 1048576).toFixed(1);
        ok('model', `${model} (${size} MB)`);
    } else {
        bad('model', `no .gguf in ${config.modelDir}`);
    }

    if (fs.existsSync(config.tmdbKeyFile)) {
        const mode = (fs.statSync(config.tmdbKeyFile).mode & 0o777).toString(8);
        if (mode === '600') ok('tmdb-key', 'present, mode 600');
        else warn('tmdb-key', `present, mode ${mode} (want 600)`);
    } else {
        warn('tmdb-key', `missing: ${config.tmdbKeyFile} (the .nfo and the generic brief are used)`);
    }

    if (fs.existsSync(config.glossaryFile)) ok('glossary', config.glossaryFile);
    else ok('glossary', 'none (the brief decides)');

    for (const [label, dir] of [['raw', config.rawDir], ['brief', config.briefDir], ['refined', config.refinedDir]]) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            ok(`cache-${label}`, `${dir} (${fs.readdirSync(dir).length} file(s))`);
        } catch (err) {
            bad(`cache-${label}`, `${dir}: ${err.message}`);
        }
    }

    if (opts.live) {
        const server = new LlamaServer(model);
        if (await server.start()) {
            ok('server', `the model loads and answers on ${config.serverUrl}`);
            server.stop();
        } else {
            bad('server', 'the model does not load');
        }
    }

    console.log(`\n${failures} failure(s), ${warnings} warning(s)`);
    return failures ? 1 : 0;
}

async function commandVerify(opts) {
    const model = findModel(opts.model || process.env.REFINE_MODEL);
    if (!model) {
        process.stderr.write(`subqwen: no .gguf in ${config.modelDir}\n`);
        return 1;
    }
    const server = new LlamaServer(model);
    if (!await server.start()) {
        process.stderr.write('subqwen: the model does not load\n');
        return 1;
    }
    try {
        // Ask with the same prompt the real stage uses, so verify certifies
        // exactly what will run for a film.
        const systemPrompt = buildSystemPrompt(
            { title: 'Verify', genres: [] },
            { names: {}, terms: {}, tone: '' },
        );
        const { edits, error } = await askModel(
            systemPrompt,
            buildBatchPayload(
                [{ i: 1, en: 'Hello', ar: 'مرحبا' }],
                { prev: { en: '', ar: '' }, next: { en: '', ar: '' } },
            ),
        );
        if (error) {
            process.stderr.write(`subqwen: the model answered with: ${error}\n`);
            return 1;
        }
        if (!edits.length) {
            process.stderr.write('subqwen: the model returned no edits\n');
            return 1;
        }
        process.stdout.write(`model ${path.basename(model)} works, answer: ${JSON.stringify(edits)}\n`);
        return 0;
    } finally {
        server.stop();
    }
}

async function commandBrief(opts) {
    const videos = resolveVideos(opts.positional[0]);
    if (!videos.length) {
        process.stderr.write(`subqwen: nothing matches ${opts.positional[0]}\n`);
        return 3;
    }
    const info = { ...parseMediaInfo(videos[0]), path: videos[0] };
    const brief = await buildBrief(info, { provider: opts.provider, allowNetwork: !opts.offline });
    process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
    return 0;
}

export async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        process.stderr.write(`subqwen: ${err.message}\n\n${USAGE}`);
        return 2;
    }

    const command = opts.positional.shift();

    if (opts.help || !command) {
        process.stdout.write(USAGE);
        return opts.help ? 0 : 2;
    }

    try {
        switch (command) {
            case 'refine': return await commandRefine(opts);
            case 'watermark': return commandWatermark(opts);
            case 'doctor': return await commandDoctor(opts);
            case 'verify': return await commandVerify(opts);
            case 'brief': return await commandBrief(opts);
            default:
                process.stderr.write(`subqwen: unknown command: ${command}\n\n${USAGE}`);
                return 2;
        }
    } catch (err) {
        process.stderr.write(`subqwen: ${(err && err.stack) || err}\n`);
        return 1;
    }
}
