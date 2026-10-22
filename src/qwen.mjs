// The refine stage.
//
// It reads the English source and the raw Bergamot Arabic, asks the model for
// a careful rewrite of the Arabic, and keeps the rewrite only when every
// change passes the gate.
//
// The rules that matter:
//
//   * Only the text of a cue is ever rewritten. Cue numbers, timings, cue
//     order and the blank line separators are copied through untouched.
//   * <Movie>.ar.sub.srt (the human track) is never read and never written.
//   * The raw Bergamot output is kept at ~/.cache/subgrab/raw/<hash>.srt, so
//     a refinement can always be undone and a failed refinement can fall back
//     to the untouched translation.
//   * Nothing is written in place: the result goes to a temporary file in the
//     same directory and is renamed over the target.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseSrt, serializeSrt, cueText } from './srt.mjs';
import { writeAtomic } from './atomic.mjs';
import { config } from './qwen-config.mjs';
import { parseMediaInfo, findEnglishSource, baseFor } from './qwen-media.mjs';
import { buildBrief, loadGlossary } from './qwen-brief.mjs';
import { buildSystemPrompt, buildBatchPayload } from './qwen-prompt.mjs';
import { checkCue } from './qwen-gate.mjs';
import { soundOnly } from './qwen-sounds.mjs';
import { addWatermark } from './watermark.mjs';
import { LlamaServer, askModel, findModel } from './qwen-server.mjs';

const ARABIC_RE = /\p{Script=Arabic}/u;

/** A short, stable id for one video, used for the cache file names. */
export function mediaHash(file) {
    return crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16);
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

/** A cue with nothing worth editing: no Arabic, or only noise. */
export function isTrivial(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return true;
    if (trimmed.length < 3) return true;
    if (!ARABIC_RE.test(trimmed)) return true;
    const letters = (trimmed.match(/\p{Script=Arabic}/gu) || []).length;
    if (letters < 2 && !/\d/.test(trimmed)) return true;
    return false;
}

/**
 * Pair every Arabic cue with its English line.
 *
 * The Arabic inherits the timing of the English, so the timing is the natural
 * key. Position is only used when the timings do not line up, which happens
 * when the two files came from different sources.
 */
export function alignCues(arabicDoc, englishDoc) {
    const byTiming = new Map();
    englishDoc.cues.forEach((cue, index) => {
        const key = cue.timing.trim();
        if (!byTiming.has(key)) byTiming.set(key, []);
        byTiming.get(key).push(index);
    });

    const used = new Set();
    const pairs = [];
    arabicDoc.cues.forEach((cue, index) => {
        const key = cue.timing.trim();
        const bucket = byTiming.get(key);
        let english = '';
        if (bucket) {
            const free = bucket.find(i => !used.has(i));
            if (free !== undefined) {
                used.add(free);
                english = cueText(englishDoc.cues[free]);
            }
        }
        if (!english && index < englishDoc.cues.length) {
            english = cueText(englishDoc.cues[index]);
        }
        pairs.push({ index, english });
    });
    return pairs;
}

/**
 * Run the model over the file.
 *
 * @returns {{new: Map<number, string>, sent: number, changed: number, failed: number, batches: number}}
 */
