import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightText } from '../src/syntaxHighlighter.js';

// The overlay must render exactly the source text, or the editor drifts out of alignment.
const visibleText = (html) => html.replace(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const tokens = (html, kind) => [...html.matchAll(new RegExp(`<span class="tok-${kind}">([^<]*)</span>`, 'g'))].map((m) => m[1]);

const fenced = (tag, body) => `intro\n\`\`\`${tag}\n${body}\n\`\`\`\noutro`;

test('fenced blocks use their language rules and keep the text intact', () => {
    const cases = [
        ['python', 'def add(a, b):  # sum\n    return "x" + str(1)', { keyword: ['def', 'return'], comment: ['# sum'], string: ['"x"'] }],
        ['py', 'import os', { keyword: ['import'] }],
        ['java', 'public class A { // note\n  int x = 42; }', { keyword: ['public', 'class', 'int'], comment: ['// note'], number: ['42'] }],
        ['yaml', 'name: app\nport: 8080  # http', { keyword: ['name:', 'port:'], comment: ['# http'], number: ['8080'] }],
        ['yml', 'debug: true', { keyword: ['debug:', 'true'] }],
        ['json', '{"id": 7, "ok": true}', { keyword: ['"id":', '"ok":', 'true'], number: ['7'] }],
        ['c', '#include <stdio.h>\nint main(void) { /* hi */ return 0x1F; }', { meta: ['#include &lt;stdio.h&gt;'], keyword: ['int', 'void', 'return'], comment: ['/* hi */'], number: ['0x1F'] }]
    ];

    for (const [tag, body, expected] of cases) {
        const source = fenced(tag, body);
        const html = highlightText(source, 'text');
        assert.equal(visibleText(html).trimEnd(), source, `${tag}: text changed`);
        for (const [kind, values] of Object.entries(expected)) {
            assert.deepEqual(tokens(html, kind), values, `${tag}: ${kind} tokens`);
        }
    }
});

test('unknown or untagged fences stay plain code; unclosed fences still highlight', () => {
    const plain = highlightText(fenced('', 'def x(): pass'), 'text');
    assert.deepEqual(tokens(plain, 'keyword'), []);
    assert.ok(plain.includes('<span class="tok-code">def x(): pass</span>'));
    assert.deepEqual(tokens(highlightText(fenced('rust', 'fn main() {}'), 'text'), 'keyword'), []);

    const open = highlightText('```python\nwhile True:\n    pass', 'text');
    assert.deepEqual(tokens(open, 'keyword'), ['while', 'True', 'pass']);
    assert.equal(visibleText(open).trimEnd(), '```python\nwhile True:\n    pass');
});
