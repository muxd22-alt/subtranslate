// The "movie brief", implemented as a genre -> terminology glossary.
//
// A Marian/Bergamot model takes no free-text prompt, so the only lever we have
// over word choice is terminology. For each genre we keep a small list of
// domain terms; those terms are masked out of the English source with a
// sentinel before translation, and the curated Arabic term is substituted back
// afterwards. The rest of the sentence is translated normally.
//
// IMPORTANT -- this list is much shorter than it first was, and deliberately so.
//
// The engine has no way to inflect a masked word, so masking destroys exactly
// the information Arabic agreement depends on. Measured on device, in sentence
// context, with the sentinel left in place (no restore at all):
//
//   clean   Call a medic, he is bleeding.  ->  اتصل بالمسعف، إنه ينزف.        correct
//   sentin  Call a XQ1QX, he is bleeding.  ->  اتصل XQ1QX بـ XQ1QX إنه ينزف   duplicated + dangling
//
//   clean   One zombie is easy. A horde is not.  ->  واحد الزومبي سهل. حشد ليس كذلك.
//   sentin  One XQ1QX is easy. A XQ2QX is not.   ->  واحد XQ1QX سهل. A XQ2QX ليست كذلك.
//                                                    ("A" untranslated, wrong gender)
//
// The first version of this file listed ~24 terms, chosen after auditing each
// word in ISOLATION. That audit was misleading: out of context the model does
// badly (zombie -> غيبوبي, elf -> القزم), but in a real sentence it is usually
// right (زومبي, الجحافل, الضربة الجوية, المسعفون, يغسلون الأموال). Re-audited in
// context, most terms were dropped because the base model already beat the
// curated one once agreement was taken into account.
//
// A term is kept only when BOTH hold:
//   1. the base model's in-context rendering is wrong, and
//   2. masking still leaves a grammatical sentence.
//
// See docs/model-parallelism.md for the full per-term table and method.

// Chosen because it survives translation intact in every position probed on
// device (mid-sentence, sentence-final, inside quotes, several per line, and
// next to Arabic punctuation).
const sentinel = n => `XQ${n}QX`;
const SENTINEL_RE = /XQ(\d+)QX/gi;

export const GENRES = {
    general: {
        label: 'General',
        terms: {},
    },

    'sci-fi': {
        label: 'Science fiction',
        terms: {
            // plain: اشرب محرك الأقراص الفائقة  ("drink the CD-ROM drive")
            'hyperdrive': 'المحرك الفائق',
        },
    },

    horror: {
        label: 'Horror / zombie',
        terms: {
            // plain: طرد الارتجاز / طرد الارتياد (not a word)
            'exorcism': 'طرد الأرواح',
            // plain: كانوا يقيمون صناعا / بدأ التسلسل (not a seance)
            'seance': 'استحضار الأرواح',
        },
    },

    fantasy: {
        label: 'Fantasy',
        terms: {
            // plain: القزم (that is a dwarf). Masked keeps the sentence readable
            // but can shift the verb to feminine, so it is a net win only
            // because "dwarf" is simply the wrong creature.
            'elf': 'الإلف',
            // plain: العفاز / العفارات (not a word)
            'orc': 'الأورك',
        },
    },

    crime: {
        label: 'Crime',
        terms: {
            // plain: الغوغاء ("the rabble")
            'the mob': 'المافيا',
        },
    },

    // Audited, nothing survived: the base model is already correct in context.
    war: {
        label: 'War',
        terms: {},
    },

    romance: {
        label: 'Romance',
        terms: {},
    },
};

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every glossary term found in `text` with a sentinel, remembering
 * which Arabic term each sentinel stands for.
 * @param {string} text
 * @param {Record<string, string>} terms
 */
export function maskTerms(text, terms) {
    const restore = new Map();
    let out = text;
    let n = 0;

    // Longest first so "the undead" wins over "undead".
    for (const en of Object.keys(terms).sort((a, b) => b.length - a.length)) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(en)}(?![\\p{L}\\p{N}])`, 'giu');
        out = out.replace(re, () => {
            const key = sentinel(++n);
            restore.set(key, terms[en]);
            return key;
        });
    }

    return { masked: out, restore };
}

/**
 * Put the Arabic terms back where the sentinels survived.
 * @param {string} text
 * @param {Map<string, string>} restore
 * @returns {{text: string, complete: boolean}}
 */
export function restoreTerms(text, restore) {
    if (restore.size === 0) return { text, complete: true };

    const seen = new Set();
    const out = text.replace(SENTINEL_RE, m => {
        const key = m.toUpperCase();
        seen.add(key);
        return restore.has(key) ? restore.get(key) : m;
    });

    let complete = true;
    for (const key of restore.keys()) if (!seen.has(key)) complete = false;

    return { text: out, complete };
}

/** Any sentinel left behind means the model mangled the text. */
export function hasResidualSentinel(text) {
    return /XQ\d+QX/i.test(text);
}