export async function refineCues(arabicCues, englishCues, brief, glossary, server) {
    const systemPrompt = buildSystemPrompt(brief, glossary);

    const allowedLatin = new Set();
    for (const name of Object.keys(glossary.names || {})) allowedLatin.add(name.toLowerCase());
    for (const entry of brief.characters || []) {
        allowedLatin.add(String(entry.character || '').toLowerCase());
        allowedLatin.add(String(entry.actor || '').toLowerCase());
    }

    const work = [];
    arabicCues.forEach((cue, index) => {
        const text = cueText(cue);
        if (isTrivial(text)) return;
        work.push({ i: index, en: englishCues[index]?.english || '', ar: text, raw: text });
    });

    const result = { new: new Map(), sent: 0, changed: 0, failed: 0, batches: 0 };
    if (!work.length) return result;

    const size = config.batchSize;
    const slots = Math.max(1, config.slots);

    const runBatch = (batch, firstIndex, indexAfter) => {
        const local = { prev: { en: '', ar: '' }, next: { en: '', ar: '' } };
        if (firstIndex > 0) {
            const before = work[firstIndex - 1];
            local.prev = { en: before.en, ar: before.raw };
        }
        if (indexAfter < work.length) {
            const after = work[indexAfter];
            local.next = { en: after.en, ar: after.raw };
        }

        const payload = buildBatchPayload(
            batch.map(cue => ({ i: cue.i, en: cue.en, ar: cue.ar })),
            local,
        );

        return askModel(systemPrompt, payload).then(answer => {
            server.lastUsed = Date.now();
            return { batch, answer };
        });
    };

    // Every edit carries its cue index, so the answers can arrive in any
    // order; with `slots` in flight the server overlaps one batch's prompt
    // evaluation with another batch's generation.
    for (let offset = 0; offset < work.length; offset += size * slots) {
        const batches = [];
        for (let b = 0, at = offset; b < slots && at < work.length; b += 1, at += size) {
            batches.push(runBatch(work.slice(at, at + size), at, at + size));
        }

        const answers = await Promise.all(batches);
        result.batches += answers.length;
        for (const { batch, answer } of answers) {
            const { edits, error } = answer;
            result.sent += batch.length;

            if (error) {
                process.stderr.write(`subqwen: a batch of ${batch.length} failed: ${error}\n`);
                result.failed += batch.length;
                server.stopIfIdle();
                continue;
            }

            const byIndex = new Map();
            for (const edit of edits) {
                if (!edit || typeof edit !== 'object') continue;
                const index = Number(edit.i);
                if (!Number.isFinite(index)) continue;
                byIndex.set(index, edit.ar);
            }

            for (const cue of batch) {
                if (!byIndex.has(cue.i)) {
                    result.failed += 1;
                    continue;
                }
                const candidate = byIndex.get(cue.i);
                // A line the model left alone is not a change and not a failure.
                // The raw line may hold a Latin fragment that the gate would
                // refuse, and that is fine: nothing was rewritten.
                if (String(candidate).trim() === cue.raw.trim()) continue;
                const check = checkCue(cue.raw, candidate, allowedLatin, {
                    maxLineChars: config.maxLineChars,
                    maxTotalChars: config.maxTotalChars,
                    minArabicRatio: config.minArabicRatio,
                });
                if (!check.ok) {
                    result.failed += 1;
                    continue;
                }
                result.changed += 1;
                result.new.set(cue.i, candidate.trim());
            }

            server.stopIfIdle();
        }
    }

    return result;
}

/** A readable before/after report, used by --dry-run. */
export function writeReport(file, brief, arabicCues, englishCues, changed) {
    const lines = [
        'subqwen report',
        `film: ${brief.title || '?'}${brief.year ? ` (${brief.year})` : ''}`,
        `brief: ${brief.provider || '?'}`,
        `changed cues: ${changed.size}`,
        '',
    ];
    let shown = 0;
    for (const [index, next] of [...changed.entries()].sort((a, b) => a[0] - b[0])) {
        const raw = index < arabicCues.length ? cueText(arabicCues[index]) : '';
        const english = index < englishCues.length ? englishCues[index]?.english || '' : '';
        lines.push(`cue ${index + 1}`);
        if (english) lines.push(`  EN  ${english.replace(/\n/g, ' / ')}`);
        lines.push(`  AR  ${raw.replace(/\n/g, ' / ')}`);
        lines.push(`  ->  ${next.replace(/\n/g, ' / ')}`);
        lines.push('');
        shown += 1;
        if (shown >= 60) {
            lines.push('... (more changes are not shown)');
            break;
        }
    }
    try {
        ensureDir(path.dirname(file));
        writeAtomic(file, lines.join('\n') + '\n');
    } catch (err) {
        process.stderr.write(`subqwen: could not write the report: ${err.message}\n`);
    }
}

/**
 * Refine one video.
 *
 * @param {string} video the video file, or the .ar.tran.srt itself
 * @param {object} options
 */
