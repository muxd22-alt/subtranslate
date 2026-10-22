// The prompt: one system prompt for the whole film, one small JSON message
// per batch.
//
// The model never sees a cue number or a timing. It sees the English line,
// the Arabic line and the lines around it, and it answers with the same
// indexes it was given.

import { toneFor } from './qwen-brief.mjs';

/**
 * The system prompt. It is static for a film: one prompt for all batches.
 *
 * @param {object} brief
 * @param {{names: object, terms: object, tone: string}} glossary
 */
export function buildSystemPrompt(brief, glossary = { names: {}, terms: {}, tone: '' }) {
    const genre = brief.genres && brief.genres.length ? brief.genres : [];
    const { label, tone } = toneFor(brief.genres || []);
    const lines = [
        'You are a professional Arabic subtitle editor working on a feature film.',
        'You get an English line, a machine translated Arabic line, and the lines around it.',
        'Your job: make the Arabic read like it was written by a professional subtitle translator.',
        'Fix real errors, and also fix wording that is wrong, stiff or a literal calque from the English.',
        'Most lines just need small touches; return them unchanged only when they are already natural.',
        'Rules:',
        '- Never change the meaning. Do not add, drop or invent anything.',
        '- Correct gender agreement (he/she, his/her, verbs that mark gender) using the character',
        '  genders below. Never guess a gender that is not given.',
        '- Use the given Arabic spelling for names. Keep terminology consistent across the film.',
        '- Style: natural, concise, spoken-feeling Modern Standard Arabic; idioms sound Arabic,',
        '  not translated. At most 2 lines, about 42 characters per line.',
        '- Keep <i> tags, the music note, speaker dashes, ellipses and the line breaks.',
        '- Do not merge or split cues. One answer per cue you were given.',
        '- If a line is unreadable or you are not sure, return the Arabic unchanged.',
        '- Output JSON only. No explanation.',
        '',
        `FILM: ${brief.title || 'unknown'}${brief.year ? ` (${brief.year})` : ''}`,
    ];
    if (brief.titleAr) lines.push(`ARABIC TITLE: ${brief.titleAr}`);
    if (genre.length) lines.push(`GENRES: ${genre.slice(0, 6).join(', ')}`);
    lines.push(`TONE: ${label} ${glossary.tone || tone}`);
    if (brief.overview) lines.push(`SUMMARY: ${String(brief.overview).slice(0, 300)}`);

    if (brief.characters && brief.characters.length) {
        lines.push('CHARACTERS (gender is given, never guess it):');
        for (const entry of brief.characters) {
            lines.push(`- ${entry.character || '?'} | actor ${entry.actor || '?'} | ${entry.gender || 'unknown'}`);
        }
    }

    const names = glossary.names || {};
    if (Object.keys(names).length) {
        lines.push('NAMES (use exactly this Arabic spelling):');
        for (const [english, arabic] of Object.entries(names).slice(0, 40)) {
            lines.push(`- ${english} -> ${arabic}`);
        }
    }

    const terms = glossary.terms || {};
    if (Object.keys(terms).length) {
        lines.push('TERMS (use exactly this Arabic word):');
        for (const [english, arabic] of Object.entries(terms).slice(0, 40)) {
            lines.push(`- ${english} -> ${arabic}`);
        }
    }

    lines.push('');
    lines.push('The answer is JSON only, one entry per cue you were given, same index:');
    lines.push('{"edits":[{"i":1,"ar":"النص العربي المصلح"}]}');
    lines.push('Example of a batch of two cues (English -> machine Arabic -> your answer):');
    lines.push('i=1  EN "She said that he is waiting for us downstairs."');
    lines.push('     AR "قالت أنه انتظارنا في أسفل."   (unnatural, wrong gender form)');
    lines.push('     -> {"i":1,"ar":"قالت إنه ينتظرنا في الطابق السفلي."}');
    lines.push('i=2  EN "Come on, we have no time for this."');
    lines.push('     AR "هيا، ليس لدينا وقت لهذا."     (already natural)');
    lines.push('     -> {"i":2,"ar":"هيا، ليس لدينا وقت لهذا."}');
    return lines.join('\n');
}

function toneForBriefRemoved() {}

/**
 * The message for one batch: the cues to edit and the read only neighbours.
 *
 * The neighbours are context. They are not in the answer, and the answer must
 * carry exactly the indexes of the cues that were sent.
 */
export function buildBatchPayload(cues, context = {}) {
    return {
        context: {
            prev: context.prev || { en: '', ar: '' },
            next: context.next || { en: '', ar: '' },
        },
        cues,
    };
}

/** The schema the server decodes against. The model cannot invent fields. */
export function responseSchema() {
    return {
        type: 'json_schema',
        schema: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            i: { type: 'integer' },
                            ar: { type: 'string' },
                        },
                        required: ['i', 'ar'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['edits'],
            additionalProperties: false,
        },
    };
}
