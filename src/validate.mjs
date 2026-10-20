// Decide whether a translated subtitle is usable.
//
// The check is deliberately mechanical: it compares the Arabic in the output
// with the English in the source and with the translation's own cue coverage.
// It catches the two failure modes seen on device:
//
//   * the model passed English through (no Arabic at all)
//   * the model translated only part of the file
//
// Thresholds were calibrated on the five movies in the phone library. Their
// good translations measured 0.986-0.999 Arabic by letter, 0.999-1.0 cue
// coverage, and at most 0.0012 English-only cues. The defaults leave roughly a
// ten-point margin below those numbers.

const ARABIC = /\p{Script=Arabic}/gu;
const LATIN = /[A-Za-z]/g;
const TRANSLATABLE = /[A-Za-z]/;

export const DEFAULT_THRESHOLDS = Object.freeze({
    minArabicRatio: 0.88,
    minArabicCueRatio: 0.9,
    maxPassthroughRatio: 0.1,
    minSourceCueCoverage: 0.85,
});

const count = (text, re) => (text.match(re) || []).length;
const cueText = cue => cue.lines.join('\n');
const ratio = (n, d) => (d ? n / d : 0);

/**
 * @param {{cues: {lines: string[]}[]}} sourceDoc parsed original English
 * @param {{cues: {lines: string[]}[]}} outputDoc parsed translated Arabic
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} options
 */
export function validateTranslation(sourceDoc, outputDoc, options = {}) {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...options };
    const sourceCues = sourceDoc.cues || [];
    const outputCues = outputDoc.cues || [];

    let sourceTranslatable = 0;
    for (const cue of sourceCues) {
        if (TRANSLATABLE.test(cueText(cue))) sourceTranslatable++;
    }

    let arabicLetters = 0;
    let latinLetters = 0;
    let arabicCues = 0;
    let letteredCues = 0;
    let passthroughCues = 0;
    for (const cue of outputCues) {
        const text = cueText(cue);
        const ar = count(text, ARABIC);
        const la = count(text, LATIN);
        arabicLetters += ar;
        latinLetters += la;
        if (ar + la > 0) letteredCues++;
        if (ar > 0) arabicCues++;
        else if (la > 0) passthroughCues++;
    }

    const metrics = {
        sourceCues: sourceCues.length,
        outputCues: outputCues.length,
        sourceTranslatable,
        outputLetteredCues: letteredCues,
        outputArabicCues: arabicCues,
        passthroughCues,
        arabicLetters,
        latinLetters,
        arabicRatio: ratio(arabicLetters, arabicLetters + latinLetters),
        arabicCueRatio: ratio(arabicCues, letteredCues),
        passthroughRatio: ratio(passthroughCues, letteredCues),
        sourceCueCoverage: sourceTranslatable ? Math.min(1, arabicCues / sourceTranslatable) : 1,
    };

    const reasons = [];
    if (!outputCues.length) {
        reasons.push('output has no cues');
    } else if (sourceTranslatable > 0) {
        if (metrics.arabicRatio < thresholds.minArabicRatio) {
            reasons.push(`Arabic letter ratio ${metrics.arabicRatio.toFixed(3)} < ${thresholds.minArabicRatio}`);
        }
        if (metrics.arabicCueRatio < thresholds.minArabicCueRatio) {
            reasons.push(`Arabic cue ratio ${metrics.arabicCueRatio.toFixed(3)} < ${thresholds.minArabicCueRatio}`);
        }
        if (metrics.passthroughRatio > thresholds.maxPassthroughRatio) {
            reasons.push(`English-only cue ratio ${metrics.passthroughRatio.toFixed(3)} > ${thresholds.maxPassthroughRatio}`);
        }
        if (metrics.sourceCueCoverage < thresholds.minSourceCueCoverage) {
            reasons.push(`source cue coverage ${metrics.sourceCueCoverage.toFixed(3)} < ${thresholds.minSourceCueCoverage}`);
        }
    }

    return { ok: reasons.length === 0, metrics, reasons, thresholds };
}

/** One line for a log: enough to diagnose without dumping subtitle text. */
export function formatValidation(result) {
    const m = result.metrics;
    const pct = n => `${(n * 100).toFixed(1)}%`;
    return [
        `arabic=${pct(m.arabicRatio)}`,
        `arabic-cues=${pct(m.arabicCueRatio)}`,
        `passthrough=${pct(m.passthroughRatio)}`,
        `source-coverage=${pct(m.sourceCueCoverage)}`,
        `cues=${m.outputCues}/${m.sourceCues}`,
    ].join(' ');
}
