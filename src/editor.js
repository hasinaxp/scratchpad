import { TAB_INDENT } from './utils.js';
import { highlightText } from './syntaxHighlighter.js';

const LARGE_CONTENT_THRESHOLD = 1_000_000;
const LARGE_CONTENT_HIGHLIGHT_DELAY = 140;
const TAB_WIDTH_FOR_INDENT = 4;
const HISTORY_LIMIT = 200;
const MAX_HISTORY_TABS = 50;

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
        this.foldStateByTabId = new Map();
        this.displayToRawLineMap = null;
        this.foldableRangeByStartLine = new Map();
        this.collapsedStartLines = new Set();
        this.historyByTabId = new Map();

        this.bindEvents();
    }

    getContent() {
        if (this.isFoldedViewActive()) {
            return this.stateStore.getActiveTab()?.content || '';
        }
        return this.editor.value || '';
    }

    getDisplayContent() {
        return this.editor.value || '';
    }

    isFoldedViewActive() {
        const activeTab = this.stateStore.getActiveTab();
        if (!activeTab) return false;
        const state = this.foldStateByTabId.get(activeTab.id);
        return Boolean(state && Array.isArray(state.collapsed) && state.collapsed.length > 0);
    }

    getActiveFoldState() {
        const activeTab = this.stateStore.getActiveTab();
        if (!activeTab) return null;

        if (!this.foldStateByTabId.has(activeTab.id)) {
            this.foldStateByTabId.set(activeTab.id, { collapsed: [] });
        }

        return this.foldStateByTabId.get(activeTab.id);
    }

    getLineNumberFromOffset(offset, text = this.getDisplayContent()) {
        const before = text.slice(0, Math.max(0, offset));
        return (before.match(/\n/g)?.length || 0) + 1;
    }

    getHistoryForTab(tabId) {
        if (!tabId) return null;
        const existing = this.historyByTabId.get(tabId);
        if (existing) {
            this.historyByTabId.delete(tabId);
            this.historyByTabId.set(tabId, existing);
            return existing;
        }

        while (this.historyByTabId.size >= MAX_HISTORY_TABS) {
            const oldestKey = this.historyByTabId.keys().next().value;
            if (!oldestKey) break;
            this.historyByTabId.delete(oldestKey);
        }

        const created = {
            undo: [],
            redo: [],
            lastSnapshot: null
        };

        this.historyByTabId.set(tabId, created);
        return created;
    }

    getActiveHistory() {
        const tab = this.stateStore.getActiveTab();
        if (!tab) return null;
        return this.getHistoryForTab(tab.id);
    }

    clampHistoryStack(stack) {
        if (stack.length <= HISTORY_LIMIT) return;
        stack.splice(0, stack.length - HISTORY_LIMIT);
    }

    getHistoryCharBudget(lastSnapshotTextLength = 0) {
        if (lastSnapshotTextLength >= 750_000) return 6_000_000;
        if (lastSnapshotTextLength >= 250_000) return 12_000_000;
        return 24_000_000;
    }

    estimateHistoryChars(history) {
        let total = 0;
        if (history.lastSnapshot?.text) total += history.lastSnapshot.text.length;
        for (const item of history.undo) total += item.text.length;
        for (const item of history.redo) total += item.text.length;
        return total;
    }

    trimHistoryByBudget(history) {
        const budget = this.getHistoryCharBudget(history.lastSnapshot?.text?.length || 0);
        let total = this.estimateHistoryChars(history);

        while (total > budget && (history.undo.length > 0 || history.redo.length > 0)) {
            if (history.undo.length > 0) {
                history.undo.shift();
            } else {
                history.redo.shift();
            }
            total = this.estimateHistoryChars(history);
        }
    }

    pushUndoSnapshot(history, snapshot) {
        if (!history || !snapshot) return;
        const last = history.undo[history.undo.length - 1];
        if (last && last.text === snapshot.text && last.start === snapshot.start && last.end === snapshot.end) {
            return;
        }
        history.undo.push(snapshot);
        this.clampHistoryStack(history.undo);
        this.trimHistoryByBudget(history);
    }

    syncHistoryFromCurrentTab() {
        const tab = this.stateStore.getActiveTab();
        if (!tab) return;

        const history = this.getHistoryForTab(tab.id);
        if (!history) return;

        const folded = this.isFoldedViewActive();
        const start = folded ? 0 : (this.editor.selectionStart ?? 0);
        const end = folded ? 0 : (this.editor.selectionEnd ?? 0);
        history.lastSnapshot = {
            text: tab.content || '',
            start,
            end
        };
    }

    recordHistoryBeforeChange(nextText, nextStart, nextEnd, clearRedo = true) {
        const tab = this.stateStore.getActiveTab();
        if (!tab) return;
        const history = this.getHistoryForTab(tab.id);
        if (!history) return;

        const currentOffsets = this.getSelectionOffsets();
        const fallbackSnapshot = {
            text: tab.content || '',
            start: currentOffsets.start,
            end: currentOffsets.end
        };

        const previous = history.lastSnapshot || fallbackSnapshot;
        if (previous.text === nextText && previous.start === nextStart && previous.end === nextEnd) {
            history.lastSnapshot = { text: nextText, start: nextStart, end: nextEnd };
            return;
        }

        this.pushUndoSnapshot(history, previous);
        if (clearRedo) {
            history.redo.length = 0;
        }

        history.lastSnapshot = {
            text: nextText,
            start: nextStart,
            end: nextEnd
        };

        this.trimHistoryByBudget(history);
    }

    undo() {
        if (this.isFoldedViewActive()) {
            this.unfoldAll();
        }

        const tab = this.stateStore.getActiveTab();
        if (!tab) return false;

        const history = this.getHistoryForTab(tab.id);
        if (!history || history.undo.length === 0) return false;

        const currentOffsets = this.getSelectionOffsets();
        const current = {
            text: tab.content || '',
            start: currentOffsets.start,
            end: currentOffsets.end
        };

        const previous = history.undo.pop();
        if (!previous) return false;

        history.redo.push(current);
        this.clampHistoryStack(history.redo);
        this.trimHistoryByBudget(history);

        this.applyTextChange(previous.text, previous.start, previous.end, {
            recordHistory: false
        });

        history.lastSnapshot = { ...previous };
        return true;
    }

    redo() {
        if (this.isFoldedViewActive()) {
            this.unfoldAll();
        }

        const tab = this.stateStore.getActiveTab();
        if (!tab) return false;

        const history = this.getHistoryForTab(tab.id);
        if (!history || history.redo.length === 0) return false;

        const currentOffsets = this.getSelectionOffsets();
        const current = {
            text: tab.content || '',
            start: currentOffsets.start,
            end: currentOffsets.end
        };

        const next = history.redo.pop();
        if (!next) return false;

        this.pushUndoSnapshot(history, current);
        this.applyTextChange(next.text, next.start, next.end, {
            recordHistory: false
        });

        history.lastSnapshot = { ...next };
        return true;
    }

    refreshFoldMetadata(rawText, collapsed = []) {
        const foldable = this.getFoldableRanges(rawText);

        this.foldableRangeByStartLine = new Map();
        for (const range of foldable) {
            const prev = this.foldableRangeByStartLine.get(range.startLine);
            if (!prev || range.endLine > prev.endLine) {
                this.foldableRangeByStartLine.set(range.startLine, range.endLine);
            }
        }

        this.collapsedStartLines = new Set(collapsed.map((range) => range.startLine));
    }

    getFoldIndicatorForDisplayLine(displayLine) {
        const rawLine = this.toRawLineFromDisplayLine(displayLine);
        if (this.collapsedStartLines.has(rawLine)) return 'collapsed';
        if (this.foldableRangeByStartLine.has(rawLine)) return 'expanded';
        return 'none';
    }

    getLineLabelForDisplayLine(displayLine) {
        return this.toRawLineFromDisplayLine(displayLine);
    }

    toRawLineFromDisplayLine(displayLine) {
        if (!this.displayToRawLineMap || displayLine < 1 || displayLine > this.displayToRawLineMap.length) {
            return displayLine;
        }
        return this.displayToRawLineMap[displayLine - 1] || displayLine;
    }

    normalizeCollapsedRanges(collapsed) {
        if (!Array.isArray(collapsed) || collapsed.length === 0) return [];

        const dedup = new Map();
        collapsed
            .filter((range) => Number.isInteger(range?.startLine) && Number.isInteger(range?.endLine) && range.endLine > range.startLine)
            .forEach((range) => {
                const key = `${range.startLine}:${range.endLine}`;
                if (!dedup.has(key)) {
                    dedup.set(key, { ...range });
                }
            });

        return Array.from(dedup.values())
            .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    }

    syncCollapsedWithFoldableRanges(text, collapsed) {
        const foldable = this.getFoldableRanges(text);
        if (collapsed.length === 0 || foldable.length === 0) return [];

        const foldableByStart = new Map();
        for (const range of foldable) {
            const prev = foldableByStart.get(range.startLine);
            if (!prev || range.endLine > prev.endLine) {
                foldableByStart.set(range.startLine, range);
            }
        }

        return this.normalizeCollapsedRanges(
            collapsed
                .map((range) => {
                    const matched = foldableByStart.get(range.startLine);
                    if (!matched) return null;
                    return {
                        startLine: matched.startLine,
                        endLine: Math.min(range.endLine, matched.endLine)
                    };
                })
                .filter(Boolean)
        );
    }

    computeBraceFoldRanges(lines) {
        const stack = [];
        const ranges = [];
        let inBlockComment = false;

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            let inQuote = null;
            let escaped = false;

            for (let i = 0; i < line.length; i += 1) {
                const char = line[i];

                if (inBlockComment) {
                    if (char === '*' && line[i + 1] === '/') {
                        inBlockComment = false;
                        i += 1;
                    }
                    continue;
                }

                if (inQuote) {
                    if (escaped) {
                        escaped = false;
                        continue;
                    }

                    if (char === '\\') {
                        escaped = true;
                        continue;
                    }

                    if (char === inQuote) {
                        inQuote = null;
                    }
                    continue;
                }

                if (char === '/' && line[i + 1] === '/') {
                    break;
                }

                if (char === '/' && line[i + 1] === '*') {
                    inBlockComment = true;
                    i += 1;
                    continue;
                }

                if (char === '"' || char === '\'' || char === '`') {
                    inQuote = char;
                    continue;
                }

                if (char === '{') {
                    stack.push(index + 1);
                } else if (char === '}') {
                    const startLine = stack.pop();
                    if (Number.isInteger(startLine) && (index + 1) > startLine) {
                        ranges.push({ startLine, endLine: index + 1 });
                    }
                }
            }
        }

        return ranges;
    }

    getIndentLevel(line) {
        let level = 0;
        for (let i = 0; i < line.length; i += 1) {
            if (line[i] === ' ') {
                level += 1;
            } else if (line[i] === '\t') {
                level += TAB_WIDTH_FOR_INDENT;
            } else {
                break;
            }
        }
        return level;
    }

    computeIndentFoldRanges(lines) {
        const ranges = [];

        for (let i = 0; i < lines.length - 1; i += 1) {
            const current = lines[i];
            if (!current.trim()) continue;

            let nextIndex = i + 1;
            while (nextIndex < lines.length && !lines[nextIndex].trim()) {
                nextIndex += 1;
            }
            if (nextIndex >= lines.length) continue;

            const baseIndent = this.getIndentLevel(current);
            const nextIndent = this.getIndentLevel(lines[nextIndex]);
            if (nextIndent <= baseIndent) continue;

            let endLine = nextIndex + 1;
            for (let j = nextIndex + 1; j < lines.length; j += 1) {
                const candidate = lines[j];
                if (!candidate.trim()) {
                    endLine = j + 1;
                    continue;
                }

                const candidateIndent = this.getIndentLevel(candidate);
                if (candidateIndent <= baseIndent) break;
                endLine = j + 1;
            }

            if (endLine > (i + 1)) {
                ranges.push({ startLine: i + 1, endLine });
            }
        }

        return ranges;
    }

    getFoldableRanges(text = this.stateStore.getActiveTab()?.content || '') {
        const lines = `${text || ''}`.replaceAll('\r\n', '\n').split('\n');
        const brace = this.computeBraceFoldRanges(lines);
        const indent = this.computeIndentFoldRanges(lines);
        return this.normalizeCollapsedRanges([...brace, ...indent]);
    }

    buildFoldedDisplay(text, collapsed) {
        const lines = `${text || ''}`.replaceAll('\r\n', '\n').split('\n');
        const displayLines = [];
        const lineMap = [];
        const normalized = this.normalizeCollapsedRanges(collapsed);

        let line = 1;
        let rangeIndex = 0;

        while (line <= lines.length) {
            while (rangeIndex < normalized.length && normalized[rangeIndex].startLine < line) {
                rangeIndex += 1;
            }

            const currentRange = normalized[rangeIndex];
            if (currentRange && currentRange.startLine === line) {
                const hiddenCount = Math.max(0, currentRange.endLine - currentRange.startLine);
                const header = lines[line - 1] || '';
                displayLines.push(`${header}  ... [${hiddenCount} lines folded]`);
                lineMap.push(line);
                line = currentRange.endLine + 1;
                rangeIndex += 1;
                continue;
            }

            displayLines.push(lines[line - 1] || '');
            lineMap.push(line);
            line += 1;
        }

        return {
            text: displayLines.join('\n'),
            displayToRawLineMap: lineMap
        };
    }

    toggleFoldAtDisplayLine(displayLine) {
        const activeTab = this.stateStore.getActiveTab();
        if (!activeTab) return false;

        const rawLine = this.toRawLineFromDisplayLine(displayLine);
        const foldState = this.getActiveFoldState();
        if (!foldState) return false;

        const existingIndex = foldState.collapsed.findIndex((range) => range.startLine === rawLine);
        if (existingIndex >= 0) {
            foldState.collapsed.splice(existingIndex, 1);
            foldState.collapsed = this.normalizeCollapsedRanges(foldState.collapsed);
            this.renderActiveTab();
            return true;
        }

        const foldable = this.getFoldableRanges(activeTab.content || '');
        const target = foldable.find((range) => range.startLine === rawLine);
        if (!target) return false;

        foldState.collapsed = this.normalizeCollapsedRanges([
            ...foldState.collapsed.filter((range) => !(target.startLine <= range.startLine && target.endLine >= range.endLine)),
            target
        ]);

        this.renderActiveTab();
        return true;
    }

    unfoldAtDisplayLine(displayLine) {
        const foldState = this.getActiveFoldState();
        if (!foldState || foldState.collapsed.length === 0) return false;

        const rawLine = this.toRawLineFromDisplayLine(displayLine);
        const existingIndex = foldState.collapsed.findIndex((range) => range.startLine === rawLine);
        if (existingIndex === -1) return false;

        foldState.collapsed.splice(existingIndex, 1);
        foldState.collapsed = this.normalizeCollapsedRanges(foldState.collapsed);
        this.renderActiveTab();
        return true;
    }

    unfoldAll() {
        const foldState = this.getActiveFoldState();
        if (!foldState || foldState.collapsed.length === 0) return false;
        foldState.collapsed = [];
        this.renderActiveTab();
        return true;
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
        if (this.isFoldedViewActive()) return '';
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
        const offsets = this.getSelectionOffsets();
        this.recordHistoryBeforeChange(normalizedText, offsets.start, offsets.end, true);
        this.stateStore.updateActiveTabContent(normalizedText);
        this.syncAfterContentMutation(normalizedText, {
            collapsedRanges: [],
            syncHistory: false
        });
    }

    syncAfterContentMutation(nextText, {
        collapsedRanges = [],
        syncHistory = false,
        updateTitle = true
    } = {}) {
        this.refreshFoldMetadata(nextText, collapsedRanges);
        this.updateHighlightMode(nextText.length, this.getMode());
        this.scheduleHighlight();
        this.lineNumbers.updateFromText(this.getDisplayContent());
        this.statusBar.scheduleUpdate();

        if (syncHistory) {
            this.syncHistoryFromCurrentTab();
        }

        if (updateTitle) {
            const activeTab = this.stateStore.getActiveTab();
            if (activeTab) {
                this.onActiveTitleChange(activeTab.title);
            }
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

    applyTextChange(nextText, nextStart, nextEnd = nextStart, options = {}) {
        const shouldRecordHistory = options.recordHistory !== false;
        if (shouldRecordHistory) {
            this.recordHistoryBeforeChange(nextText, nextStart, nextEnd, true);
        }

        this.stateStore.updateActiveTabContent(nextText);

        this.setContent(nextText);
        this.setSelectionOffsets(nextStart, nextEnd);
        this.syncAfterContentMutation(nextText, {
            collapsedRanges: [],
            syncHistory: !shouldRecordHistory,
            updateTitle: true
        });
    }

    updateHighlightMode(contentLength = this.getContent().length, mode = this.getMode()) {
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
        const rawText = activeTab ? (activeTab.content || '') : '';
        const foldState = activeTab ? this.getActiveFoldState() : null;
        if (foldState) {
            foldState.collapsed = this.syncCollapsedWithFoldableRanges(rawText, foldState.collapsed || []);
        }
        const collapsed = foldState?.collapsed || [];
        this.refreshFoldMetadata(rawText, collapsed);

        if (activeTab && collapsed.length > 0) {
            const folded = this.buildFoldedDisplay(rawText, collapsed);
            this.displayToRawLineMap = folded.displayToRawLineMap;
            this.setContent(folded.text);
        } else {
            this.displayToRawLineMap = null;
            this.setContent(rawText);
        }

        this.editor.readOnly = !activeTab || (collapsed.length > 0);
        this.editor.scrollTop = activeTab?.scrollTop || 0;
        this.editor.scrollLeft = 0;
        this.syncAfterContentMutation(rawText, {
            collapsedRanges: collapsed,
            syncHistory: true,
            updateTitle: false
        });
        this.renderHighlight();
        this.syncHighlightScroll();
    }

    getMode() {
        return this.stateStore.getActiveTab()?.mode || 'markdown';
    }

    renderHighlight() {
        if (!this.highlightEnabled) {
            this.highlightLayer.innerHTML = '';
            return;
        }

        const content = this.getDisplayContent();
        this.highlightLayer.innerHTML = highlightText(content, this.getMode());
    }

    scheduleHighlight() {
        const contentLength = this.getDisplayContent().length;
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

    setMode(mode) {
        this.updateHighlightMode(this.getContent().length, mode);
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
            const isFolded = this.isFoldedViewActive();
            if (event.ctrlKey && event.shiftKey && event.code === 'BracketLeft') {
                event.preventDefault();
                const line = this.getLineNumberFromOffset(this.getSelectionOffsets().start, this.getDisplayContent());
                this.toggleFoldAtDisplayLine(line);
                return;
            }

            if (event.ctrlKey && event.shiftKey && event.code === 'BracketRight') {
                event.preventDefault();
                const line = this.getLineNumberFromOffset(this.getSelectionOffsets().start, this.getDisplayContent());
                if (!this.unfoldAtDisplayLine(line)) {
                    this.unfoldAll();
                }
                return;
            }

            if (isFolded) {
                return;
            }

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
                if (event.key === '`' && this.getMode() === 'markdown') {
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
