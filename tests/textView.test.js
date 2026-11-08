import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapLine, commonPrefixLength, commonSuffixLength } from '../src/textView.js';

// Monospace cell of 1px, tab stops every 4 cells, like the canvas view's advance().
const advance = (text, start, end, x) => (text[start] === '\t' ? 4 - (x % 4) : 1);

test('arithmetic ASCII wrap matches the general cluster wrap', () => {
    const words = ['a', 'bb', 'ccc', 'dddddddddddd', '  ', 'eeee', ' '];
    for (let seed = 1; seed < 400; seed += 1) {
        let line = '';
        for (let i = 0, s = seed; i < 12; i += 1, s = (s * 7 + 3) % 97) line += words[s % words.length] + (s % 3 ? ' ' : '');
        for (const width of [1, 3, 5, 8, 13]) {
            assert.deepEqual(wrapLine(line, width, advance, 1), wrapLine(line, width, advance), `${JSON.stringify(line)} @${width}`);
        }
    }
});

test('wrap breaks after spaces, lets spaces hang, and never splits a grapheme', () => {
    assert.deepEqual(wrapLine('aaaa bbbb', 4, advance, 1), [0, 5]);
    assert.deepEqual(wrapLine('aaaa    ', 4, advance, 1), [0]);
    assert.deepEqual(wrapLine('abcdefghij', 4, advance, 1), [0, 4, 8]);
    // Bengali conjunct + emoji ZWJ sequence are single clusters, so rows start on cluster boundaries.
    const line = 'ক্ষক্ষক্ষ👩‍💻👩‍💻';
    const rows = wrapLine(line, 2, advance);
    const clusters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map((s) => s.index);
    assert.ok(rows.every((col) => clusters.includes(col)), `rows ${rows} off cluster boundaries`);
    assert.equal(rows.length, 3);
});

test('common prefix/suffix find the edited span', () => {
    const base = 'x'.repeat(100_000);
    const edited = `${base.slice(0, 54_321)}NEW${base.slice(54_321)}`;
    assert.equal(commonPrefixLength(base, edited), 54_321);
    assert.equal(commonSuffixLength(base, edited, base.length - 54_321), base.length - 54_321);
    assert.equal(commonPrefixLength('abc', 'abd'), 2);
    assert.equal(commonSuffixLength('abc', 'xbc', 3), 2);
    assert.equal(commonPrefixLength('', 'a'), 0);
});