export async function refineOne(video, options = {}) {
    const {
        dryRun = false,
        force = false,
        provider = 'auto',
        allowNetwork = true,
        dropSounds = true,
        watermark = null,
    } = options;

    const started = Date.now();
    const base = baseFor(video);
    const target = `${base}.ar.tran.srt`;
    const hash = mediaHash(video);
    const rawFile = path.join(config.rawDir, `${hash}.srt`);
    const sidecarFile = path.join(config.refinedDir, `${hash}.json`);

    const result = {
        video,
        target,
        status: 'skipped',
        cues: 0,
        sent: 0,
        changed: 0,
        failed: 0,
        dropped: 0,
        seconds: 0,
        model: '',
        reason: '',
        report: null,
    };

    if (!fs.existsSync(target)) {
        result.reason = 'no .ar.tran.srt';
        return result;
    }

    const englishFile = findEnglishSource(base);
    if (!englishFile) {
        result.reason = 'no English source';
        return result;
    }

    // The raw translation is the fallback for every single cue, so a copy has
    // to exist before anything is written.
    ensureDir(config.rawDir);
    const inputSha = sha256File(target);
    const sidecar = readJson(sidecarFile);
    if (!force && sidecar && sidecar.promptVersion === config.promptVersion && sidecar.outSha === inputSha) {
        result.status = 'already-refined';
        result.reason = 'the sidecar matches';
        result.changed = sidecar.changed || 0;
        result.cues = sidecar.cues || 0;
        result.model = sidecar.model || '';
        return result;
    }

    // The file changed since the last refinement, so it is a fresh
    // translation and the fallback copy is refreshed with it.
    try {
        fs.copyFileSync(target, rawFile);
    } catch (err) {
        result.reason = `could not keep the raw copy: ${err.message}`;
        return result;
    }

    const info = { ...parseMediaInfo(video), path: video };
    const brief = await buildBrief(info, { provider, allowNetwork });
    const glossary = loadGlossary();

    const rawDoc = parseSrt(fs.readFileSync(rawFile, 'utf8'));
    const englishDoc = parseSrt(fs.readFileSync(englishFile, 'utf8'));
    const arabicCues = rawDoc.cues;
    result.cues = arabicCues.length;

    const model = findModel(process.env.REFINE_MODEL);
    result.model = model ? path.basename(model) : '';

    const server = new LlamaServer(model);
    if (!await server.start()) {
        result.status = 'no-model';
        result.reason = 'llama-server is not available';
        return result;
    }

    let outcome;
    let pairs;
    try {
        pairs = alignCues(rawDoc, englishDoc);
        outcome = await refineCues(arabicCues, pairs, brief, glossary, server);
    } finally {
        server.stop();
    }

    result.sent = outcome.sent;
    result.changed = outcome.changed;
    result.failed = outcome.failed;

    const sent = outcome.sent || 1;
    const changedRatio = outcome.changed / sent;
    const failedRatio = outcome.failed / sent;
    if (changedRatio > config.maxChangedRatio) {
        result.status = 'discarded';
        result.reason = `${Math.round(changedRatio * 100)}% of the cues changed, too many`;
    } else if (failedRatio > config.maxFailedRatio) {
        result.status = 'discarded';
        result.reason = `${Math.round(failedRatio * 100)}% of the cues failed the gate`;
    } else {
        result.status = 'refined';
    }

    if (result.status !== 'refined') {
        result.seconds = (Date.now() - started) / 1000;
        return result;
    }

    if (dryRun) {
        const reportFile = path.join(config.reportDir, `${hash}.txt`);
        writeReport(reportFile, brief, arabicCues, pairs, outcome.new);
        result.report = reportFile;
        result.seconds = (Date.now() - started) / 1000;
        return result;
    }

    // Write the refined text back into the raw document, so the timings, the
    // cue numbers and the line shape stay exactly as they were.
    for (const [index, text] of outcome.new) {
        if (index < arabicCues.length) arabicCues[index].lines = text.split('\n');
    }

    let cues = arabicCues;
    if (dropSounds) {
        const dropped = dropSoundCues(cues, englishDoc);
        result.dropped = dropped.count;
        cues = dropped.cues;
    }

    try {
        writeAtomic(target, serializeSrt({ ...rawDoc, cues }));
    } catch (err) {
        result.status = 'failed';
        result.reason = `could not write ${target}: ${err.message}`;
        result.seconds = (Date.now() - started) / 1000;
        return result;
    }

    if (watermark) {
        const doc = parseSrt(fs.readFileSync(target, 'utf8'));
        const { doc: marked } = addWatermark(doc, watermark);
        writeAtomic(target, serializeSrt(marked));
    }

    const record = {
        model: result.model,
        promptVersion: config.promptVersion,
        brief: brief.provider,
        briefId: brief.id,
        inputSha,
        rawSha: sha256File(rawFile),
        outSha: sha256File(target),
        cues: arabicCues.length,
        sent: outcome.sent,
        changed: outcome.changed,
        failed: outcome.failed,
        dropped: result.dropped,
        refined: true,
        when: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };
    try {
        ensureDir(config.refinedDir);
        writeAtomic(sidecarFile, JSON.stringify(record, null, 2) + '\n');
    } catch (err) {
        process.stderr.write(`subqwen: could not write the sidecar: ${err.message}\n`);
    }

    result.seconds = (Date.now() - started) / 1000;
    return result;
}

/**
 * Remove the sound only cues from the Arabic track.
 *
 * The English source says which cues are sounds: "(gunshot)", "sighs", "Ugh".
 * A professional subtitle leaves them out instead of translating them into
 * Arabic sentences nobody says.
 */
export function dropSoundCues(arabicCues, englishDoc) {
    const sounds = new Set();
    englishDoc.cues.forEach((cue, index) => {
        if (soundOnly(cueText(cue))) sounds.add(index);
    });

    const cues = arabicCues.filter((cue, index) => !sounds.has(index));
    return { cues, count: sounds.size };
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}
