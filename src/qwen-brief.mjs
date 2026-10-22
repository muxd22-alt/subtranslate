// The movie brief: the small amount of knowledge the model is given before it
// touches a single line.
//
// The brief carries the title, the genres, a tone line and the main
// characters with their gender. The gender comes from the metadata provider
// and is never guessed: a name like "Sam" says nothing, the cast credit says
// "female", and that is what the model is told.
//
// The providers are tried in order and the first one that answers wins:
//
//   tmdb      the key file, if there is one. The only source with cast gender
//   tvmaze    free, no key, TV only, and its cast carries the actor gender
//   cinemeta  free, no key, movies and series
//   nfo       the .nfo next to the video, for an offline run
//   generic   a title and nothing else, so the job never fails
//
// The TMDB key is read from a file, used in the request and never logged.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './qwen-config.mjs';

const TMDB = 'https://api.themoviedb.org/3';
const TVMAZE = 'https://api.tvmaze.com';
const CINEMETA = 'https://v3-cinemeta.strem.io';

// Countries where Arabic is the language of the posters.
const ARAB_COUNTRIES = new Set([
    'SA', 'EG', 'AE', 'MA', 'DZ', 'TN', 'JO', 'LB', 'KW', 'QA', 'BH', 'OM',
    'SY', 'IQ', 'YE', 'LY', 'SD', 'PS', 'MR', 'SO', 'DJ', 'KM',
]);

// Genre -> the tone line the model is told to write in.
const TONE_BY_GENRE = [
    ['sci-fi', 'science fiction', ['science fiction', 'sci-fi', 'scifi'], '语气：科幻、冷静、技术感，用词准确，不夸张。'],
    ['horror', 'horror', ['horror'], '语气：恐怖、压抑、简短，避免玩笑感。'],
    ['drama', 'drama', ['drama'], '语气：剧情片，口语自然，情绪克制。'],
    ['comedy', 'comedy', ['comedy'], '语气：喜剧，轻松、口语化，允许一点俏皮。'],
    ['action', 'action', ['action', 'adventure'], '语气：动作片，短促有力，句子尽量短。'],
    ['thriller', 'thriller', ['thriller', 'suspense'], '语气：悬疑紧张，克制，不剧透。'],
    ['romance', 'romance', ['romance', 'rom-com'], '语气：爱情，柔和、含蓄。'],
    ['crime', 'crime', ['crime'], '语气：犯罪，冷硬、简洁。'],
    ['war', 'war', ['war', 'history'], '语气：战争，沉重、正式。'],
    ['fantasy', 'fantasy', ['fantasy'], '语气：奇幻，书面一点，保留专有名词。'],
    ['animation', 'animation', ['animation', 'family', 'kids'], '语气：动画，通俗活泼。'],
    ['documentary', 'documentary', ['documentary', 'biography'], '语气：纪录片，客观、说明性。'],
    ['family', 'family', ['family'], '语气：家庭片，温和、通俗。'],
];

/** The tone line for a list of genre names. */
export function toneFor(genres) {
    const lowered = (genres || []).map(g => String(g).toLowerCase());
    for (const [key, label, words, tone] of TONE_BY_GENRE) {
        if (lowered.some(g => words.some(w => g.includes(w)))) return { key, label, tone };
    }
    return { key: 'general', label: 'general', tone: '语气：中性、自然、口语化。' };
}

