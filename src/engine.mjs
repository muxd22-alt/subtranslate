// On-device English -> Arabic translation.
//
// Wraps @browsermt/bergamot-translator (the engine behind Firefox Translations
// and TranslateLocally) and points it at model files already on disk instead of
// a remote registry. Everything here runs locally; no network access is needed
// once the model has been fetched.
//
// Parallelism: the engine runs `workers` WASM worker threads. Each one loads its
// own copy of the model, so the model is duplicated per worker (about 34 MB for
// en->ar). Measured on a 6-core Android phone:
//
//   workers   cues/sec   speedup
//   1          3.9       1.0x
//   2          6.9       1.8x
//   3         10.2       2.6x
//   4         11.5       2.9x   <- default
//   5         11.0       2.8x
//   6         11.0       2.8x

import fs from 'node:fs';
import path from 'node:path';
import { BatchTranslator, TranslatorBacking } from '@browsermt/bergamot-translator';

export const MODEL_FILES = {
    model: 'model.enar.intgemm.alphas.bin',
    lex: 'lex.50.50.enar.s2t.bin',
    vocab: 'vocab.enar.spm',
};

export const DEFAULT_MODEL_DIR = path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.local', 'share', 'subtranslate', 'models', 'en-ar',
);

export function defaultModelDir() {
    return process.env.SUBTRANSLATE_MODEL_DIR || DEFAULT_MODEL_DIR;
}

export function checkModelDir(modelDir) {
    const missing = [];
    for (const name of Object.values(MODEL_FILES)) {
        const p = path.join(modelDir, name);
        if (!fs.existsSync(p) || fs.statSync(p).size === 0) missing.push(p);
    }
    return missing;
}

/**
 * Same as TranslatorBacking, but the "registry" is a directory on disk and
 * `fetch()` reads local files.
 */
class LocalBacking extends TranslatorBacking {
    // Called by the parent constructor, which has already set `this.options`.
    async loadModelRegistery() {
        const dir = this.options.modelDir;
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
        const buf = await fs.promises.readFile(url);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
}

/**
 * Workaround for a race in BatchTranslator's worker scheduler.
 *
 * `notify()` awaits `backing.loadWorker()` and then unconditionally does
 * `queue.shift()` and hands the result to `consumeBatch()`. When a whole chunk
 * of cues is enqueued at once, several `notify()` callbacks run concurrently;
 * they all find "no idle worker, but room for one more" and each starts loading
 * a worker. Because that await takes a while, the batches can already have been
 * taken by the time the later callbacks resume, so `queue.shift()` returns
 * undefined. `consumeBatch(undefined, ...)` then throws, and the library's own
 * catch block dereferences `batch.requests` -- an uncaught TypeError raised
 * from a setTimeout callback, which kills the process mid-film.
 *
 * Observed on device: 24 cues (3 batches of 8) with 4 workers crashed, 16 cues
 * (2 batches) happened not to. Returning early for the empty case leaves the
 * worker idle and usable; the next real batch loads the model as usual.
 */
class SafeBatchTranslator extends BatchTranslator {
    async consumeBatch(batch, worker) {
        if (!batch) return;
        return super.consumeBatch(batch, worker);
    }
}

export class Engine {
    /**
     * @param {{modelDir?: string, workers?: number, batchSize?: number}} options
     */
    constructor(options = {}) {
        this.modelDir = options.modelDir || defaultModelDir();
        this.workers = options.workers || 4;
        this.batchSize = options.batchSize || 8;
        this.translator = null;
    }

    async start() {
        const missing = checkModelDir(this.modelDir);
        if (missing.length) {
            throw new Error(
                `Translation model is incomplete in ${this.modelDir}\n` +
                `Missing:\n  ${missing.join('\n  ')}\n` +
                'Run `subtranslate --fetch-model` (or `npm run fetch-model`) to download it.',
            );
        }

        this.backing = new LocalBacking({
            modelDir: this.modelDir,
            pivotLanguage: null, // en->ar is direct, never pivot
            downloadTimeout: 0,
        });
        this.translator = new SafeBatchTranslator(
            { workers: this.workers, batchSize: this.batchSize },
            this.backing,
        );

        // Force the model to load now so a broken install fails immediately
        // rather than half way through a film.
        await this.translateMany(['Ready.'], { chunkSize: 1 });
    }

    /**
     * Translate a list of strings, in waves of `chunkSize` so memory stays
     * bounded and progress is visible on long files.
     * @param {string[]} texts
     * @param {{chunkSize?: number, retries?: number, onProgress?: (done: number, total: number) => void}} options
     * @returns {Promise<string[]>}
     */
    async translateMany(texts, options = {}) {
        const chunkSize = options.chunkSize || 200;
        const retries = options.retries ?? 2;
        const results = new Array(texts.length);
        let reported = 0;
        const report = n => {
            if (n <= reported) return;
            reported = n;
            options.onProgress?.(n, texts.length);
        };

        for (let start = 0; start < texts.length; start += chunkSize) {
            const end = Math.min(start + chunkSize, texts.length);
            const slice = texts.slice(start, end);

            let lastError;
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    const translated = await Promise.all(slice.map((text, i) =>
                        this.translator
                            .translate({ from: 'en', to: 'ar', text, html: false, qualityScores: false })
                            .then(r => {
                                report(start + i + 1);
                                return r.target.text;
                            })));
                    translated.forEach((t, i) => { results[start + i] = t; });
                    lastError = undefined;
                    break;
                } catch (err) {
                    lastError = err;
                    reported = Math.max(reported, start);
                }
            }

            if (lastError) throw lastError;
        }

        return results;
    }

    async stop() {
        if (this.translator) {
            await this.translator.delete();
            this.translator = null;
        }
    }
}
