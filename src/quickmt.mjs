// Client for the local quickmt service (bin/quickmt-server.py).
//
// Step 2 is optional by design: if the service is not running, every call here
// fails quickly and the caller keeps the Bergamot lines.  No exception escapes.

const PORT = Number(process.env.QUICKMT_PORT || 8098);
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_TIMEOUT = Number(process.env.QUICKMT_TIMEOUT_MS || 120000);

async function post(path, body, timeout) {
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`quickmt ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

/** True when the service answers /health. Never throws. */
export async function healthy(timeout = 1500) {
    try {
        const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeout) });
        if (!res.ok) return false;
        const body = await res.json();
        return body && body.ok === true;
    } catch {
        return false;
    }
}

/** Translate English lines to Arabic. Throws on failure. */
export async function translate(lines, { beam = 4, timeout = DEFAULT_TIMEOUT } = {}) {
    if (!Array.isArray(lines) || !lines.length) return [];
    const body = await post('/translate', { lines, beam }, timeout);
    if (!Array.isArray(body.out) || body.out.length !== lines.length) {
        throw new Error(`quickmt /translate returned ${body.out?.length} lines for ${lines.length}`);
    }
    return body.out;
}

/** Back-translate Arabic lines to English. Throws on failure. */
export async function back(lines, { beam = 4, timeout = DEFAULT_TIMEOUT } = {}) {
    if (!Array.isArray(lines) || !lines.length) return [];
    const body = await post('/back', { lines, beam }, timeout);
    if (!Array.isArray(body.out) || body.out.length !== lines.length) {
        throw new Error(`quickmt /back returned ${body.out?.length} lines for ${lines.length}`);
    }
    return body.out;
}

export const endpoint = BASE;
