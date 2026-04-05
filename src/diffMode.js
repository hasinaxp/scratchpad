import { escapeHtml } from './utils.js';

const MAX_MATRIX_CELLS = 2_000_000;

const splitLines = (text) => {
    const normalized = `${text || ''}`.replaceAll('\r\n', '\n');
    return normalized.split('\n');
};

const getLineCount = (text) => splitLines(text).length;

const renderLineNumbers = (lineCount) => {
    const lines = [];
    for (let i = 1; i <= lineCount; i += 1) {
        lines.push(`<div class="diff-line-number">${i}</div>`);
    }
    return lines.join('');
};

const pushSegment = (segments, type, line) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) {
        last.lines.push(line);
        return;
    }

    segments.push({
        type,
        lines: [line]
    });
};

const computeFallbackDiff = (left, right) => {
    const max = Math.max(left.length, right.length);
    const segments = [];

    for (let i = 0; i < max; i += 1) {
        const leftLine = left[i];
        const rightLine = right[i];

        if (leftLine === rightLine && leftLine !== undefined) {
            pushSegment(segments, 'equal', leftLine);
            continue;
        }

        if (leftLine !== undefined) {
            pushSegment(segments, 'remove', leftLine);
        }

        if (rightLine !== undefined) {
            pushSegment(segments, 'add', rightLine);
        }
    }

    return segments;
};

const computeLcsDiff = (left, right) => {
    const rows = left.length + 1;
    const cols = right.length + 1;

    if ((rows * cols) > MAX_MATRIX_CELLS) {
        return computeFallbackDiff(left, right);
    }

    const matrix = Array.from({ length: rows }, () => new Uint32Array(cols));

    for (let i = left.length - 1; i >= 0; i -= 1) {
        for (let j = right.length - 1; j >= 0; j -= 1) {
            if (left[i] === right[j]) {
                matrix[i][j] = matrix[i + 1][j + 1] + 1;
            } else {
                matrix[i][j] = Math.max(matrix[i + 1][j], matrix[i][j + 1]);
            }
        }
    }

    const segments = [];
    let i = 0;
    let j = 0;

    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            pushSegment(segments, 'equal', left[i]);
            i += 1;
            j += 1;
            continue;
        }

        if (matrix[i + 1][j] >= matrix[i][j + 1]) {
            pushSegment(segments, 'remove', left[i]);
            i += 1;
            continue;
        }

        pushSegment(segments, 'add', right[j]);
        j += 1;
    }

    while (i < left.length) {
        pushSegment(segments, 'remove', left[i]);
        i += 1;
    }

    while (j < right.length) {
        pushSegment(segments, 'add', right[j]);
        j += 1;
    }

    return segments;
};

export const computeLineDiff = (leftText, rightText) => {
    const leftLines = splitLines(leftText);
    const rightLines = splitLines(rightText);
    const segments = computeLcsDiff(leftLines, rightLines);

    let added = 0;
    let removed = 0;

    segments.forEach((segment) => {
        if (segment.type === 'add') {
            added += segment.lines.length;
        } else if (segment.type === 'remove') {
            removed += segment.lines.length;
        }
    });

    return {
        segments,
        summary: {
            added,
            removed,
            unchanged: Math.max(leftLines.length, rightLines.length) - Math.max(added, removed)
        }
    };
};

const segmentPrefix = {
    equal: '  ',
    add: '+ ',
    remove: '- '
};

const renderDiffHtml = (segments) => {
    const rows = [];
    let oldLine = 1;
    let newLine = 1;

    segments.forEach((segment) => {
        segment.lines.forEach((line) => {
            let oldNumber = '';
            let newNumber = '';
            let marker = ' ';

            if (segment.type === 'equal') {
                oldNumber = `${oldLine}`;
                newNumber = `${newLine}`;
                oldLine += 1;
                newLine += 1;
            } else if (segment.type === 'remove') {
                oldNumber = `${oldLine}`;
                oldLine += 1;
                marker = '-';
            } else {
                newNumber = `${newLine}`;
                newLine += 1;
                marker = '+';
            }

            rows.push(
                `<div class="diff-row diff-row-${segment.type}">`
                + `<span class="diff-row-ln">${oldNumber}</span>`
                + `<span class="diff-row-ln">${newNumber}</span>`
                + `<span class="diff-row-code">${marker} ${escapeHtml(line)}</span>`
                + '</div>'
            );
        });
    });

    if (rows.length === 0) {
        rows.push(
            '<div class="diff-row diff-row-equal">'
            + '<span class="diff-row-ln">1</span>'
            + '<span class="diff-row-ln">1</span>'
            + '<span class="diff-row-code">  </span>'
            + '</div>'
        );
    }

    return `<div class="diff-output-table">${rows.join('')}</div>`;
};

