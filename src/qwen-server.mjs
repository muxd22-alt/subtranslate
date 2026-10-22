// The local model: llama-server, on demand.
//
// The server is started when a job needs it and stopped again when it goes
// idle, so the phone does not keep a model in memory between films. It binds
// to 127.0.0.1 only: nothing outside the phone can reach it.
//
// The requests are stateless. Every batch is a fresh conversation with the
// same two messages, the prompt cache is switched off, and thinking is off,
// because a thinking block would sit in front of the JSON.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './qwen-config.mjs';

const SERVER_LOG = path.join(config.cacheDir, 'llama-server.log');

// The preferred model first, then the fallbacks the task allows.
const MODEL_PREFERENCE = ['qwen3.5-0.8b', 'qwen3-0.6b', 'qwen2.5-0.5b'];

/** Pick the GGUF to run: the explicit one, the preferred one, or any. */
export function findModel(explicit) {
    if (explicit) {
        return fs.existsSync(explicit) ? explicit : null;
    }
    let names;
    try {
        names = fs.readdirSync(config.modelDir).sort();
    } catch {
        return null;
    }
    const ggufs = names.filter(n => n.toLowerCase().endsWith('.gguf'));
    for (const preference of MODEL_PREFERENCE) {
        const match = ggufs.find(n => n.toLowerCase().includes(preference));
        if (match) return path.join(config.modelDir, match);
    }
    if (ggufs.length) return path.join(config.modelDir, ggufs[0]);
    return null;
}

/**
 * Flag sets in the order they are tried.
 *
 * --reasoning off and --ui need a recent llama.cpp. An older build refuses
 * to start with an argument it does not know, so the sets drop one flag at a
 * time. The request also carries chat_template_kwargs, so thinking is off
 * even when the server was started with the plain set.
 */
export function serverFlagSets() {
    const common = [
        '--host', config.serverHost,
        '--port', String(config.serverPort),
        '-c', String(config.serverCtx),
        '-t', String(config.serverThreads),
    ];
    return [
        [...common, '--reasoning', 'off', '--ui', 'off'],
        [...common, '--reasoning', 'off'],
        [...common, '--jinja', '--ui', 'off'],
        [...common, '--jinja'],
        common,
    ];
}

async function isUp(url = config.serverUrl) {
    // A pooled connection to a server that just went away fails once, so the
    // check is retried before it is believed.
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
            if (response.ok) return true;
        } catch {
            // Try again.
        }
        await sleep(300);
    }
    return false;
}

export class LlamaServer {
    constructor(model = null, logFile = SERVER_LOG) {
        this.model = model;
        this.logFile = logFile;
        this.process = null;
        this.flags = null;
        this.lastUsed = 0;
    }

    /** True when a server is already listening. */
    async up() {
        return isUp();
    }

