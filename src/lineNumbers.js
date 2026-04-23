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
        this.lineLabelResolver = null;
        this.lastText = '';
        this.wrapRowsByLine = [1];
        this.wrapPrefixRows = [0, 1];
        this.totalVisualRows = 1;
        this.lastContentWidth = 0;
        this.tabSize = 4;
        this.wrapEnabled = true;

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

    setLineLabelResolver(resolver) {
        this.lineLabelResolver = typeof resolver === 'function' ? resolver : null;
    }

    getTotalLineCount() {
        return this.totalLineCount;
    }

    updateFromText(text) {
        this.lastText = `${text || ''}`;
        this.totalLineCount = countLines(text);
        this.updateLineHeight();
        if (this.wrapEnabled) {
            this.updateWrapMetrics();
        } else {
            this.wrapRowsByLine = Array.from({ length: this.totalLineCount }, () => 1);
            this.wrapPrefixRows = [0];
            for (let i = 0; i < this.wrapRowsByLine.length; i += 1) {
                this.wrapPrefixRows.push(this.wrapPrefixRows[i] + this.wrapRowsByLine[i]);
            }
            this.totalVisualRows = this.totalLineCount;
        }
        this.updateWidth();
        this.renderViewport();
    }

    setWrapEnabled(enabled) {
        const next = Boolean(enabled);
        if (this.wrapEnabled === next) return;
        this.wrapEnabled = next;
        this.updateFromText(this.lastText);
    }

    updateLineHeight() {
        const computed = window.getComputedStyle(this.editor);
        const parsed = Number.parseFloat(computed.lineHeight);
        if (!Number.isNaN(parsed) && parsed > 0) {
            this.lineHeightPx = parsed;
        }

        const parsedTab = Number.parseInt(computed.tabSize || '', 10);
        if (Number.isInteger(parsedTab) && parsedTab > 0) {
            this.tabSize = parsedTab;
        }
    }

    getEditorContentWidth() {
        const computed = window.getComputedStyle(this.editor);
        const paddingLeft = Number.parseFloat(computed.paddingLeft || '0') || 0;
        const paddingRight = Number.parseFloat(computed.paddingRight || '0') || 0;
        return Math.max(1, this.editor.clientWidth - paddingLeft - paddingRight);
    }

    getMonospaceCharWidth() {
        const probe = document.createElement('span');
        probe.textContent = 'M';
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        probe.style.whiteSpace = 'pre';

        const computed = window.getComputedStyle(this.editor);
        probe.style.fontFamily = computed.fontFamily;
        probe.style.fontSize = computed.fontSize;
        probe.style.fontWeight = computed.fontWeight;
        probe.style.letterSpacing = computed.letterSpacing;

        document.body.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();

        return width > 0 ? width : 8;
    }

    updateWrapMetrics() {
        const contentWidth = this.getEditorContentWidth();
        this.lastContentWidth = contentWidth;

        const charWidth = this.getMonospaceCharWidth();
        const wrapColumns = Math.max(1, Math.floor(contentWidth / Math.max(1, charWidth)));
        const lines = this.lastText.replaceAll('\r\n', '\n').split('\n');

        this.wrapRowsByLine = lines.map((line) => {
            if (!line || line.length === 0) return 1;

            const expanded = line.replaceAll('\t', ' '.repeat(this.tabSize));
            return Math.max(1, Math.ceil(expanded.length / wrapColumns));
        });

        if (this.wrapRowsByLine.length === 0) {
            this.wrapRowsByLine = [1];
        }

        this.wrapPrefixRows = [0];
        for (let i = 0; i < this.wrapRowsByLine.length; i += 1) {
            this.wrapPrefixRows.push(this.wrapPrefixRows[i] + this.wrapRowsByLine[i]);
        }

        this.totalVisualRows = this.wrapPrefixRows[this.wrapPrefixRows.length - 1] || 1;
    }

    ensureWrapMetricsCurrent() {
        if (!this.wrapEnabled) return;

        const contentWidth = this.getEditorContentWidth();
        if (Math.abs(contentWidth - this.lastContentWidth) < 0.5) return;

        this.updateLineHeight();
        this.updateWrapMetrics();
    }

    findLineFromVisualRow(visualRowIndex) {
        let low = 0;
        let high = this.wrapPrefixRows.length - 1;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this.wrapPrefixRows[mid] <= visualRowIndex) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        return Math.max(1, low);
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
        this.ensureWrapMetricsCurrent();

        const viewportHeight = this.editor.clientHeight || 0;
        const maxHeight = Math.max(this.totalVisualRows * this.lineHeightPx, viewportHeight);
        this.spacer.style.height = `${maxHeight}px`;

        const firstVisibleVisualRow = Math.max(
            0,
            Math.floor(this.editor.scrollTop / this.lineHeightPx) - this.overscan
        );
        const visibleVisualCount = Math.ceil(viewportHeight / this.lineHeightPx) + (this.overscan * 2);
        const lastVisibleVisualRow = Math.min(this.totalVisualRows - 1, firstVisibleVisualRow + visibleVisualCount - 1);

        const firstVisibleLine = this.findLineFromVisualRow(firstVisibleVisualRow);
        const lastVisibleLine = this.findLineFromVisualRow(lastVisibleVisualRow);

        const html = [];
        for (let line = firstVisibleLine; line <= lastVisibleLine; line += 1) {
            const state = this.foldIndicatorResolver ? (this.foldIndicatorResolver(line) || 'none') : 'none';
            const resolvedLabel = this.lineLabelResolver ? this.lineLabelResolver(line) : line;
            const label = Number.isInteger(resolvedLabel) && resolvedLabel > 0 ? resolvedLabel : line;

            const wrappedRows = this.wrapRowsByLine[line - 1] || 1;
            html.push(
                `<div class="line-number" data-line="${line}">`
                + `<span class="line-fold-indicator line-fold-${state}" aria-hidden="true"></span>`
                + `<span class="line-number-label">${label}</span>`
                + '</div>'
            );

            for (let continuation = 1; continuation < wrappedRows; continuation += 1) {
                html.push(
                    '<div class="line-number line-number-continuation">'
                    + '<span class="line-fold-indicator" aria-hidden="true"></span>'
                    + '<span class="line-number-label"></span>'
                    + '</div>'
                );
            }
        }

        const firstLineVisualRow = this.wrapPrefixRows[firstVisibleLine - 1] || 0;
        const y = (firstLineVisualRow * this.lineHeightPx) - this.editor.scrollTop;
        this.viewport.style.transform = `translateY(${y}px)`;
        this.viewport.innerHTML = html.join('');
    }
}
