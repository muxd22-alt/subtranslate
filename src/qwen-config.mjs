// Where the refine stage keeps its files and what it talks to.
//
// The defaults follow the phone workflow: the raw Bergamot output, the movie
// briefs and the sidecars live under ~/.cache/subgrab, the TMDB key and the
// user glossary under ~/.config/subgrab. Every path can be pointed somewhere
// else with an environment variable, so the command also works on a laptop.

import os from 'node:os';
import path from 'node:path';

const HOME = process.env.HOME || os.homedir();

function num(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
    home: HOME,

    cacheDir: process.env.REFINE_CACHE || path.join(HOME, '.cache', 'subgrab'),
    configDir: process.env.REFINE_CONFIG || path.join(HOME, '.config', 'subgrab'),

    rawDir: path.join(process.env.REFINE_CACHE || path.join(HOME, '.cache', 'subgrab'), 'raw'),
    briefDir: path.join(process.env.REFINE_CACHE || path.join(HOME, '.cache', 'subgrab'), 'brief'),
    refinedDir: path.join(process.env.REFINE_CACHE || path.join(HOME, '.cache', 'subgrab'), 'refined'),
    reportDir: path.join(process.env.REFINE_CACHE || path.join(HOME, '.cache', 'subgrab'), 'reports'),

    tmdbKeyFile: process.env.REFINE_TMDB_KEY_FILE || path.join(HOME, '.config', 'subgrab', 'tmdb-key'),
    glossaryFile: process.env.REFINE_GLOSSARY_FILE || path.join(HOME, '.config', 'subgrab', 'glossary.json'),

    modelDir: process.env.REFINE_MODEL_DIR || path.join(HOME, 'models'),
    serverUrl: process.env.REFINE_SERVER || `http://127.0.0.1:${num('REFINE_PORT', 8081)}`,
    serverHost: process.env.REFINE_HOST || '127.0.0.1',
    serverPort: num('REFINE_PORT', 8081),
    serverThreads: num('REFINE_THREADS', 4),
    serverCtx: num('REFINE_CTX', 4096),
    serverIdle: Number(process.env.REFINE_IDLE ?? 300),
    serverNice: Number(process.env.REFINE_NICE ?? 10),
    bootTimeout: num('REFINE_BOOT_TIMEOUT', 180),

    temperature: Number(process.env.REFINE_TEMPERATURE ?? 0.1),
    topP: Number(process.env.REFINE_TOP_P ?? 0.9),
    maxTokens: num('REFINE_MAX_TOKENS', 1024),
    batchSize: num('REFINE_BATCH', 8),
    httpTimeout: num('REFINE_HTTP_TIMEOUT', 30),

    // The gate refuses a refinement that rewrites more than this share of the
    // cues, or that loses this share of the cues to a failed check. Both mean
    // the model went off the rails and the raw translation is safer.
    maxChangedRatio: Number(process.env.REFINE_MAX_CHANGED ?? 0.6),
    maxFailedRatio: Number(process.env.REFINE_MAX_FAILED ?? 0.25),

    // Style limits. 42 characters per line is the usual subtitle budget; the
    // gate allows slack so a correct line is not thrown away over two
    // characters.
    maxLineChars: num('REFINE_MAX_LINE_CHARS', 60),
    maxTotalChars: num('REFINE_MAX_TOTAL_CHARS', 120),
    minArabicRatio: Number(process.env.REFINE_MIN_ARABIC ?? 0.5),

    // Bump this whenever the system prompt or the gate changes. The sidecar
    // stores it, so an old refinement is redone instead of being trusted.
    promptVersion: process.env.REFINE_PROMPT_VERSION || 'v1',

    watermarkText: process.env.REFINE_WATERMARK || 'done by SubTranslate',
};
