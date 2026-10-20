const UNITS = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
];

export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '?';
    let left = Math.round(seconds);
    const parts = [];
    for (const [unit, size] of UNITS) {
        if (left >= size) {
            parts.push(`${Math.floor(left / size)}${unit}`);
            left %= size;
        }
        if (parts.length === 2) break;
    }
    return parts.length ? parts.join('') : '0s';
}

function clamp01(n) {
    return Math.max(0, Math.min(1, n));
}

/**
 * Progress reporter.
 *
 * TTY: a single rewritten line on stderr.
 * --json: one JSON object per second (and at the end) on stdout.
 * Pipes without --json: silent, so cron logs stay clean.
 */
export class Progress {
    constructor({ stream = process.stderr, json = false, quiet = false, enabled, intervalMs = 250 } = {}) {
        this.stream = stream;
        this.json = json;
        this.quiet = quiet;
        this.enabled = enabled ?? Boolean(stream && stream.isTTY);
        this.intervalMs = intervalMs;
        this.startedAt = 0;
        this.lastAt = 0;
        this.total = 0;
        this.done = 0;
        this.lastDone = 0;
        this.rendered = '';
        this.finished = false;
    }

    start(total) {
        this.startedAt = Date.now();
        this.lastAt = 0;
        this.total = total;
        this.done = 0;
        this.lastDone = 0;
        this.finished = false;
        if (this.json && !this.quiet) this.emit(0, total);
        else if (this.enabled && !this.quiet) this.render(0, total, true);
    }

    update(done, total = this.total) {
        if (this.finished) return;
        this.done = Math.max(done, this.done);
        this.total = total || this.total;
        const now = Date.now();
        if (this.json) {
            if (!this.quiet && (now - this.lastAt >= 1000)) {
                this.lastAt = now;
                this.emit(this.done, this.total);
            }
        } else if (this.enabled && !this.quiet && (now - this.lastAt >= this.intervalMs)) {
            this.lastAt = now;
            this.render(this.done, this.total);
        }
    }

    abort() {
        if (this.finished) return;
        this.finished = true;
        if (this.quiet || this.json) return;
        if (this.enabled && this.rendered) this.stream.write('\n');
    }

    finish() {
        if (this.finished) return;
        this.finished = true;
        if (this.quiet) return;
        if (this.json) {
            this.emit(this.total, this.total, true);
        } else if (this.enabled) {
            this.render(this.total, this.total, true);
            if (this.rendered) this.stream.write('\n');
        }
    }

    emit(done, total, force = false) {
        const elapsed = Math.max(0.001, (Date.now() - this.startedAt) / 1000);
        const rate = done / elapsed;
        const eta = rate > 0 ? (total - done) / rate : null;
        const event = {
            event: 'progress',
            done,
            total,
            percent: total ? +(clamp01(done / total) * 100).toFixed(1) : 0,
            cues_per_second: +rate.toFixed(2),
            elapsed_seconds: +elapsed.toFixed(1),
            eta_seconds: eta === null ? null : Math.max(0, Math.round(eta)),
            ...(force ? { final: true } : {}),
        };
        process.stdout.write(JSON.stringify(event) + '\n');
    }

    render(done, total, force = false) {
        const width = 24;
        const ratio = total ? clamp01(done / total) : 0;
        const filled = Math.round(ratio * width);
        const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
        const elapsed = Math.max(0.001, (Date.now() - this.startedAt) / 1000);
        const rate = done / elapsed;
        const eta = rate > 0 ? (total - done) / rate : null;
        const etaText = eta === null || !Number.isFinite(eta) ? '?' : formatDuration(eta);
        const text = `translating [${bar}] ${done}/${total}  ${rate.toFixed(1)} cues/s  ETA ${etaText}`;
        if (text === this.rendered && !force) return;
        this.rendered = text;
        this.stream.write(`\r${text}`);
    }
}
