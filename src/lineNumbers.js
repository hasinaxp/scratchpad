import { countLines } from './utils.js';

export class LineNumbersManager {
    constructor(view, lineNumbers, overscan = 24) {
        this.view = view;
        this.lineNumbers = lineNumbers;
        this.overscan = overscan;
        this.totalLineCount = 1;
        this.rafId = 0;
        this.onLineNumberClick = null;
        this.foldIndicatorResolver = null;
        this.lineLabelResolver = null;

        this.viewport = document.createElement('div');
        this.viewport.className = 'line-numbers-viewport';

        this.lineNumbers.append(this.viewport);

        this.viewport.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const row = target.closest('.line-number');
            if (!row || !this.onLineNumberClick) return;

            const value = Number.parseInt(row.getAttribute('data-line') || '', 10);
            if (!Number.isInteger(value) || value <= 0) return;
            this.onLineNumberClick(value);
        });
    }

    setLineNumberClickHandler(handler) {
        this.onLineNumberClick = typeof handler === 'function' ? handler : null;
    }

    setFoldIndicatorResolver(resolver) {
        this.foldIndicatorResolver = typeof resolver === 'function' ? resolver : null;
    }

    setLineLabelResolver(resolver) {
        this.lineLabelResolver = typeof resolver === 'function' ? resolver : null;
    }

    getTotalLineCount() {
        return this.totalLineCount;
    }

    updateFromText(text) {
        this.totalLineCount = countLines(text);
        this.updateWidth();
        this.renderViewport();
    }

    updateWidth() {
        const digits = Math.max(2, String(this.totalLineCount).length);
        const width = `${digits + 3.2}ch`;
        this.lineNumbers.style.width = width;
        this.lineNumbers.style.minWidth = width;
    }

    scheduleRenderViewport() {
        if (this.rafId) return;

        this.rafId = window.requestAnimationFrame(() => {
            this.rafId = 0;
            this.renderViewport();
        });
    }

    renderViewport() {
        // Rows come from the text view's layout, so wrapped lines line up with the canvas exactly.
        const { rowPrefix, lineHeight, padTop, scrollY, viewportHeight } = this.view.getMetrics();
        const lineCount = rowPrefix.length - 1;
        const totalRows = rowPrefix[lineCount];
        const findLine = (row) => {
            let low = 0;
            let high = lineCount;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (rowPrefix[mid + 1] <= row) low = mid + 1; else high = mid;
            }
            return low + 1;
        };

        const firstVisibleRow = Math.max(0, Math.floor((scrollY - padTop) / lineHeight) - this.overscan);
        const visibleRowCount = Math.ceil(viewportHeight / lineHeight) + (this.overscan * 2);
        const lastVisibleRow = Math.min(totalRows - 1, firstVisibleRow + visibleRowCount - 1);
        const firstVisibleLine = findLine(Math.min(firstVisibleRow, totalRows - 1));
        const lastVisibleLine = findLine(lastVisibleRow);

        // Each label is placed at its own row's y, the same formula the canvas uses, so stacked
        // box heights can't accumulate rounding error over many lines.
        const html = [];
        for (let line = firstVisibleLine; line <= lastVisibleLine; line += 1) {
            const state = this.foldIndicatorResolver ? (this.foldIndicatorResolver(line) || 'none') : 'none';
            const resolvedLabel = this.lineLabelResolver ? this.lineLabelResolver(line) : line;
            const label = Number.isInteger(resolvedLabel) && resolvedLabel > 0 ? resolvedLabel : line;
            const y = padTop + (rowPrefix[line - 1] * lineHeight) - scrollY;

            html.push(
                `<div class="line-number" data-line="${line}" style="top:${y}px">`
                + `<span class="line-fold-indicator line-fold-${state}" aria-hidden="true"></span>`
                + `<span class="line-number-label">${label}</span>`
                + '</div>'
            );
        }

        this.viewport.style.setProperty('--line-height', `${lineHeight}px`);
        this.viewport.innerHTML = html.join('');
    }
}
