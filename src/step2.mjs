// Step 2: improve the Bergamot draft with quickmt, cue by cue.
//
// The Bergamot model translates one cue at a time, so a sentence split across
// two cues loses its context.  This pass:
//
//   1. merges consecutive cues that are one sentence, translates the whole
//      sentence, and splits the Arabic back across the same cues;
//   2. masks names with sentinels and restores either the glossary spelling or
//      the original Latin name;
//   3. scores the Bergamot line and the quickmt line by back-translating both
//      and comparing them to the English with chrF;
//   4. keeps the quickmt line only when it scores higher and passes the
//      mechanical gate.
//
// Cue numbers, timings and cue order are never touched.  If the service is
// down, the whole pass is skipped and the Bergamot lines stay.

import { cueText, isTranslatable } from './srt.mjs';
import { checkCue } from './qwen-gate.mjs';
import { healthy, translate, back } from './quickmt.mjs';

const SENTENCE_END = /[.!?…]["')\]]*\s*$/;
const CONTINUES = /^[\s"'(\[]*[a-z0-9]/;
const MAX_GROUP = 6;
const MAX_LINE = 42;

const STOP = new Set([
    'i', 'the', 'a', 'an', 'and', 'but', 'or', 'if', 'when', 'what', 'why', 'how',
    'who', 'where', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we',
    'you', 'it', 'my', 'your', 'his', 'her', 'our', 'their', 'there', 'here',
    'yes', 'no', 'ok', 'okay', 'well', 'so', 'then', 'now', 'just', 'not', 'do',
    'did', 'does', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
    'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'get',
    'got', 'go', 'going', 'come', 'came', 'let', 'look', 'wait', 'stop', 'please',
    'thank', 'thanks', 'sorry', 'hello', 'hi', 'hey', 'oh', 'ah', 'um', 'uh',
    'sir', 'maam', 'mister', 'mrs', 'mr', 'ms', 'dr', 'god', 'jesus', 'christ',
]);

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merge consecutive cues that are one sentence.
 * @returns {{idx: number[], texts: string[]}[]}
 */
export function mergeCues(cues) {
    const groups = [];
    let current = null;

    cues.forEach((cue, i) => {
        const text = cueText(cue).replace(/\s+/g, ' ').trim();
        if (!text) { current = null; return; }
        if (!current) { current = { idx: [i], texts: [text] }; return; }

        const prev = current.texts[current.texts.length - 1];
        const canMerge = !SENTENCE_END.test(prev)
            && (CONTINUES.test(text) || /[,;:–—-]\s*$/.test(prev));

        if (canMerge && current.texts.length < MAX_GROUP) {
            current.idx.push(i);
            current.texts.push(text);
        } else {
            groups.push(current);
            current = { idx: [i], texts: [text] };
        }
    });

    if (current) groups.push(current);
    return groups;
}

/**
 * Split one Arabic sentence across cues, proportional to the English lengths.
 * Every cue gets at least one word when there are enough words.
 */
export function splitBack(arabic, weights) {
    const words = String(arabic || '').split(/\s+/).filter(Boolean);
    const n = weights.length;
    if (!n) return [];
    if (!words.length) return Array(n).fill('');
    if (n === 1) return [words.join(' ')];

    const total = weights.reduce((a, b) => a + b, 0) || n;
    const parts = [];
    let start = 0;
    let acc = 0;

    for (let i = 0; i < n; i++) {
        acc += weights[i];
        let end = i === n - 1 ? words.length : Math.round((words.length * acc) / total);
        end = Math.max(start + 1, Math.min(end, words.length - (n - 1 - i)));
        parts.push(words.slice(start, end).join(' '));
        start = end;
    }
    return parts;
}

/** Wrap to at most two lines, around MAX_LINE characters. */
export function wrapLines(text, max = MAX_LINE) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [''];
    if (clean.length <= max) return [clean];

    const words = clean.split(' ');
    if (words.length < 2) return [clean];

    let best = null;
    for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' ');
        const b = words.slice(i).join(' ');
        const score = Math.abs(a.length - max) + Math.abs(b.length - max);
        if (!best || score < best.score) best = { a, b, score };
    }
    return [best.a, best.b];
}

