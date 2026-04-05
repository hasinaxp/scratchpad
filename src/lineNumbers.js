import { countLines } from './utils.js';

export class LineNumbersManager {
    constructor(editor, lineNumbers, overscan = 24) {
        this.editor = editor;
        this.lineNumbers = lineNumbers;
        this.overscan = overscan;
        this.lineHeightPx = 18;
        this.totalLineCount = 1;
        this.rafId = 0;
        this.onLineNumberClick = null;
        this.foldIndicatorResolver = null;

        this.spacer = document.createElement('div');
        this.spacer.className = 'line-numbers-spacer';

        this.viewport = document.createElement('div');
        this.viewport.className = 'line-numbers-viewport';

        this.lineNumbers.append(this.spacer, this.viewport);

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

    getTotalLineCount() {
        return this.totalLineCount;
    }

    updateFromText(text) {
        this.totalLineCount = countLines(text);
        this.updateLineHeight();
        this.updateWidth();
        this.renderViewport();
    }

    updateLineHeight() {
        const computed = window.getComputedStyle(this.editor);
        const parsed = Number.parseFloat(computed.lineHeight);
        if (!Number.isNaN(parsed) && parsed > 0) {
            this.lineHeightPx = parsed;
        }
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
        const viewportHeight = this.editor.clientHeight || 0;
        const maxHeight = Math.max(this.totalLineCount * this.lineHeightPx, viewportHeight);
        this.spacer.style.height = `${maxHeight}px`;

        const firstVisibleLine = Math.max(
            1,
            Math.floor(this.editor.scrollTop / this.lineHeightPx) - this.overscan + 1
        );
        const visibleCount = Math.ceil(viewportHeight / this.lineHeightPx) + (this.overscan * 2);
        const lastVisibleLine = Math.min(this.totalLineCount, firstVisibleLine + visibleCount - 1);

        const html = [];
        for (let line = firstVisibleLine; line <= lastVisibleLine; line += 1) {
            const state = this.foldIndicatorResolver ? (this.foldIndicatorResolver(line) || 'none') : 'none';
            html.push(
                `<div class="line-number" data-line="${line}">`
                + `<span class="line-fold-indicator line-fold-${state}" aria-hidden="true"></span>`
                + `<span class="line-number-label">${line}</span>`
                + '</div>'
            );
        }

        const y = ((firstVisibleLine - 1) * this.lineHeightPx) - this.editor.scrollTop;
        this.viewport.style.transform = `translateY(${y}px)`;
        this.viewport.innerHTML = html.join('');
    }
}