async function getJson(url, { headers = {}, timeout = config.httpTimeout } = {}) {
    const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function getText(url, { headers = {}, timeout = config.httpTimeout } = {}) {
    const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

/** The TMDB key. Read from the file, never logged, never written. */
export function readTmdbKey() {
    try {
        return fs.readFileSync(config.tmdbKeyFile, 'utf8').trim();
    } catch {
        return '';
    }
}

/** A v3 api_key and a v4 bearer token are used differently. */
function tmdbAuth(key) {
    if (!key) return null;
    if (key.startsWith('eyJ')) return { bearer: key };
    return { apiKey: key };
}

async function tmdbGet(pathname, key, params = {}) {
    const auth = tmdbAuth(key);
    if (!auth) throw new Error('no tmdb key');
    const query = new URLSearchParams();
    if (auth.apiKey) query.set('api_key', auth.apiKey);
    for (const [name, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        query.set(name, String(value));
    }
    const suffix = query.toString() ? `?${query}` : '';
    const headers = auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {};
    return getJson(`${TMDB}${pathname}${suffix}`, { headers });
}

/** TMDB cast gender: 1 female, 2 male, anything else unknown. */
export function tmdbGender(value) {
    const number = Number(value);
    if (number === 1) return 'female';
    if (number === 2) return 'male';
    return 'unknown';
}

function arabicTitle(translations, fallback) {
    if (translations && typeof translations === 'object') {
        for (const [code, entry] of Object.entries(translations)) {
            if (code.toLowerCase() === 'ar' || ARAB_COUNTRIES.has(code.toUpperCase())) {
                const title = entry?.data?.title;
                if (title) return title;
            }
        }
    }
    return fallback;
}

function yearOf(text) {
    const match = /((?:19|20)\d{2})/.exec(text || '');
    return match ? Number(match[1]) : null;
}

async function tmdbBrief(key, info) {
    if (!info.title) return null;
    const kind = info.kind;
    const params = { query: info.title, include_adult: 'false' };
    if (info.year) params[kind === 'movie' ? 'year' : 'first_air_date_year'] = info.year;

    const data = await tmdbGet(`/search/${kind}`, key, params);
    const results = data?.results || [];
    if (!results.length) return null;

    let best = results[0];
    if (info.year) {
        const exact = results.find(r => String(r?.release_date || r?.first_air_date || '').slice(0, 4) === String(info.year));
        if (exact) best = exact;
    }
    if (!best?.id) return null;

    let details = best;
    try {
        details = await tmdbGet(`/${kind}/${best.id}`, key, {
            append_to_response: 'credits,keywords,translations',
        });
    } catch {
        // The search result is thin but still a usable brief.
    }

    const characters = [];
    for (const credit of details?.credits?.cast || []) {
        const character = credit?.character || '';
        if (!character) continue;
        characters.push({
            character,
            actor: credit?.name || '',
            gender: tmdbGender(credit?.gender),
        });
    }

    let overview = details?.overview || '';
    if (kind === 'tv' && info.season && info.episode) {
        try {
            const episode = await tmdbGet(`/tv/${best.id}/season/${info.season}/episode/${info.episode}`, key);
            if (episode?.overview) overview = episode.overview;
        } catch {
            // The show overview is enough.
        }
    }

    return {
        provider: 'tmdb',
        type: kind,
        id: best.id,
        title: details?.title || details?.name || info.title,
        titleAr: arabicTitle(details?.translations, ''),
        year: yearOf(details?.release_date || details?.first_air_date || '') || info.year || null,
        genres: (details?.genres || []).map(g => g?.name).filter(Boolean),
        overview,
        keywords: (details?.keywords?.results || []).map(k => k?.name).filter(Boolean).slice(0, 20),
        characters: characters.slice(0, 12),
    };
}

async function tvmazeBrief(info) {
    if (info.kind !== 'tv' || !info.title) return null;
    const data = await getJson(`${TVMAZE}/search/shows?q=${encodeURIComponent(info.title)}`);
    if (!data?.length) return null;
    const show = data[0]?.show || {};
    if (!show.id) return null;

    let cast = [];
    try {
        cast = await getJson(`${TVMAZE}/shows/${show.id}/cast`);
    } catch {
        cast = [];
    }

    const characters = [];
    for (const entry of cast || []) {
        const character = entry?.character?.name || '';
        if (!character) continue;
        const raw = String(entry?.person?.gender || '').toLowerCase();
        const gender = raw.startsWith('f') ? 'female' : raw.startsWith('m') ? 'male' : 'unknown';
        characters.push({
            character,
            actor: entry?.person?.name || '',
            gender,
        });
    }

    let overview = String(show.summary || '').replace(/<[^>]+>/g, ' ').trim();
    if (info.season && info.episode) {
        try {
            const episode = await getJson(
                `${TVMAZE}/shows/${show.id}/episodebynumber?season=${info.season}&number=${info.episode}`,
            );
            const summary = String(episode?.summary || '').replace(/<[^>]+>/g, ' ').trim();
            if (summary) overview = summary;
        } catch {
            // The show summary is enough.
        }
    }

    return {
        provider: 'tvmaze',
        type: 'tv',
        id: show.id,
        title: show.name || info.title,
        titleAr: '',
        year: yearOf(show.premiered || '') || info.year || null,
        genres: show.genres || [],
        overview,
        keywords: [],
        characters: characters.slice(0, 12),
    };
}

async function cinemetaBrief(info) {
    if (!info.title) return null;
    const kind = info.kind === 'movie' ? 'movie' : 'series';
    const query = encodeURIComponent(info.title.toLowerCase());
    const data = await getJson(`${CINEMETA}/catalog/${kind}/top/search=${query}.json`);
    const metas = data?.metas || [];
    if (!metas.length) return null;

    let best = metas[0];
    if (info.year) {
        const exact = metas.find(m => String(m?.year || '') === String(info.year));
        if (exact) best = exact;
    }

    const characters = (best?.cast || []).slice(0, 12).map(name => ({
        character: name,
        actor: name,
        gender: 'unknown',
    }));

    return {
        provider: 'cinemeta',
        type: kind,
        id: best?.id || best?.imdb_id || '',
        title: best?.name || info.title,
        titleAr: '',
        year: yearOf(String(best?.year || '')) || info.year || null,
        genres: best?.genres || best?.genre || [],
        overview: best?.description || '',
        keywords: [],
        characters,
    };
}

function textOf(node, tag) {
    const found = node?.children?.find(c => c.name === tag);
    const value = found?.children?.map(c => c.data || '').join('') || '';
    return value.trim();
}

function nfoBrief(file) {
    const base = file.replace(/\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|mpg|mpeg|ts|srt)$/i, '');
    const candidates = [
        `${base}.nfo`,
        path.join(path.dirname(base), 'movie.nfo'),
        path.join(path.dirname(base), 'tvshow.nfo'),
    ];
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        let raw;
        try {
            raw = fs.readFileSync(candidate, 'utf8');
        } catch {
            continue;
        }
        const title = /<title>([\s\S]*?)<\/title>/i.exec(raw);
        if (!title) continue;
        const year = /<year>([\s\S]*?)<\/year>/i.exec(raw);
        const plot = /<(?:plot|outline|story)>([\s\S]*?)<\/(?:plot|outline|story)>/i.exec(raw);
        const genres = [...raw.matchAll(/<genre>([\s\S]*?)<\/genre>/gi)].map(m => m[1].trim()).filter(Boolean);
        const keywords = [...raw.matchAll(/<keyword>([\s\S]*?)<\/keyword>/gi)].map(m => m[1].trim()).filter(Boolean);

        const characters = [];
        for (const actor of raw.matchAll(/<actor>([\s\S]*?)<\/actor>/gi)) {
            const name = /<name>([\s\S]*?)<\/name>/i.exec(actor[1]);
            const character = /<character>([\s\S]*?)<\/character>/i.exec(actor[1]);
            if (!name) continue;
            characters.push({
                character: (character?.[1] || name[1]).trim(),
                actor: name[1].trim(),
                gender: 'unknown',
            });
        }

        return {
            provider: 'nfo',
            type: /<tvshow/i.test(raw) ? 'tv' : 'movie',
            id: path.basename(candidate),
            title: title[1].trim(),
            titleAr: '',
            year: year ? yearOf(year[1]) : null,
            genres,
            overview: plot ? plot[1].trim() : '',
            keywords,
            characters: characters.slice(0, 12),
        };
    }
    return null;
}

function genericBrief(info) {
    return {
        provider: 'generic',
        type: info.kind,
        id: info.title || 'unknown',
        title: info.title || '',
        titleAr: '',
        year: info.year || null,
        genres: [],
        overview: '',
        keywords: [],
        characters: [],
    };
}

/** Where a brief is cached. */
export function briefCachePath(brief) {
    const provider = brief.provider || 'generic';
    const kind = brief.type || 'movie';
    const id = String(brief.id || 'unknown').replace(/[^\w.-]+/g, '_');
    return path.join(config.briefDir, `${provider}_${kind}_${id}.json`);
}

export function loadBriefCache(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

export function storeBriefCache(file, brief) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(brief, null, 2) + '\n', 'utf8');
    } catch {
        // A brief that cannot be cached is still a usable brief.
    }
}

