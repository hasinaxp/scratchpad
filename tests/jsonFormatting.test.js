import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonChunks, formatJsonContent } from '../src/jsonFormatting.js';
import { highlightText } from '../src/syntaxHighlighter.js';

test('escaped JSON is detected as a chunk with its real JSON', () => {
    const source = 'log: {\\"name\\": \\"remi\\", \\"tags\\": [\\"a\\"]} done';
    const [chunk] = extractJsonChunks(source);
    assert.equal(chunk.text, '{\\"name\\": \\"remi\\", \\"tags\\": [\\"a\\"]}');
    assert.equal(chunk.escaped, true);
    assert.deepEqual(JSON.parse(chunk.json), { name: 'remi', tags: ['a'] });
    assert.equal(source.slice(chunk.start, chunk.end), chunk.text);
});

test('escaped chunks keep inner escapes and sit beside normal chunks', () => {
    // Inner quote and newline are double-escaped one layer down.
    const source = '{"plain": 1}\n{\\"quote\\": \\"say \\\\\\"hi\\\\\\"\\", \\"nl\\": \\"a\\\\nb\\"}';
    const chunks = extractJsonChunks(source);
    assert.deepEqual(chunks.map((c) => c.escaped), [false, true]);
    assert.deepEqual(JSON.parse(chunks[1].json), { quote: 'say "hi"', nl: 'a\nb' });
});

test('normal JSON with escaped quotes in strings is unchanged', () => {
    const [chunk] = extractJsonChunks('{"msg": "say \\"hi\\""}');
    assert.equal(chunk.escaped, false);
    assert.equal(chunk.json, chunk.text);
});

test('formatting an escaped chunk outputs real JSON', () => {
    const { output, changed } = formatJsonContent('{\\"name\\": \\"remi\\"}', 'pretty');
    assert.equal(changed, true);
    assert.equal(output, '{\n  "name": "remi"\n}');
    assert.equal(formatJsonContent('x {\\"a\\":[1,2]} y', 'minified').output, 'x {"a":[1,2]} y');
});

test('escaped JSON is highlighted as keys and strings', () => {
    const html = highlightText('{\\"name\\": \\"remi\\", \\"n\\": 2}', 'json');
    const kinds = (kind) => [...html.matchAll(new RegExp(`<span class="tok-${kind}">([^<]*)</span>`, 'g'))].map((m) => m[1]);
    assert.deepEqual(kinds('keyword'), ['\\"name\\":', '\\"n\\":']);
    assert.deepEqual(kinds('string'), ['\\"remi\\"']);
    assert.deepEqual(kinds('number'), ['2']);
    // Plain JSON strings with escaped quotes are still one string token.
    assert.deepEqual([...highlightText('{"m": "say \\"hi\\""}', 'json').matchAll(/tok-string">([^<]*)</g)].map((m) => m[1]), ['"say \\"hi\\""']);
});
