import { TAB_INDENT } from './utils.js';
import { highlightText } from './syntaxHighlighter.js';

const LARGE_CONTENT_THRESHOLD = 60000;
const LARGE_CONTENT_HIGHLIGHT_DELAY = 140;

export class EditorController {
    constructor({ editor, highlightLayer, stateStore, lineNumbers, statusBar, onActiveTitleChange }) {
        this.editor = editor;
        this.highlightLayer = highlightLayer;
        this.stateStore = stateStore;
        this.lineNumbers = lineNumbers;
        this.statusBar = statusBar;
        this.onActiveTitleChange = onActiveTitleChange;
        this.lastEnterHandledAt = 0;
        this.highlightRaf = 0;
        this.highlightTimer = 0;
        this.highlightEnabled = true;
        this.editorPane = this.editor.closest('.editor-pane');

        this.bindEvents();
    }

    getContent() {
        return this.editor.value || '';
    }

    setContent(value) {
        this.editor.value = value;
    }

    getSelectionOffsets() {
        return {
            start: this.editor.selectionStart ?? 0,
            end: this.editor.selectionEnd ?? 0
        };
    }

    getSelectedText() {
        const { start, end } = this.getSelectionOffsets();
        if (start === end) return '';
        return this.getContent().slice(start, end);
    }

    setSelectionOffsets(start, end = start) {
        this.editor.setSelectionRange(start, end);
        this.editor.focus();
    }

    replaceSelectionText(nextSelectionText) {
        const { start, end } = this.getSelectionOffsets();
        const text = this.getContent();
        const nextText = `${text.slice(0, start)}${nextSelectionText}${text.slice(end)}`;
        const nextCaret = start + nextSelectionText.length;
        this.applyTextChange(nextText, nextCaret);
    }

    syncModelFromEditor() {
        const normalizedText = this.getContent();
        this.stateStore.updateActiveTabContent(normalizedText);
        this.updateHighlightMode(normalizedText.length, this.getLanguage());
        this.scheduleHighlight();
        this.lineNumbers.updateFromText(normalizedText);
        this.statusBar.scheduleUpdate();

        const activeTab = this.stateStore.getActiveTab();
        if (activeTab) {
            this.onActiveTitleChange(activeTab.title);
        }
    }

    getLineRangeAt(offset, text = this.getContent()) {
        const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const newlineIndex = text.indexOf('\n', offset);
        const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
        return { lineStart, lineEnd };
    }

    getSelectedLineBlockRange(start, end, text = this.getContent()) {
        const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
        const newlineAfterEnd = text.indexOf('\n', end);
        const lineEnd = newlineAfterEnd === -1 ? text.length : newlineAfterEnd + 1;
        return { lineStart, lineEnd };
    }

    copyToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    }

    handleCopyOrCutLine(isCut = false) {
        const { start, end } = this.getSelectionOffsets();
        if (start !== end) return false;

        const text = this.getContent();
        const { lineStart, lineEnd } = this.getLineRangeAt(start, text);
        const hasNewline = lineEnd < text.length;
        const lineText = text.slice(lineStart, lineEnd) + (hasNewline ? '\n' : '');
        this.copyToClipboard(lineText);

        if (!isCut) return true;

        const removeStart = lineStart;
        const removeEnd = hasNewline ? lineEnd + 1 : lineEnd;
        const nextText = `${text.slice(0, removeStart)}${text.slice(removeEnd)}`;
        this.applyTextChange(nextText, Math.min(removeStart, nextText.length));
        return true;
    }

    moveSelectedLines(direction) {
        const { start, end } = this.getSelectionOffsets();
        const text = this.getContent();
        const { lineStart, lineEnd } = this.getSelectedLineBlockRange(start, end, text);
        const currentBlock = text.slice(lineStart, lineEnd);
        const caretOffsetInBlock = Math.max(0, start - lineStart);
        const hasSelection = start !== end;
        const selectionStartOffset = Math.max(0, start - lineStart);
        const selectionEndOffset = Math.max(0, end - lineStart);

        if (direction === 'up') {
            if (lineStart === 0) return true;

            const prevBreak = text.lastIndexOf('\n', lineStart - 2);
            const prevStart = prevBreak === -1 ? 0 : prevBreak + 1;
            const prevBlock = text.slice(prevStart, lineStart);
            const nextText = `${text.slice(0, prevStart)}${currentBlock}${prevBlock}${text.slice(lineEnd)}`;
            const movedStart = prevStart;

            if (hasSelection) {
                const nextSelectionStart = Math.min(movedStart + selectionStartOffset, nextText.length);
                const nextSelectionEnd = Math.min(movedStart + selectionEndOffset, nextText.length);
                this.applyTextChange(nextText, nextSelectionStart, nextSelectionEnd);
            } else {
                const nextCaret = Math.min(movedStart + caretOffsetInBlock, nextText.length);
                this.applyTextChange(nextText, nextCaret);
            }
            return true;
        }

        if (lineEnd >= text.length) return true;

        const nextBreak = text.indexOf('\n', lineEnd);
        const nextEnd = nextBreak === -1 ? text.length : nextBreak + 1;
        const nextBlock = text.slice(lineEnd, nextEnd);
        const nextText = `${text.slice(0, lineStart)}${nextBlock}${currentBlock}${text.slice(nextEnd)}`;
        const movedStart = lineStart + nextBlock.length;

        if (hasSelection) {
            const nextSelectionStart = Math.min(movedStart + selectionStartOffset, nextText.length);
            const nextSelectionEnd = Math.min(movedStart + selectionEndOffset, nextText.length);
            this.applyTextChange(nextText, nextSelectionStart, nextSelectionEnd);
        } else {
            const nextCaret = Math.min(movedStart + caretOffsetInBlock, nextText.length);
            this.applyTextChange(nextText, nextCaret);
        }
        return true;
    }

    duplicateSelectedLines(direction) {
        const { start, end } = this.getSelectionOffsets();
        const text = this.getContent();
        const { lineStart, lineEnd } = this.getSelectedLineBlockRange(start, end, text);
        const block = text.slice(lineStart, lineEnd);

        if (direction === 'up') {
            const nextText = `${text.slice(0, lineStart)}${block}${text.slice(lineStart)}`;
            this.applyTextChange(nextText, lineStart, lineStart + block.length);
            return true;
        }

        const insertion = lineEnd === text.length && !block.endsWith('\n') ? `\n${block}` : block;
        const nextText = `${text.slice(0, lineEnd)}${insertion}${text.slice(lineEnd)}`;
        const selectionStart = lineEnd;
        this.applyTextChange(nextText, selectionStart, selectionStart + insertion.length);
        return true;
    }

    deleteSelectedLines() {
        const { start, end } = this.getSelectionOffsets();
        const text = this.getContent();
        const { lineStart, lineEnd } = this.getSelectedLineBlockRange(start, end, text);

        let removeStart = lineStart;
        let removeEnd = lineEnd;

        if (lineEnd === text.length && lineStart > 0) {
            removeStart = lineStart - 1;
        }

        const nextText = `${text.slice(0, removeStart)}${text.slice(removeEnd)}`;
        this.applyTextChange(nextText, Math.min(removeStart, nextText.length));
        return true;
    }

    insertLineRelative(position) {
        const { start, end } = this.getSelectionOffsets();
        const text = this.getContent();
        const { lineStart, lineEnd } = this.getLineRangeAt(start, text);
        const lineText = text.slice(lineStart, lineEnd);
        const indentation = (lineText.match(/^[\t ]+/) || [''])[0];

        if (position === 'below') {
            const insertAt = lineEnd;
            const insertion = `\n${indentation}`;
            const nextText = `${text.slice(0, insertAt)}${insertion}${text.slice(insertAt)}`;
            const caret = insertAt + insertion.length;
            this.applyTextChange(nextText, caret);
            return true;
        }

        const insertAt = lineStart;
        const insertion = `${indentation}\n`;
        const nextText = `${text.slice(0, insertAt)}${insertion}${text.slice(insertAt)}`;
        const caret = insertAt + indentation.length;
        this.applyTextChange(nextText, caret);
        return true;
    }

    handleBackspaceTabIndent() {
        const { start, end } = this.getSelectionOffsets();
        if (start !== end || start === 0) return false;

        const text = this.getContent();
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const prefix = text.slice(lineStart, start);

        if (!/^\s+$/.test(prefix)) return false;

        const tabSize = TAB_INDENT.length;
        const removeCount = prefix.endsWith(TAB_INDENT)
            ? tabSize
            : ((prefix.length - 1) % tabSize) + 1;

        const nextStart = start - removeCount;
        const nextText = `${text.slice(0, nextStart)}${text.slice(end)}`;
        this.applyTextChange(nextText, nextStart);
        return true;
    }

    applyTextChange(nextText, nextStart, nextEnd = nextStart) {
        this.stateStore.updateActiveTabContent(nextText);
        const activeTab = this.stateStore.getActiveTab();

        this.setContent(nextText);
        this.scheduleHighlight();
        this.lineNumbers.updateFromText(nextText);
        this.statusBar.scheduleUpdate();
        this.setSelectionOffsets(nextStart, nextEnd);

        if (activeTab) {
            this.onActiveTitleChange(activeTab.title);
        }
    }

    updateHighlightMode(contentLength = this.getContent().length, language = this.getLanguage()) {
        const shouldEnable = true;
        this.highlightEnabled = shouldEnable;

        if (!this.editorPane) return;

        this.editorPane.classList.toggle('highlight-enabled', shouldEnable);
        this.editorPane.classList.toggle('highlight-disabled', !shouldEnable);

        if (!shouldEnable) {
            this.highlightLayer.innerHTML = '';
        }
    }

    insertNewlineWithIndent() {
        const offsets = this.getSelectionOffsets();
        if (!offsets) return false;

        const { start, end } = offsets;
        const text = this.getContent();
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const linePrefix = text.slice(lineStart, start);
        const indentation = (linePrefix.match(/^[\t ]+/) || [''])[0];
        const insertion = `\n${indentation}`;
        const nextText = `${text.slice(0, start)}${insertion}${text.slice(end)}`;

        this.applyTextChange(nextText, start + insertion.length);
        this.lastEnterHandledAt = performance.now();
        return true;
    }

    renderActiveTab() {
        const activeTab = this.stateStore.getActiveTab();
        this.setContent(activeTab ? activeTab.content : '');
        this.editor.readOnly = !activeTab;
        this.editor.scrollTop = activeTab?.scrollTop || 0;
        this.editor.scrollLeft = 0;
        this.updateHighlightMode(this.getContent().length, this.getLanguage());
        this.renderHighlight();
        this.lineNumbers.updateFromText(this.getContent());
        this.statusBar.scheduleUpdate();
        this.syncHighlightScroll();
    }

    getLanguage() {
        return this.stateStore.getActiveTab()?.language || 'markdown';
    }

    renderHighlight() {
        if (!this.highlightEnabled) {
            this.highlightLayer.innerHTML = '';
            return;
        }

        const content = this.getContent();
        this.highlightLayer.innerHTML = highlightText(content, this.getLanguage());
    }

    scheduleHighlight() {
        const contentLength = this.getContent().length;
        if (!this.highlightEnabled) return;

        if (contentLength > LARGE_CONTENT_THRESHOLD) {
            if (this.highlightRaf) {
                window.cancelAnimationFrame(this.highlightRaf);
                this.highlightRaf = 0;
            }

            if (this.highlightTimer) {
                window.clearTimeout(this.highlightTimer);
            }

            this.highlightTimer = window.setTimeout(() => {
                this.highlightTimer = 0;
                this.renderHighlight();
                this.syncHighlightScroll();
            }, LARGE_CONTENT_HIGHLIGHT_DELAY);
            return;
        }

        if (this.highlightTimer) {
            window.clearTimeout(this.highlightTimer);
            this.highlightTimer = 0;
        }

        if (this.highlightRaf) return;
        this.highlightRaf = window.requestAnimationFrame(() => {
            this.highlightRaf = 0;
            this.renderHighlight();
            this.syncHighlightScroll();
        });
    }

    syncHighlightScroll() {
        this.highlightLayer.style.transform = `translate(${-this.editor.scrollLeft}px, ${-this.editor.scrollTop}px)`;
    }

    setLanguage(language) {
        this.stateStore.updateActiveTabLanguage(language);
        this.updateHighlightMode(this.getContent().length, language);
        this.renderHighlight();
    }

    bindEvents() {
        this.editor.addEventListener('input', () => {
            this.syncModelFromEditor();
        });

        this.editor.addEventListener('scroll', () => {
            this.stateStore.updateActiveTabScroll(this.editor.scrollTop);
            this.lineNumbers.scheduleRenderViewport();
            this.syncHighlightScroll();
        });

        this.editor.addEventListener('keydown', (event) => {
            const offsets = this.getSelectionOffsets();
            if (!offsets) return;

            const { start, end } = offsets;
            const text = this.getContent();

            if (event.key === 'Backspace' && this.handleBackspaceTabIndent()) {
                event.preventDefault();
                return;
            }

            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                this.deleteSelectedLines();
                return;
            }

            if (event.ctrlKey && event.shiftKey && event.key === 'Enter') {
                event.preventDefault();
                this.insertLineRelative('above');
                return;
            }

            if (event.ctrlKey && event.key === 'Enter') {
                event.preventDefault();
                this.insertLineRelative('below');
                return;
            }

            if (event.shiftKey && event.altKey && event.key === 'ArrowUp') {
                event.preventDefault();
                this.duplicateSelectedLines('up');
                return;
            }

            if (event.shiftKey && event.altKey && event.key === 'ArrowDown') {
                event.preventDefault();
                this.duplicateSelectedLines('down');
                return;
            }

            if (event.altKey && event.key === 'ArrowUp') {
                event.preventDefault();
                this.moveSelectedLines('up');
                return;
            }

            if (event.altKey && event.key === 'ArrowDown') {
                event.preventDefault();
                this.moveSelectedLines('down');
                return;
            }

            if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'c' && start === end) {
                event.preventDefault();
                this.handleCopyOrCutLine(false);
                return;
            }

            if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'x' && start === end) {
                event.preventDefault();
                this.handleCopyOrCutLine(true);
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                this.insertNewlineWithIndent();
                return;
            }

            if (event.key === 'Tab') {
                event.preventDefault();

                if (start === end) {
                    const nextText = `${text.slice(0, start)}${TAB_INDENT}${text.slice(end)}`;
                    this.applyTextChange(nextText, start + TAB_INDENT.length);
                    return;
                }

                const blockStart = text.lastIndexOf('\n', start - 1) + 1;
                const blockEndIndex = text.indexOf('\n', end);
                const blockEnd = blockEndIndex === -1 ? text.length : blockEndIndex;
                const selectedBlock = text.slice(blockStart, blockEnd);
                const lines = selectedBlock.split('\n');
                const indentedBlock = lines.map((line) => `${TAB_INDENT}${line}`).join('\n');
                const nextText = `${text.slice(0, blockStart)}${indentedBlock}${text.slice(blockEnd)}`;
                const nextSelectionStart = start + TAB_INDENT.length;
                const nextSelectionEnd = end + (TAB_INDENT.length * lines.length);

                this.applyTextChange(nextText, nextSelectionStart, nextSelectionEnd);
                return;
            }

            const quotePairs = { '"': '"', "'": "'", '`': '`' };
            const quoteChar = quotePairs[event.key];
            if (quoteChar) {
                event.preventDefault();

                // In markdown, allow natural fence typing (```), don't force-pair consecutive backticks.
                if (event.key === '`' && this.getLanguage() === 'markdown') {
                    const prevChar = start > 0 ? text[start - 1] : '';
                    if (prevChar === '`') {
                        const nextText = `${text.slice(0, start)}\`${text.slice(end)}`;
                        this.applyTextChange(nextText, start + 1);
                        return;
                    }
                }

                if (start !== end) {
                    const selectedText = text.slice(start, end);
                    const wrapped = `${event.key}${selectedText}${quoteChar}`;
                    const nextText = `${text.slice(0, start)}${wrapped}${text.slice(end)}`;
                    this.applyTextChange(nextText, start + 1, start + 1 + selectedText.length);
                    return;
                }

                const rightChar = text[end] || '';
                if (rightChar === quoteChar) {
                    this.setSelectionOffsets(end + 1);
                    return;
                }

                const pairText = `${event.key}${quoteChar}`;
                const nextText = `${text.slice(0, start)}${pairText}${text.slice(end)}`;
                this.applyTextChange(nextText, start + 1);
                return;
            }

            const pairs = { '(': ')', '[': ']', '{': '}' };
            const closeChar = pairs[event.key];
            if (!closeChar) return;

            event.preventDefault();

            if (start !== end) {
                const selectedText = text.slice(start, end);
                const wrapped = `${event.key}${selectedText}${closeChar}`;
                const nextText = `${text.slice(0, start)}${wrapped}${text.slice(end)}`;
                this.applyTextChange(nextText, start + 1, start + 1 + selectedText.length);
                return;
            }

            const rightChar = text[end] || '';
            if (rightChar === closeChar) {
                const nextText = `${text.slice(0, start)}${event.key}${text.slice(end)}`;
                this.applyTextChange(nextText, start + 1);
                return;
            }

            const pairText = `${event.key}${closeChar}`;
            const nextText = `${text.slice(0, start)}${pairText}${text.slice(end)}`;
            this.applyTextChange(nextText, start + 1);
        });

        this.editor.addEventListener('paste', () => {
            // Let the browser paste natively, then synchronize once the value updates.
            window.requestAnimationFrame(() => {
                this.syncModelFromEditor();
            });
        });

        this.editor.addEventListener('click', () => this.statusBar.scheduleUpdate());
        this.editor.addEventListener('keyup', () => this.statusBar.scheduleUpdate());

        this.editor.addEventListener('select', () => this.statusBar.scheduleUpdate());
    }
}
