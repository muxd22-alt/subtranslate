#!/usr/bin/env node
// Audits every glossary term against the base model:
//
//   node scripts/audit-terms.mjs
//
// For each term it prints what the model produces on its own next to our
// curated term. Any row where the two match should be deleted from
// src/glossary.mjs -- masking a term the model already knows measurably hurts
// (see docs/model-parallelism.md).

import path from 'node:path';
import { BatchTranslator, TranslatorBacking } from '@browsermt/bergamot-translator';
import { readFile } from 'node:fs/promises';
import { GENRES } from '../src/glossary.mjs';
import { defaultModelDir, MODEL_FILES } from '../src/engine.mjs';

const dir = process.env.SUBTRANSLATE_MODEL_DIR || defaultModelDir();

class LocalBacking extends TranslatorBacking {
    async loadModelRegistery() {
        const entry = name => ({ name: path.join(dir, name) });
        return [{
            from: 'en',
            to: 'ar',
            files: {
                model: entry(MODEL_FILES.model),
                lex: entry(MODEL_FILES.lex),
                vocab: entry(MODEL_FILES.vocab),
            },
        }];
    }
    async fetch(url) {
        const buf = await readFile(url);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
}

const translator = new BatchTranslator(
    { workers: 4, batchSize: 8 },
    new LocalBacking({ pivotLanguage: null, downloadTimeout: 0 }),
);
await translator.translate({ from: 'en', to: 'ar', text: 'warm up', html: false });

const translate = text =>
    translator.translate({ from: 'en', to: 'ar', text, html: false }).then(r => r.target.text);

let stale = 0;

for (const [genre, profile] of Object.entries(GENRES)) {
    const terms = Object.entries(profile.terms);
    if (!terms.length) continue;

    console.log(`\n### ${genre} (${profile.label})`);
    for (const [en, curated] of terms) {
        const model = await translate(en);
        const same = model.trim() === curated.trim();
        if (same) stale++;
        console.log(
            `${en.padEnd(18)} | model: ${model.padEnd(24)} | curated: ${curated}${same ? '   <-- redundant, delete' : ''}`,
        );
    }
}

await translator.delete();

console.log(stale
    ? `\n${stale} glossary term(s) are now redundant.`
    : '\nAll glossary terms still differ from the base model.');

process.exit(0);
