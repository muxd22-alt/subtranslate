import { cueText, isTranslatable } from './srt.mjs';
import { maskTerms, restoreTerms, hasResidualSentinel } from './glossary.mjs';

const lineCount = s => s.replace(/\n+$/, '').split('\n').length;

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

    const total = work.length;
    let reported = 0;
    const progress = (done, phaseTotal, base) => {
        const overall = Math.min(total, base + Math.min(done, phaseTotal));
        if (overall <= reported) return;
        reported = overall;
        onProgress?.(overall, total);
    };
    onProgress?.(0, total);

    // Pass 1: glossary terms masked out, whole cue translated as one string so
    // the line breaks inside the cue are preserved by the model.
    const items = work.map(w => {
        const { masked, restore } = maskTerms(w.text, terms);
        return { cue: w.cue, text: w.text, masked, restore, result: null };
    });

    const out1 = await engine.translateMany(items.map(i => i.masked), {
        chunkSize: chunk,
        onProgress: (done, phaseTotal) => progress(done, phaseTotal, 0),
    });

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
        const base = work.length - retry.length;
        const out2 = await engine.translateMany(retry.map(i => i.text), {
            chunkSize: chunk,
            onProgress: (done, phaseTotal) => progress(done, phaseTotal, base),
        });
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
                const base = work.length - retry2.length;
                const out3 = await engine.translateMany(jobs.map(j => j.line), {
                    chunkSize: chunk,
                    onProgress: done => progress(
                        Math.round((done / jobs.length) * retry2.length),
                        retry2.length,
                        base,
                    ),
                });
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
