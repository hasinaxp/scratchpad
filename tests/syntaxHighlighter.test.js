import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightTokens } from '../src/syntaxHighlighter.js';

// Token offsets drive the canvas colours, so the tokens must add up to exactly the source text.
const visibleText = (list) => list.map((token) => token.text).join('');
const tokens = (list, kind) => list.filter((token) => token.kind === kind).map((token) => token.text);

const fenced = (tag, body) => `intro\n\`\`\`${tag}\n${body}\n\`\`\`\noutro`;

test('fenced blocks use their language rules and keep the text intact', () => {
    const cases = [
        ['python', 'def add(a, b):  # sum\n    return "x" + str(1)', { keyword: ['def', 'return'], comment: ['# sum'], string: ['"x"'] }],
        ['py', 'import os', { keyword: ['import'] }],
        ['java', 'public class A { // note\n  int x = 42; }', { keyword: ['public', 'class', 'int'], comment: ['// note'], number: ['42'] }],
        ['yaml', 'name: app\nport: 8080  # http', { keyword: ['name:', 'port:'], comment: ['# http'], number: ['8080'] }],
        ['yml', 'debug: true', { keyword: ['debug:', 'true'] }],
        ['json', '{"id": 7, "ok": true}', { keyword: ['"id":', '"ok":', 'true'], number: ['7'] }],
        ['c', '#include <stdio.h>\nint main(void) { /* hi */ return 0x1F; }', { meta: ['#include <stdio.h>'], keyword: ['int', 'void', 'return'], comment: ['/* hi */'], number: ['0x1F'] }]
    ];

    for (const [tag, body, expected] of cases) {
        const source = fenced(tag, body);
        const list = highlightTokens(source, 'text');
        assert.equal(visibleText(list).trimEnd(), source, `${tag}: text changed`);
        for (const [kind, values] of Object.entries(expected)) {
            assert.deepEqual(tokens(list, kind), values, `${tag}: ${kind} tokens`);
        }
    }
});

test('contractions do not open single-quoted strings', () => {
    const source = "I've made it. The files haven't run, so it's 'quoted' and they'll be fine.";
    const list = highlightTokens(source, 'text');
    assert.equal(visibleText(list), source);
    assert.deepEqual(tokens(list, 'string'), ["'quoted'"]);
    assert.deepEqual(tokens(list, 'plain'), []);
    const listItem = highlightTokens("- don't 'x'", 'text');
    assert.deepEqual(tokens(listItem, 'string'), ["'x'"]);
    assert.equal(visibleText(tokens(listItem, 'keyword').map((text) => ({ text }))), "- don't ");
});

test('*em* and **strong** are bold but keep the surrounding colour; list bullets are not emphasis', () => {
    const bold = (list) => list.filter((token) => token.bold).map((token) => token.text);
    assert.deepEqual(bold(highlightTokens('a **bold one** and *soft* text, 2 * 3 * 4\n* bullet', 'text')), ['**bold one**', '*soft*']);
    const item = highlightTokens('1. **Wrap drift:** the overlay', 'text');
    assert.deepEqual(item.filter((token) => token.bold).map((token) => token.kind), ['keyword']);
});

test('unknown or untagged fences stay plain code; unclosed fences still highlight', () => {
    const plain = highlightTokens(fenced('', 'def x(): pass'), 'text');
    assert.deepEqual(tokens(plain, 'keyword'), []);
    assert.ok(tokens(plain, 'code').includes('def x(): pass'));
    assert.deepEqual(tokens(highlightTokens(fenced('rust', 'fn main() {}'), 'text'), 'keyword'), []);

    const open = highlightTokens('```python\nwhile True:\n    pass', 'text');
    assert.deepEqual(tokens(open, 'keyword'), ['while', 'True', 'pass']);
    assert.equal(visibleText(open).trimEnd(), '```python\nwhile True:\n    pass');
});