/** Capitalised names that appear away from the start of a sentence. */
export function collectNames(texts) {
    const names = new Set();
    for (const text of texts) {
        for (const sentence of String(text).split(/(?<=[.!?…])\s+/)) {
            const found = sentence.match(/\b[A-Z][a-z]{1,}\b|\b[A-Z]{2,}\b/g) || [];
            for (const word of found) {
                if (sentence.trim().startsWith(word)) continue;
                if (STOP.has(word.toLowerCase())) continue;
                names.add(word);
            }
        }
    }
    return names;
}

export function maskNames(text, names, terms = {}) {
    const restore = new Map();
    let out = text;
    let n = 0;

    for (const name of [...names].sort((a, b) => b.length - a.length)) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'gu');
        out = out.replace(re, () => {
            const key = `XQ${++n}QX`;
            const arabic = terms[name] || terms[name.toLowerCase()] || null;
            restore.set(key, { name, arabic });
            return key;
        });
    }

    return { masked: out, restore };
}

export function restoreNames(text, restore) {
    let out = text;
    const allowed = new Set();
    for (const [key, info] of restore) {
        out = out.replace(new RegExp(key, 'gi'), info.arabic || info.name);
        if (!info.arabic) allowed.add(info.name.toLowerCase());
    }
    return { text: out, allowed, complete: !/XQ\d+QX/i.test(out) };
}

