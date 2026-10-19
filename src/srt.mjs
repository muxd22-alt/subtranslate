// Structure-preserving SubRip (.srt) reader/writer.
//
// The only thing subtranslate is allowed to change in a subtitle file is the
// human readable text of each cue. Cue indices, timing lines, cue order, the
// blank-line separators and the exact number of line breaks inside a cue are
// carried over untouched.

const TIMING = /^\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})(.*)$/;
const INDEX = /^\s*\d+\s*$/;

/**
 * @param {string} source raw file contents
 * @returns {{bom: boolean, eol: string, cues: {index: string, timing: string, lines: string[]}[]}}
 */
export function parseSrt(source) {
    const bom = source.charCodeAt(0) === 0xfeff;
    let text = bom ? source.slice(1) : source;

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    text = text.replace(/\r\n?/g, '\n');

    const cues = [];

    for (const block of text.split(/\n[ \t]*\n/)) {
        const lines = block.split('\n');

        while (lines.length && lines[0].trim() === '') lines.shift();
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        if (!lines.length) continue;

        let i = 0;
        let index = '';
        if (INDEX.test(lines[0])) {
            index = lines[0];
            i = 1;
        }

        // Skip anything between the index and the timing line (rare, but some
        // tools emit a stray comment there).
        while (i < lines.length && !TIMING.test(lines[i])) i++;
        if (i >= lines.length) continue;

        cues.push({ index, timing: lines[i], lines: lines.slice(i + 1) });
    }

    return { bom, eol, cues };
}

/**
 * @param {{bom: boolean, eol: string, cues: {index: string, timing: string, lines: string[]}[]}} doc
 * @returns {string}
 */
export function serializeSrt({ bom, eol, cues }) {
    const body = cues
        .map(cue => {
            const parts = [];
            if (cue.index !== '') parts.push(cue.index);
            parts.push(cue.timing, ...cue.lines);
            return parts.join(eol);
        })
        .join(eol + eol);

    return (bom ? '\uFEFF' : '') + body + eol;
}

export function cueText(cue) {
    return cue.lines.join('\n');
}

/** True when a cue has nothing the translator could meaningfully work on. */
export function isTranslatable(text) {
    return /[A-Za-z]/.test(text);
}
