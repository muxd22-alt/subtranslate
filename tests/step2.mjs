// Unit tests for step 2. Run: node tests/step2.mjs
import assert from 'node:assert/strict';

process.env.QUICKMT_PORT = process.env.QUICKMT_PORT || '1'; // closed port
process.env.STEP2 = 'on';

const { mergeCues, splitBack, wrapLines, maskNames, restoreNames, chrf } =
    await import('../src/step2.mjs');

const cue = (index, timing, lines) => ({ index: String(index), timing, lines });

// --- merge: sentences split across cues are grouped, timings untouched ----
const cues = [
    cue(1, '00:00:01,000 --> 00:00:03,000', ['Hello there,']),
    cue(2, '00:00:03,100 --> 00:00:05,000', ['my friend.']),
    cue(3, '00:00:06,000 --> 00:00:08,000', ['We leave at dawn and']),
    cue(4, '00:00:08,100 --> 00:00:10,000', ['never come back.']),
];
const groups = mergeCues(cues);
assert.deepEqual(groups.map(g => g.idx), [[0, 1], [2, 3]]);

// --- split back: same number of parts, nothing lost, nothing empty --------
const arabic = 'مرحبا يا صديقي';
const parts = splitBack(arabic, [12, 9]);
assert.equal(parts.length, 2);
assert.ok(parts.every(p => p.trim().length > 0));
assert.equal(parts.join(' ').replace(/\s+/g, ' '), arabic);

// --- wrap: at most two lines, never empty --------------------------------
const wrapped = wrapLines('هذه جملة عربية طويلة جدا تحتاج الى سطرين على الاقل', 20);
assert.equal(wrapped.length, 2);
assert.ok(wrapped.every(l => l.length > 0));

// --- names: masked, then restored (glossary spelling wins) ---------------
const names = new Set(['Sarah', 'Berlin']);
const masked = maskNames('I saw Sarah in Berlin.', names, { Berlin: 'برلين' });
assert.ok(!masked.masked.includes('Sarah'));
assert.ok(!masked.masked.includes('Berlin'));
const restored = restoreNames(masked.masked, masked.restore);
assert.ok(restored.complete);
assert.ok(restored.text.includes('Sarah'));
assert.ok(restored.text.includes('برلين'));
assert.ok(restored.allowed.has('sarah'));

// --- chrF: identical strings score 1 -------------------------------------
assert.ok(chrf('مرحبا بالعالم', 'مرحبا بالعالم') > 0.999);
assert.ok(chrf('مرحبا بالعالم', 'شيء اخر تماما') < 0.2);

// --- server down: step 2 is skipped, never throws ------------------------
const doc = {
    cues: [cue(1, '00:00:01,000 --> 00:00:03,000', ['مرحبا بالعالم.'])],
};
const sourceDoc = {
    cues: [cue(1, '00:00:01,000 --> 00:00:03,000', ['Hello world.'])],
};
const { runStep2 } = await import('../src/step2.mjs');
const result = await runStep2(doc, sourceDoc, { terms: {}, log: { warn() {}, info() {} } });
assert.equal(result, null);
assert.deepEqual(doc.cues[0].lines, ['مرحبا بالعالم.']);

console.log('step2 tests: ok');
