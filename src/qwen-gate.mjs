// The gatekeeper: the part that decides whether a rewritten line may replace
// the raw one.
//
// The model is small, so the model cannot be trusted to be careful. Every
// check here is mechanical, and a line that fails any of them keeps the raw
// Bergamot text.
//
// The checks are:
//   * the line is not empty and holds no explanation
//   * it is mostly Arabic
//   * it has no Latin left over except the names the brief and the glossary
//     know about
//   * it has no more lines than the original, and at most two
//   * it is not longer than the style budget
//   * the italics, the music note and the speaker dashes survived
//   * the numbers are the same numbers

const ARABIC_RE = /\p{Script=Arabic}/gu;
const LATIN_RE = /[A-Za-z]/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z'.-]*/g;
const DIGIT_RE = /[0-9]+/g;
const TAG_RE = /<[^>]+>/g;
const NOTE_RE = /♪+/g;
const DASH_RE = /^\s*[-–—]\s/gm;

// Arabic-Indic and Extended Arabic-Indic digits are the same numbers written
// differently, so they are folded onto ASCII before they are compared.
const DIGIT_FOLD = new Map([
    [0x0660, 0x0030], [0x0661, 0x0031], [0x0662, 0x0032], [0x0663, 0x0033], [0x0664, 0x0034],
    [0x0665, 0x0035], [0x0666, 0x0036], [0x0667, 0x0037], [0x0668, 0x0038], [0x0669, 0x0039],
    [0x06F0, 0x0030], [0x06F1, 0x0031], [0x06F2, 0x0032], [0x06F3, 0x0033], [0x06F4, 0x0034],
    [0x06F5, 0x0035], [0x06F6, 0x0036], [0x06F7, 0x0037], [0x06F8, 0x0038], [0x06F9, 0x0039],
]);

// A model that starts explaining instead of editing is caught here.
const EXPLANATION_MARKERS = [
    '```',
    '<think>',
    '</think>',
    'here is',
    "here's",
    'translation:',
    'corrected:',
    'note:',
    'i cannot',
    "i can't",
    'as an ai',
    'sorry',
    'الترجمة',
    'ترجمة:',
    'لا أستطيع',
    'سأقوم',
    'إليك',
];

/** Arabic-Indic digits become ASCII so numbers can be compared. */
export function foldDigits(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        out += String.fromCharCode(DIGIT_FOLD.get(code) ?? code);
    }
    return out;
}

export function latinWords(text) {
    return new Set((text.match(LATIN_WORD_RE) || []).map(w => w.toLowerCase()));
}

function count(re, text) {
    return (text.match(re) || []).length;
}

/** The style marks a line carries: italics, music note, speaker dashes. */
export function tagSignature(text) {
    const signature = new Map();
    const bump = tag => signature.set(tag, (signature.get(tag) || 0) + 1);
    for (const tag of text.match(TAG_RE) || []) bump(tag);
    for (const note of text.match(NOTE_RE) || []) bump(note);
    signature.set('dash', count(DASH_RE, text));
    return signature;
}

function sameSignature(a, b) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
        if (b.get(key) !== value) return false;
    }
    return true;
}

/** The numbers of a line, sorted, with Arabic-Indic digits folded. */
export function numbersIn(text) {
    return (foldDigits(text).match(DIGIT_RE) || []).sort();
}

/** Take the allowed names out of a line, so they do not count as Latin. */
function stripAllowedLatin(text, allowedLatin) {
    if (!allowedLatin || allowedLatin.size === 0) return text;
    let out = text;
    for (const word of allowedLatin) {
        if (!word) continue;
        const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        out = out.replace(re, ' ');
    }
    return out;
}

/**
 * Decide whether one rewritten line may replace the raw one.
 *
 * @param {string} raw the Bergamot line
 * @param {string} candidate the model's line
 * @param {Set<string>} allowedLatin names that may stay in Latin script
 * @param {{maxLineChars?: number, maxTotalChars?: number, minArabicRatio?: number}} options
 * @returns {{ok: boolean, reason: string}}
 */
export function checkCue(raw, candidate, allowedLatin = new Set(), options = {}) {
    const maxLineChars = options.maxLineChars ?? 60;
    const maxTotalChars = options.maxTotalChars ?? 120;
    const minArabicRatio = options.minArabicRatio ?? 0.5;

    if (typeof candidate !== 'string') return { ok: false, reason: 'no text' };

    const text = candidate.trim();
    if (!text) return { ok: false, reason: 'empty' };

    const rawText = String(raw || '').trim();
    const rawLines = rawText.split('\n');
    const newLines = text.split('\n');

    const lowered = text.toLowerCase();
    for (const marker of EXPLANATION_MARKERS) {
        if (lowered.includes(marker)) return { ok: false, reason: 'explanation text' };
    }

    const arabic = count(ARABIC_RE, text);
    // A name that is allowed to stay in Latin script does not count against
    // the line: "سألت Alice" is an Arabic line with a name in it.
    const withoutNames = stripAllowedLatin(text, allowedLatin);
    const latin = count(LATIN_RE, withoutNames);
    if (arabic + latin > 0 && arabic / (arabic + latin) < minArabicRatio) {
        return { ok: false, reason: 'not mostly Arabic' };
    }

    const leftover = [...latinWords(text)].filter(word => !allowedLatin.has(word));
    if (leftover.length) {
        return { ok: false, reason: `left over Latin: ${leftover.slice(0, 3).join(', ')}` };
    }

    const limit = Math.min(rawLines.length, 2);
    if (newLines.length > limit) {
        return { ok: false, reason: `${newLines.length} lines, allowed ${limit}` };
    }

    for (const line of newLines) {
        if (line.length > maxLineChars) {
            return { ok: false, reason: `line too long (${line.length})` };
        }
    }
    if (text.length > maxTotalChars) return { ok: false, reason: `too long (${text.length})` };
    if (text.length > 2 * rawText.length + 30) {
        return { ok: false, reason: 'much longer than the original' };
    }

    if (!sameSignature(tagSignature(text), tagSignature(rawText))) {
        return { ok: false, reason: 'tags or dashes changed' };
    }

    const rawNumbers = numbersIn(rawText);
    const newNumbers = numbersIn(text);
    if (rawNumbers.length !== newNumbers.length || rawNumbers.some((n, i) => n !== newNumbers[i])) {
        return { ok: false, reason: 'numbers changed' };
    }

    return { ok: true, reason: 'ok' };
}