export class DiffModeController {
    constructor({
        leftEditor,
        rightEditor,
        leftLineNumbers,
        rightLineNumbers,
        outputElement,
        onLeftInput,
        onRightInput,
        onSummaryChange
    }) {
        this.leftEditor = leftEditor;
        this.rightEditor = rightEditor;
        this.leftLineNumbers = leftLineNumbers;
        this.rightLineNumbers = rightLineNumbers;
        this.leftLineNumbersScroller = leftLineNumbers?.parentElement || null;
        this.rightLineNumbersScroller = rightLineNumbers?.parentElement || null;
        this.outputElement = outputElement;
        this.onLeftInput = onLeftInput;
        this.onRightInput = onRightInput;
        this.onSummaryChange = onSummaryChange;
        this.silentUpdate = false;

        this.bindEvents();
    }

    bindEvents() {
        this.leftEditor.addEventListener('input', () => {
            if (this.silentUpdate) return;
            this.onLeftInput(this.leftEditor.value);
            this.refreshLineNumbers('left');
            this.renderDiff(this.leftEditor.value, this.rightEditor.value);
        });

        this.rightEditor.addEventListener('input', () => {
            if (this.silentUpdate) return;
            this.onRightInput(this.rightEditor.value);
            this.refreshLineNumbers('right');
            this.renderDiff(this.leftEditor.value, this.rightEditor.value);
        });

        this.leftEditor.addEventListener('scroll', () => {
            this.syncLineNumberScroll('left');
        });

        this.rightEditor.addEventListener('scroll', () => {
            this.syncLineNumberScroll('right');
        });
    }

    renderTab(tab) {
        const leftText = tab?.diff?.left || '';
        const rightText = tab?.diff?.right || '';

        this.silentUpdate = true;
        this.leftEditor.value = leftText;
        this.rightEditor.value = rightText;
        this.silentUpdate = false;

        this.refreshLineNumbers('left');
        this.refreshLineNumbers('right');
        this.syncLineNumberScroll('left');
        this.syncLineNumberScroll('right');
        this.renderDiff(leftText, rightText);
    }

    refreshLineNumbers(side) {
        if (side === 'left') {
            this.leftLineNumbers.innerHTML = renderLineNumbers(getLineCount(this.leftEditor.value));
            return;
        }

        this.rightLineNumbers.innerHTML = renderLineNumbers(getLineCount(this.rightEditor.value));
    }

    syncLineNumberScroll(side) {
        if (side === 'left') {
            if (this.leftLineNumbersScroller) {
                this.leftLineNumbersScroller.scrollTop = this.leftEditor.scrollTop;
            }
            return;
        }

        if (this.rightLineNumbersScroller) {
            this.rightLineNumbersScroller.scrollTop = this.rightEditor.scrollTop;
        }
    }

    renderDiff(leftText, rightText) {
        const diff = computeLineDiff(leftText, rightText);
        this.outputElement.innerHTML = renderDiffHtml(diff.segments);
        this.onSummaryChange(diff.summary);
    }

    getExportText() {
        const left = this.leftEditor.value || '';
        const right = this.rightEditor.value || '';
        const diff = computeLineDiff(left, right);

        const lines = [];
        lines.push('=== Content 1 ===');
        lines.push(left);
        lines.push('');
        lines.push('=== Content 2 ===');
        lines.push(right);
        lines.push('');
        lines.push('=== Diff ===');

        diff.segments.forEach((segment) => {
            const prefix = segmentPrefix[segment.type] || '  ';
            segment.lines.forEach((line) => lines.push(`${prefix}${line}`));
        });

        lines.push('');
        lines.push(`Summary: +${diff.summary.added} -${diff.summary.removed}`);
        return lines.join('\n');
    }
}
