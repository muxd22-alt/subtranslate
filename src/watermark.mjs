// The watermark cue.
//
// The first four seconds of every subtitle carry the name of the tool that
// made it. The cue sits at the top of the file and covers 00:00:00 to
// 00:00:04.
//
// The timings of the other cues are never touched. Only the numbering is made
// sequential again, because that is what every player expects, and a gap in
// the numbering makes some tools drop cues.

import fs from 'node:fs';
import { parseSrt, serializeSrt } from './srt.mjs';
import { writeAtomic } from './atomic.mjs';

export const DEFAULT_WATERMARK = 'done by SubTranslate';
export const WATERMARK_TIMING = '00:00:00,000 --> 00:00:04,000';

/**
 * Put the watermark cue at the top of a document.
 *
 * @param {{cues: {index: string, timing: string, lines: string[]}[]}} doc
 * @param {string} text the watermark text
 * @returns {{doc: object, added: boolean}}
 */
export function addWatermark(doc, text = DEFAULT_WATERMARK) {
    const label = String(text || '').trim();
    if (!label) return { doc, added: false };

    const first = doc.cues[0];
    if (first && first.lines.length === 1 && first.lines[0].trim() === label) {
        return { doc, added: false };
    }

    const cues = [
        { index: '', timing: WATERMARK_TIMING, lines: [label] },
        ...doc.cues,
    ];
    cues.forEach((cue, index) => {
        cue.index = String(index + 1);
    });

    return { doc: { ...doc, cues }, added: true };
}

/**
 * Add the watermark to a subtitle file if it is not there yet.
 *
 * @param {string} file
 * @param {string} text
 * @returns {boolean} true when the file was changed
 */
export function ensureWatermarkFile(file, text = DEFAULT_WATERMARK) {
    const source = fs.readFileSync(file, 'utf8');
    const doc = parseSrt(source);
    const { doc: marked, added } = addWatermark(doc, text);
    if (!added) return false;
    writeAtomic(file, serializeSrt(marked));
    return true;
}
