// Which cues are sounds rather than words.
//
// A machine translated subtitle usually carries the sound descriptions of the
// English track: "(gunshot)", "sighs", "Ugh". Translated into Arabic they turn
// into sentences that nobody says out loud, and the track reads like a script
// with stage directions in it.
//
// Professional subtitles leave non speech sounds out. The rule here is
// deliberately narrow, because a wrong guess deletes real dialogue:
//
//   * the whole cue is one bracketed group  -> a sound description
//   * the cue is one bare interjection       -> a sound
//
// Everything else is dialogue and stays.

const INTERJECTIONS = new Set([
    'ugh', 'ughh', 'uh', 'uhh', 'um', 'umm', 'ummm', 'mm', 'mmm', 'mhm',
    'hm', 'hmm', 'hmmm', 'ah', 'ahh', 'aah', 'oh', 'ohh', 'ooh', 'oohs',
    'huh', 'eh', 'ehh', 'argh', 'arg', 'ouch', 'oops', 'yuck', 'ugh-oh',
    'mm-hmm', 'mmhmm', 'huh-huh',
]);

// Sound verbs that stand alone on a line.
const SOUND_VERBS = new Set([
    'sigh', 'sighs', 'sighing', 'laugh', 'laughs', 'laughing', 'chuckle',
    'chuckles', 'chuckling', 'scream', 'screams', 'screaming', 'cough',
    'coughs', 'coughing', 'grunt', 'grunts', 'grunting', 'groan', 'groans',
    'groaning', 'gasp', 'gasps', 'gasping', 'wheeze', 'wheezes', 'wheezing',
    'sniff', 'sniffs', 'sniffing', 'sob', 'sobs', 'sobbing', 'cry', 'cries',
    'crying', 'sneeze', 'sneezes', 'sneezing', 'burp', 'burps', 'giggle',
    'giggles', 'giggling', 'moan', 'moans', 'moaning', 'whimper', 'whimpers',
    'whimpering', 'shout', 'shouts', 'shouting', 'yell', 'yells', 'yelling',
    'squeal', 'squeals', 'squealing', 'chirp', 'chirps', 'chattering',
    'clatter', 'clatters', 'thud', 'thuds', 'bang', 'bangs', 'boom', 'booms',
    'crash', 'crashes', 'knock', 'knocks', 'clang', 'clangs', 'beep', 'beeps',
    'squeak', 'squeaks', 'rustle', 'rustles', 'thunder', 'rumbles', 'hisses',
    'hiss', 'buzz', 'buzzes', 'click', 'clicks', 'clicks', 'rings', 'ring',
]);

const BRACKETED_RE = /^\s*[\[(][^\])]*[\])]\s*$/;

/**
 * True when a cue carries a sound and no words.
 * @param {string} text the cue text, one language or the other
 */
export function soundOnly(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;

    // A cue that is one bracketed group is a description of a sound.
    if (BRACKETED_RE.test(trimmed)) return true;

    // A cue that is a single bare word is either an interjection or a sound
    // verb. Anything longer is a sentence, so it is dialogue.
    const words = trimmed
        .replace(/[.!?…,]+$/, '')
        .split(/\s+/)
        .filter(Boolean);
    if (words.length !== 1) return false;

    const word = words[0].toLowerCase().replace(/^[-–—]+|[-–—]+$/g, '');
    if (!word) return false;
    if (INTERJECTIONS.has(word)) return true;
    if (SOUND_VERBS.has(word)) return true;

    // A single word that is not a word at all is a sound effect label.
    if (/^(?:sfx|sound|noise)[.:]?$/i.test(word)) return true;

    return false;
}

/**
 * The sound cues of a parsed subtitle, as a set of cue positions.
 * @param {{cues: {lines: string[]}[]}} doc
 */
export function soundCuePositions(doc) {
    const out = new Set();
    doc.cues.forEach((cue, index) => {
        if (soundOnly(cue.lines.join('\n'))) out.add(index);
    });
    return out;
}