    /** Start the server. Returns true when it answers. */
    async start() {
        if (await this.up()) {
            process.stderr.write('subqwen: reusing the server already running\n');
            this.lastUsed = Date.now();
            return true;
        }
        if (!this.model) {
            process.stderr.write(`subqwen: no model found in ${config.modelDir}\n`);
            return false;
        }

        const binary = 'llama-server';
        if (!which(binary)) {
            process.stderr.write('subqwen: llama-server is not installed\n');
            return false;
        }

        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });

        // The phone shares its battery with everything else, so the model runs
        // at a lower priority than the rest of the stack.
        const nice = config.serverNice > 0 ? which('nice') : null;

        for (const flags of serverFlagSets()) {
            const argv = nice ? [nice, '-n', String(config.serverNice), binary, '-m', this.model, ...flags]
                : [binary, '-m', this.model, ...flags];
            process.stderr.write(`subqwen: starting ${path.basename(this.model)} ${flags.join(' ')}\n`);

            const out = fs.openSync(this.logFile, 'a');
            this.process = spawn(argv, {
                detached: true,
                stdio: ['ignore', out, out],
            });
            this.process.unref();

            if (await this.waitUp()) {
                this.flags = flags;
                this.lastUsed = Date.now();
                process.stderr.write(`subqwen: server ready on ${config.serverUrl}\n`);
                fs.closeSync(out);
                return true;
            }

            this.stop();
            fs.closeSync(out);
        }

        process.stderr.write(`subqwen: the server did not come up, see ${this.logFile}\n`);
        return false;
    }

    async waitUp() {
        const deadline = Date.now() + config.bootTimeout * 1000;
        while (Date.now() < deadline) {
            if (this.process && this.process.exitCode !== null) return false;
            if (await isUp()) return true;
            await sleep(2000);
        }
        return false;
    }

    /** Stop the server. */
    stop() {
        if (!this.process) return;
        try {
            process.kill(-this.process.pid, 'SIGTERM');
        } catch {
            try {
                this.process.kill('SIGTERM');
            } catch {
                // Already gone.
            }
        }
        this.process = null;
    }

    /** Stop the server once it has been idle for the configured time. */
    stopIfIdle() {
        if (!this.process) return;
        if (config.serverIdle <= 0) {
            this.stop();
            return;
        }
        if ((Date.now() - this.lastUsed) / 1000 >= config.serverIdle) {
            process.stderr.write(`subqwen: idle for ${config.serverIdle}s, stopping the server\n`);
            this.stop();
        }
    }
}

function which(binary) {
    const dirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of dirs) {
        const candidate = path.join(dir, binary);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // Keep looking.
        }
    }
    return null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Remove a thinking block if the model produced one anyway. */
export function stripThinking(text) {
    if (!text) return '';
    return text
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<think>[\s\S]*$/, '')
        .trim();
}

/**
 * Parse the model answer.
 *
 * A broken or truncated answer must never take the file down, so the parse
 * is forgiving: the first complete JSON object wins, and if that fails the
 * individual edits are salvaged out of the text.
 *
 * @returns {{edits: {i: number, ar: string}[], error: string|null}}
 */
export function parseModelJson(text) {
    let body = stripThinking(text);
    if (!body) return { edits: [], error: 'empty answer' };

    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(body);
    if (fenced) body = fenced[1].trim();

    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const data = JSON.parse(body.slice(start, end + 1));
            if (data && Array.isArray(data.edits)) return { edits: data.edits, error: null };
        } catch {
            // Fall through to the salvage.
        }
    }

    const edits = [];
    const re = /\{\s*"i"\s*:\s*(\d+)\s*,\s*"ar"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
    let match;
    while ((match = re.exec(body)) !== null) {
        let value;
        try {
            value = JSON.parse(`"${match[2]}"`);
        } catch {
            continue;
        }
        edits.push({ i: Number(match[1]), ar: value });
    }
    if (edits.length) return { edits, error: null };

    return { edits: [], error: 'unparsable answer' };
}

/**
 * One stateless request to the model.
 *
 * @returns {Promise<{edits: {i: number, ar: string}[], error: string|null}>}
 */
export async function askModel(systemPrompt, payload, { serverUrl = config.serverUrl } = {}) {
    const body = {
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload) },
        ],
        temperature: config.temperature,
        top_p: config.topP,
        max_tokens: config.maxTokens,
        response_format: {
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
        },
        // Thinking must be off, and no prompt cache is reused between batches.
        chat_template_kwargs: { enable_thinking: false },
        cache_prompt: false,
        stream: false,
    };

    let response;
    try {
        response = await fetch(`${serverUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(600000),
        });
    } catch (err) {
        return { edits: [], error: `request failed: ${err.message}` };
    }

    if (!response.ok) {
        return { edits: [], error: `request failed: HTTP ${response.status}` };
    }

    let data;
    try {
        data = await response.json();
    } catch (err) {
        return { edits: [], error: `answer was not JSON: ${err.message}` };
    }

    const message = data?.choices?.[0]?.message;
    if (!message) return { edits: [], error: 'answer had no choices' };
    const content = message.content || message.reasoning_content || '';
    return parseModelJson(content);
}