/**
 * Build the brief for a movie or episode. Never throws: the generic brief is
 * always available.
 */
export async function buildBrief(info, { provider = 'auto', allowNetwork = true } = {}) {
    let providers = ['tmdb', 'tvmaze', 'cinemeta', 'nfo'];
    if (provider !== 'auto') providers = [provider];
    if (!allowNetwork) providers = providers.filter(p => p === 'nfo');

    const key = readTmdbKey();

    for (const name of providers) {
        let brief = null;
        try {
            if (name === 'tmdb') {
                if (!key) continue;
                brief = await tmdbBrief(key, info);
            } else if (name === 'tvmaze') {
                brief = await tvmazeBrief(info);
            } else if (name === 'cinemeta') {
                brief = await cinemetaBrief(info);
            } else if (name === 'nfo') {
                brief = nfoBrief(info.path || '');
            }
        } catch (err) {
            process.stderr.write(`subqwen: brief: ${name} failed: ${err.message}\n`);
            brief = null;
        }
        if (!brief) continue;

        const cacheFile = briefCachePath(brief);
        const cached = loadBriefCache(cacheFile);
        if (cached) return cached;
        storeBriefCache(cacheFile, brief);
        return brief;
    }

    return genericBrief(info);
}

/**
 * The user glossary. It overrides everything else the brief says.
 *
 * Two shapes are accepted. The flat one is the file subtranslate takes for
 * --glossary: {"exorcism": "طرد الأرواح"}. The structured one also carries
 * names and a tone line:
 *     {"names": {"Helen": "هيلين"}, "terms": {...}, "tone": "..."}
 */
export function loadGlossary(file = config.glossaryFile) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            process.stderr.write(`subqwen: glossary: ${file} is not valid JSON\n`);
        }
        return { names: {}, terms: {}, tone: '' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { names: {}, terms: {}, tone: '' };
    }
    if (data.names || data.terms || data.tone) {
        return {
            names: data.names && typeof data.names === 'object' ? data.names : {},
            terms: data.terms && typeof data.terms === 'object' ? data.terms : {},
            tone: typeof data.tone === 'string' ? data.tone : '',
        };
    }
    return { names: {}, terms: data, tone: '' };
}
