// Turn a path into the title, year, season and episode that the metadata
// providers need.
//
// The library holds movies and TV episodes in a few shapes:
//
//   Movies/Movie (2010)/Movie (2010).en.srt
//   TV/Show/Season 1/Show.s01e01.en.srt
//   Movie (2010) [1080p]/Movie.2010.1080p.mkv
//
// Nothing here talks to the network; it only reads names.

import fs from 'node:fs';
import path from 'node:path';

const VIDEO_EXT = ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mpg', '.mpeg', '.ts'];

const EPISODE_RE = /(?<![a-z0-9])s(\d{1,3})e(\d{1,3})(?![0-9])/i;
const YEAR_RE = /(?<!\d)((?:19|20)\d{2})(?!\d)/;
const SEASON_DIR_RE = /^(season|series|staffel|saison)\s*(\d{1,3})$/i;

// Release noise that is not part of a title.
const NOISE_RE = new RegExp(
    '^(' +
    '1080p|720p|480p|2160p|4k|uhd|x264|x265|h\\.?264|h\\.?265|hevc|avc|' +
    'bluray|blu-ray|bdrip|brrip|web-?dl|web-?rip|webrip|web|hdtv|pdtv|' +
    'remux|ddp?5\\.?1|ddp?2\\.?0|dd\\+|ac3|aac\\d?(?:\\.\\d)?|eac3|' +
    'truehd|atmos|dts-?hd|flac|opus|mp3|10bit|10-bit|8bit|8-bit|' +
    'hdr|hdr10|dv|dolby|imax|proper|repack|extended|unrated|uncut|' +
    'multi|dual|subs?|dubbed|internal|limited|readnfo|repost|' +
    '[0-9a-f]{8}|[0-9]{4}p?|[0-9]{1,2}[a-z]' +
    ')$',
    'i',
);

const BRACKET_RE = /[\[{][^\]}]*[\]}]/g;

/** Strip release noise from a name and return something a search can use. */
export function cleanTitle(text) {
    if (!text) return '';
    let out = text.replace(BRACKET_RE, ' ');
    out = out.replace(/\((?:19|20)\d{2}\)/g, ' ');
    out = out.replace(/[._]/g, ' ');
    const tokens = [];
    for (const raw of out.split(/\s+/)) {
        const token = raw.replace(/^-+|-+$/g, '');
        if (!token) continue;
        if (YEAR_RE.test(token) && /^(?:19|20)\d{2}$/.test(token)) continue;
        if (NOISE_RE.test(token)) continue;
        if (/^\d+$/.test(token)) continue;
        tokens.push(token);
    }
    return tokens.join(' ').replace(/^-+|-+$/g, '').trim();
}

/** The first year in any of the given strings, or null. */
export function findYear(...candidates) {
    for (const text of candidates) {
        if (!text) continue;
        const match = YEAR_RE.exec(text);
        if (match) return Number(match[1]);
    }
    return null;
}

/** The path of a media file without its extension. */
export function baseFor(input) {
    const lower = input.toLowerCase();
    for (const ext of VIDEO_EXT) {
        if (lower.endsWith(ext)) return input.slice(0, -ext.length);
    }
    if (lower.endsWith('.srt')) return input.slice(0, -4);
    return input.replace(/\.[^.]+$/, '');
}

/**
 * @param {string} input a video or subtitle path
 * @returns {{title: string, year: number|null, season: number|null, episode: number|null, kind: string}}
 */
export function parseMediaInfo(input) {
    const base = baseFor(input);
    const stem = path.basename(base);
    const parent = path.dirname(base);
    const grandparent = path.dirname(parent);
    const parentName = path.basename(parent);
    const grandparentName = path.basename(grandparent);

    let season = null;
    let episode = null;
    const match = EPISODE_RE.exec(stem);
    if (match) {
        season = Number(match[1]);
        episode = Number(match[2]);
    }

    const kind = episode !== null ? 'tv' : 'movie';

    let title = '';
    if (episode !== null) {
        // TV/Show/Season 1/Show.s01e01.mkv -> the show is the folder above the
        // season folder. Otherwise the show name is in front of the marker.
        if (SEASON_DIR_RE.test(parentName)) title = cleanTitle(grandparentName);
        if (!title) title = cleanTitle(stem.split(EPISODE_RE)[0]);
        if (!title) title = cleanTitle(grandparentName);
    } else {
        title = cleanTitle(stem);
        if (!title) title = cleanTitle(parentName);
        if (!title) title = cleanTitle(grandparentName);
    }

    return {
        title,
        year: findYear(stem, parentName, grandparentName),
        season,
        episode,
        kind,
    };
}

/**
 * The English subtitle the Arabic was made from.
 *
 * A release may ship the English track in Subs/ instead of next to the video,
 * or as an untagged .srt. The Arabic track itself is never a candidate.
 */
export function findEnglishSource(base) {
    const direct = [
        `${base}.en.srt`,
        `${base}.eng.srt`,
        `${base}.english.srt`,
        `${base}.en.forced.srt`,
        `${base}.en.sdh.srt`,
    ];
    for (const candidate of direct) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) return candidate;
    }

    const directory = path.dirname(base);
    const subs = path.join(directory, 'Subs');
    const dirs = fs.existsSync(subs) ? [subs] : [directory];
    for (const dir of dirs) {
        let names;
        try {
            names = fs.readdirSync(dir).sort();
        } catch {
            continue;
        }
        for (const name of names) {
            if (!name.toLowerCase().endsWith('.srt')) continue;
            const low = name.toLowerCase();
            if (low.includes('.ar.') || low.includes('arabic')) continue;
            if (!low.includes('.en.') && !low.includes('.eng.') && !low.includes('english')) continue;
            const candidate = path.join(dir, name);
            if (fs.statSync(candidate).size > 0) return candidate;
        }
    }
    return null;
}
