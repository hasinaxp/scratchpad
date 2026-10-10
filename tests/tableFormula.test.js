import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSheet, fillSeries, formatValue, transformRefs } from '../src/tableFormula.js';

const show = (cells) => evaluateSheet(cells).map((row) => row.map(formatValue));

test('arithmetic, precedence, refs and ranges', () => {
    const out = show([
        ['2', '3', '=A1+B1*2', '=SUM(A1:B2)'],
        ['4', 'x', '=-A1^2', '=AVERAGE(A1:B2)'],
        ['=(A1+B1)/2', '=A2&"-"&B2', '=10%', '=MIN(A1:A2)+MAX(A1:A2)']
    ]);
    assert.deepEqual(out, [
        ['2', '3', '8', '9'],
        ['4', 'x', '4', '3'],
        ['2.5', '4-x', '0.1', '6']
    ]);
});

test('functions, laziness and errors', () => {
    const out = show([
        ['0', '=IF(A1=0,"zero",1/A1)', '=IFERROR(1/A1,"n/a")', '=1/A1'],
        ['=C1&B1', '=FOO(1)', '=A3', '=B2'],
        ['=A3', '=COUNT(A1:D1)', '=ROUND(2/3,2)', '=1+']
    ]);
    assert.deepEqual(out, [
        ['0', 'zero', 'n/a', '#DIV/0!'],
        ['n/azero', '#NAME?', '#CIRC!', '#NAME?'],
        ['#CIRC!', '1', '0.67', '#ERROR!']
    ]);
});

test('transformRefs shifts refs, keeps strings and absolute parts', () => {
    const down = (ref) => ({ ...ref, row: ref.absRow ? ref.row : ref.row + 1 });
    assert.equal(transformRefs('=A1+$B$2+SUM(C3:D4)&"A1"', down), '=A2+$B$2+SUM(C4:D5)&"A1"');
    assert.equal(transformRefs('=A1+B1', (ref) => (ref.col === 0 ? null : ref)), '=#REF!+B1');
    assert.equal(transformRefs('plain A1', down), 'plain A1');
    assert.deepEqual(show([['=#REF!+1']]), [['#REF!']]);
});

test('fillSeries projects like spreadsheet autofill', () => {
    const shiftDown = (raw, delta) => transformRefs(raw, (ref) => ({ ...ref, row: ref.row + delta }));
    const project = (source, ks) => ks.map(fillSeries(source, shiftDown));
    assert.deepEqual(project(['1', '2'], [2, 3, -1]), ['3', '4', '0']);
    assert.deepEqual(project(['0.1', '0.2'], [2]), ['0.3']);
    assert.deepEqual(project(['5'], [1, 2]), ['5', '5']);
    assert.deepEqual(project(['Item 1'], [1, 2]), ['Item 2', 'Item 3']);
    assert.deepEqual(project(['row008', 'row010'], [2]), ['row012']);
    assert.deepEqual(project(['Jan'], [1, 11, 12]), ['Feb', 'Dec', 'Jan']);
    assert.deepEqual(project(['MON', 'WED'], [2]), ['FRI']);
    assert.deepEqual(project(['2024-02-28'], [1, 2]), ['2024-02-29', '2024-03-01']);
    assert.deepEqual(project(['=A1*2'], [1, 3]), ['=A2*2', '=A4*2']);
    assert.deepEqual(project(['a', 'b'], [2, 3]), ['a', 'b']);
    assert.deepEqual(project(['=A1', 'x'], [2, 3]), ['=A3', 'x']);
});
