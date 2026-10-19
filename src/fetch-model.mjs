// Downloads the Firefox Translations en->ar model from Mozilla's public CDN
// into the model directory. The model is MPL-2.0, ~34 MB, and is the only thing
// subtranslate ever needs the network for.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MODEL_FILES } from './engine.mjs';

const RECORDS_URL = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records';
const ATTACHMENT_BASE = 'https://firefox-settings-attachments.cdn.mozilla.net/';

const WANTED = ['model', 'lex', 'vocab'];

async function download(url, dest, { log }) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);

    const tmp = `${dest}.part`;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);

    await new Promise((accept, reject) => {
        res.body.on('error', reject);
        out.on('error', reject);
        out.on('finish', accept);
        res.body.on('data', chunk => {
            hash.update(chunk);
            if (!out.write(chunk)) res.body.pause();
        });
        out.on('drain', () => res.body.resume());
        res.body.on('end', () => out.end());
    });

    fs.renameSync(tmp, dest);
    return hash.digest('hex');
}

export async function fetchModel(modelDir, { log = () => {} } = {}) {
    log(`fetching model registry ...`);
    const res = await fetch(RECORDS_URL, { credentials: 'omit' });
    if (!res.ok) throw new Error(`GET ${RECORDS_URL} -> HTTP ${res.status}`);
    const { data } = await res.json();

    const available = data
        .filter(r => r.fromLang === 'en' && r.toLang === 'ar' && WANTED.includes(r.fileType))
        .map(r => ({ ...r, versionNumber: parseFloat(r.version) }))
        .filter(r => Number.isFinite(r.versionNumber));

    if (!available.length) throw new Error('no en->ar model in the registry');

    // Highest model version wins; take the matching lex/vocab from that version.
    const version = Math.max(...available.map(r => r.versionNumber));
    const records = available.filter(r => r.versionNumber === version);
    log(`en->ar version ${version}: ${records.map(r => r.fileType).join(', ')}`);

    fs.mkdirSync(modelDir, { recursive: true });

    for (const record of records) {
        const filename = record.attachment.filename || MODEL_FILES[record.fileType];
        const dest = path.join(modelDir, filename);
        const expected = record.attachment.hash;
        const size = record.attachment.size;

        if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
            const got = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
            if (got === expected) {
                log(`ok    ${filename} (cached)`);
                continue;
            }
        }

        log(`get   ${filename} (${(size / 1048576).toFixed(1)} MB) ...`);
        const got = await download(ATTACHMENT_BASE + record.attachment.location, dest, { log });
        if (got !== expected) {
            fs.unlinkSync(dest);
            throw new Error(`checksum mismatch for ${filename}: got ${got}, expected ${expected}`);
        }
        log(`ok    ${filename}`);
    }

    log(`model ready in ${modelDir}`);
}