function ngrams(s, n) {
    const map = new Map();
    for (let i = 0; i + n <= s.length; i++) {
        const g = s.slice(i, i + n);
        map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
}

/** Character n-gram F-score (chrF2), 0..1. */
export function chrf(hyp, ref, { maxN = 6, beta = 2 } = {}) {
    const h = String(hyp || '');
    const r = String(ref || '');
    if (!h || !r) return 0;

    let sum = 0;
    for (let n = 1; n <= maxN; n++) {
        const hm = ngrams(h, n);
        const rm = ngrams(r, n);
        let overlap = 0;
        for (const [g, c] of hm) if (rm.has(g)) overlap += Math.min(c, rm.get(g));
        const p = overlap / Math.max(1, h.length - n + 1);
        const rec = overlap / Math.max(1, r.length - n + 1);
        const b2 = beta * beta;
        sum += p + rec ? ((1 + b2) * p * rec) / (b2 * p + rec) : 0;
    }
    return sum / maxN;
}

/** Back-translate in bounded requests so a long film cannot hit the timeout. */
async function backAll(lines, beam) {
    const out = [];
    for (let i = 0; i < lines.length; i += 32) {
        const slice = lines.slice(i, i + 32);
        out.push(...await back(slice, { beam, timeout: 300000 }));
    }
    return out;
}

function arabicRatio(english, arabic) {
    const ar = (String(arabic).match(/\p{Script=Arabic}/gu) || []).length;
    const en = (String(english).match(/[A-Za-z]/g) || []).length || 1;
    return ar / en;
}

const GATE = { maxLineChars: 45, maxTotalChars: 95, minArabicRatio: 0.5 };

/**
 * Run step 2 over a translated document in place.
 * @returns {null | {groups:number,candidates:number,changed:number,back:boolean,ms:number}}
 */
export async function runStep2(doc, sourceDoc, { terms = {}, log = console } = {}) {
    if (String(process.env.STEP2 || 'on').toLowerCase() === 'off') return null;

    const started = Date.now();
    if (!(await healthy())) {
        log.warn('step2: quickmt is not answering; keeping the Bergamot lines');
        return null;
    }

    const mode = String(process.env.STEP2_MODE || 'weak').toLowerCase() === 'full' ? 'full' : 'weak';
    const weakPct = Math.max(1, Math.min(100, Number(process.env.WEAK_PCT || 10)));
    const beam = Math.max(1, Math.min(10, Number(process.env.QUICKMT_BEAM || 4)));
    const scoreMode = String(process.env.STEP2_SCORE || 'gate').toLowerCase() === 'chrf' ? 'chrf' : 'gate';

    // Judge the Bergamot draft first, so only the groups that hold a weak cue
    // are sent to quickmt. Translating every sentence would blow the budget.
    const rowsAll = [];
    sourceDoc.cues.forEach((cue, i) => {
        const english = cueText(cue).replace(/\s+/g, ' ').trim();
        if (!isTranslatable(english)) return;
        const raw = cueText(doc.cues[i]).trim();
        if (!raw) return;
        rowsAll.push({
            i,
            english,
            raw,
            weakness: arabicRatio(english, raw),
            rawOk: checkCue(raw, raw, new Set(), GATE).ok,
        });
    });

    const selected = new Set();
    if (mode === 'full') {
        for (const row of rowsAll) selected.add(row.i);
    } else {
        const sorted = [...rowsAll].sort((a, b) => a.weakness - b.weakness);
        const take = Math.max(1, Math.ceil((sorted.length * weakPct) / 100));
        for (const row of sorted.slice(0, take)) selected.add(row.i);
        for (const row of rowsAll) if (!row.rawOk) selected.add(row.i);
    }

    const groups = mergeCues(sourceDoc.cues)
        .filter(g => isTranslatable(g.texts.join(' ')))
        .filter(g => g.idx.some(i => selected.has(i)));

    const names = collectNames(sourceDoc.cues.map(cueText));
    const allowed = new Set();
    const candidates = new Map();
    let dropped = 0;
    const tTranslate = Date.now();

    for (let start = 0; start < groups.length; start += 16) {
        const slice = groups.slice(start, start + 16);
        const prepared = slice.map(g => {
            const english = g.texts.join(' ');
            return { ...g, english, ...maskNames(english, names, terms) };
        });

        const out = await translate(prepared.map(p => p.masked), { beam, timeout: 300000 });

        prepared.forEach((g, k) => {
            const restored = restoreNames(out[k], g.restore);
            if (!restored.complete) { dropped++; return; }
            for (const name of restored.allowed) allowed.add(name);

            const parts = splitBack(restored.text, g.texts.map(t => t.length));
            g.idx.forEach((cueIndex, j) => {
                const lines = wrapLines(parts[j]);
                if (lines.length && lines[0]) candidates.set(cueIndex, lines);
            });
        });
    }

    const translateMs = Date.now() - tTranslate;

    const chosen = rowsAll
        .filter(row => selected.has(row.i) && candidates.has(row.i))
        .map(row => ({ ...row, quick: candidates.get(row.i).join('\n') }));

    let backOk = false;
    let rawScore = null;
    let quickScore = null;
    const tScore = Date.now();

    if (chosen.length && scoreMode === 'chrf') {
        try {
            const [bRaw, bQuick] = await Promise.all([
                backAll(chosen.map(r => r.raw), beam),
                backAll(chosen.map(r => r.quick), beam),
            ]);
            rawScore = bRaw.map((t, k) => chrf(t, chosen[k].english));
            quickScore = bQuick.map((t, k) => chrf(t, chosen[k].english));
            backOk = true;
        } catch (err) {
            log.warn(`step2: back-translation unavailable (${err.message}); using the gate only`);
        }
    }

    let changed = 0;
    chosen.forEach((row, k) => {
        const gate = checkCue(row.raw, row.quick, allowed, GATE);
        if (!gate.ok) return;
        const keep = backOk
            ? quickScore[k] > rawScore[k] + 0.005
            : !row.rawOk;
        if (!keep) return;
        doc.cues[row.i].lines = candidates.get(row.i);
        changed++;
    });

    const scoreMs = Date.now() - tScore;
    const stats = {
        groups: groups.length,
        candidates: chosen.length,
        changed,
        dropped,
        back: backOk,
        mode,
        score: scoreMode,
        translateMs,
        scoreMs,
        ms: Date.now() - started,
    };
    log.info(
        `step2: mode=${stats.mode} score=${stats.score} groups=${stats.groups} candidates=${stats.candidates} `
        + `changed=${stats.changed} dropped=${stats.dropped} back=${stats.back} `
        + `2a=${(translateMs / 1000).toFixed(1)}s 2c=${(scoreMs / 1000).toFixed(1)}s `
        + `total=${(stats.ms / 1000).toFixed(1)}s`,
    );
    return stats;
}
