import { EditorStateStore } from './state.js';
import { LineNumbersManager } from './lineNumbers.js';
import { StatusBarManager } from './statusBar.js';
import { TabsView } from './tabs.js';
import { EditorController } from './editor.js';
import { getDecodeCandidates } from './decoding.js';
import { formatJsonContent, extractJsonChunks } from './jsonFormatting.js';
import { execute as executeJpl } from './jpl.js';
import { highlightText } from './syntaxHighlighter.js';
import { DiffModeController } from './diffMode.js';
import { findTabMatches } from './fuzzySearch.js';
import { escapeHtml } from './utils.js';
import {
    buildSearchRegex,
    getMatches,
    findCurrentMatchIndex,
    nextMatchIndex,
    replaceAtMatch,
    replaceAllMatches
} from './findReplace.js';

const q = (selector) => document.querySelector(selector);
const byId = (id) => document.getElementById(id);

const appLoader = byId('app-loader');

const tabHeaders = q('.tab-headers');
const addTabButton = byId('add-tab');
const editor = byId('tab-editor');
const tabContent = q('.tab-content');
const lineNumbers = byId('line-numbers');
const highlightLayer = byId('editor-highlight');
const editorShell = q('.editor-shell');
const diffModeShell = byId('diff-mode-shell');
const diffContentLeft = byId('diff-content-left');
const diffContentRight = byId('diff-content-right');
const diffLeftLineNumbers = byId('diff-left-line-numbers');
const diffRightLineNumbers = byId('diff-right-line-numbers');
const diffOutput = byId('diff-output');
const filesMenuButton = byId('files-menu-btn');
const decodeMenuButton = byId('decode-menu-btn');
const searchMenuButton = byId('search-menu-btn');
const formatJsonButton = byId('format-json-btn');
const queryButton = byId('query-btn');
const filesSubmenu = byId('files-submenu');
const decodeSubmenu = byId('decode-submenu');
const searchSubmenu = byId('search-submenu');
const searchOpenButton = byId('search-open-btn');
const findReplaceOpenButton = byId('find-replace-open-btn');
const decodeEscapedButton = byId('decode-escaped-btn');
const formatJsonSubmenu = byId('format-json-submenu');
const decodeUrlButton = byId('decode-url-btn');
const decodeUnicodeButton = byId('decode-unicode-btn');
const decodeJwtPayloadButton = byId('decode-jwt-payload-btn');
const decodeJwtHeaderButton = byId('decode-jwt-header-btn');
const formatJsonPrettyButton = byId('format-json-pretty-btn');
const formatJsonMinifiedButton = byId('format-json-minified-btn');
const exportLocalStorageButton = byId('export-localstorage-btn');
const importLocalStorageButton = byId('import-localstorage-btn');
const importLocalStorageInput = byId('import-localstorage-input');
const downloadTabButton = byId('download-tab-btn');
const queryPanel = byId('query-panel');
const searchPanel = byId('search-panel');
const searchPanelClose = byId('search-panel-close');
const searchInput = byId('search-input');
const searchResultMeta = byId('search-result-meta');
const searchResults = byId('search-results');
const queryPanelClose = byId('query-panel-close');
const queryInput = byId('query-input');
const queryRunButton = byId('query-run');
const queryGuideOpenButton = byId('query-guide-open');
const queryGuideBackButton = byId('query-guide-back');
const queryMainView = byId('query-main-view');
const queryGuideView = byId('query-guide-view');
const queryResultMeta = byId('query-result-meta');
const queryResult = byId('query-result');
const queryResultHighlight = byId('query-result-highlight');
const statusPosition = byId('status-position');
const statusLines = byId('status-lines');
const statusChars = byId('status-chars');
const statusMode = byId('status-mode');
const findWidget = byId('find-widget');
const findToggleReplace = byId('find-toggle-replace');
const findInput = byId('find-input');
const replaceInput = byId('replace-input');
const findPrevButton = byId('find-prev');
const findNextButton = byId('find-next');
const findCount = byId('find-count');
const findMatchCase = byId('find-match-case');
const findWholeWord = byId('find-whole-word');
const findUseRegex = byId('find-use-regex');
const findClose = byId('find-close');
const replaceRow = byId('replace-row');
const replaceOne = byId('replace-one');
const replaceAll = byId('replace-all');
const findError = byId('find-error');

const stateStore = new EditorStateStore();

const downloadBlobText = (text, fileName) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};

const sanitizeFileName = (value) => {
    const safe = (value || 'tab-content').replace(/[\\/:*?"<>|]+/g, '-').trim();
    return safe || 'tab-content';
};

const languageToExt = {
    markdown: 'md',
    python: 'py',
    java: 'java',
    yaml: 'yml',
    json: 'json',
    diff: 'diff.txt'
};

const TEXT_MODES = new Set(['markdown', 'json', 'yaml', 'python', 'java']);

const QUERY_PANEL_TRANSITION_MS = 180;
const SEARCH_PANEL_TRANSITION_MS = 180;
const JPL_LIMITS = {
    maxSteps: 3000,
    maxOutputItems: 50000
};

let activeDecodeCandidates = {
    escaped: null,
    url: null,
    unicode: null,
    jwtHeader: null,
    jwtPayload: null,
    hasAny: false
};
let currentSearchMatches = [];
const findState = {
    isOpen: false,
    showReplace: true,
    useRegex: false,
    matchCase: false,
    wholeWord: false,
    matches: [],
    activeIndex: -1,
    lastRegexError: null
};

const setDecodeAction = (button, enabled) => {
    button.hidden = !enabled;
};

const updateDecodeButtonState = () => {
    const mode = stateStore.getActiveTab()?.mode || 'markdown';
    if (!TEXT_MODES.has(mode)) {
        decodeMenuButton.hidden = true;
        decodeMenuButton.disabled = true;
        setDecodeAction(decodeEscapedButton, false);
        setDecodeAction(decodeUrlButton, false);
        setDecodeAction(decodeUnicodeButton, false);
        setDecodeAction(decodeJwtPayloadButton, false);
        setDecodeAction(decodeJwtHeaderButton, false);
        setDecodeMenuOpen(false);
        return;
    }

    const selected = editorController?.getSelectedText() || '';
    if (!selected) {
        decodeMenuButton.hidden = true;
        decodeMenuButton.disabled = true;
        activeDecodeCandidates = {
            escaped: null,
            url: null,
            unicode: null,
            jwtHeader: null,
            jwtPayload: null,
            hasAny: false
        };
        setDecodeAction(decodeEscapedButton, false);
        setDecodeAction(decodeUrlButton, false);
        setDecodeAction(decodeUnicodeButton, false);
        setDecodeAction(decodeJwtPayloadButton, false);
        setDecodeAction(decodeJwtHeaderButton, false);
        setDecodeMenuOpen(false);
        return;
    }

    activeDecodeCandidates = getDecodeCandidates(selected);

    setDecodeAction(decodeEscapedButton, Boolean(activeDecodeCandidates.escaped));
    setDecodeAction(decodeUrlButton, Boolean(activeDecodeCandidates.url));
    setDecodeAction(decodeUnicodeButton, Boolean(activeDecodeCandidates.unicode));
    setDecodeAction(decodeJwtPayloadButton, Boolean(activeDecodeCandidates.jwtPayload));
    setDecodeAction(decodeJwtHeaderButton, Boolean(activeDecodeCandidates.jwtHeader));

    if (!activeDecodeCandidates.hasAny) {
        decodeMenuButton.hidden = true;
        decodeMenuButton.disabled = true;
        setDecodeMenuOpen(false);
        return;
    }

    decodeMenuButton.hidden = false;
    decodeMenuButton.disabled = false;
};

const updateFormatJsonButtonState = () => {
    const mode = stateStore.getActiveTab()?.mode || 'markdown';
    if (mode !== 'json') {
        formatJsonButton.hidden = true;
        formatJsonButton.disabled = true;
        setFormatJsonMenuOpen(false);
        return;
    }

    const content = (editorController?.getContent() || '').trim();
    const hasContent = content.length > 0;
    formatJsonButton.hidden = !hasContent;
    formatJsonButton.disabled = !hasContent;
    if (!hasContent) {
        setFormatJsonMenuOpen(false);
    }
};

const setQueryPanelOpen = (open) => {
    if (!queryPanel) return;
    const isOpen = queryPanel.classList.contains('open') && !queryPanel.hidden;
    if (open === isOpen) return;

    if (open) {
        queryPanel.hidden = false;
        window.requestAnimationFrame(() => {
            queryPanel.classList.add('open');
        });
        queryButton.setAttribute('aria-expanded', 'true');
        return;
    }

    queryPanel.classList.remove('open');
    queryButton.setAttribute('aria-expanded', 'false');
    window.setTimeout(() => {
        if (queryButton.getAttribute('aria-expanded') === 'false') {
            queryPanel.hidden = true;
        }
    }, QUERY_PANEL_TRANSITION_MS);
};

const setQueryGuideMode = (openGuide) => {
    queryMainView.hidden = openGuide;
    queryGuideView.hidden = !openGuide;
};

const setSearchPanelOpen = (open) => {
    if (!searchPanel) return;
    const isOpen = searchPanel.classList.contains('open') && !searchPanel.hidden;
    if (open === isOpen) return;

    if (open) {
        searchPanel.hidden = false;
        window.requestAnimationFrame(() => {
            searchPanel.classList.add('open');
            try {
                searchInput.focus({ preventScroll: true });
            } catch {
                searchInput.focus();
            }
            if (searchInput.value.length > 0) {
                searchInput.select();
            }
        });
        searchMenuButton.setAttribute('aria-expanded', 'true');
        return;
    }

    searchPanel.classList.remove('open');
    searchMenuButton.setAttribute('aria-expanded', 'false');
    window.setTimeout(() => {
        if (searchMenuButton.getAttribute('aria-expanded') === 'false') {
            searchPanel.hidden = true;
        }
    }, SEARCH_PANEL_TRANSITION_MS);
};

const getActiveCodeTab = () => {
    const tab = stateStore.getActiveTab();
    if (!tab) return null;
    if ((tab.mode || 'markdown') === 'diff') return null;
    return tab;
};

const setFindWidgetOpen = (open, { withReplace = false } = {}) => {
    findState.isOpen = Boolean(open);
    if (!findState.isOpen) {
        findWidget.hidden = true;
        return;
    }

    const tab = getActiveCodeTab();
    if (!tab) {
        findWidget.hidden = true;
        findState.isOpen = false;
        return;
    }

    if (editorController.isFoldedViewActive()) {
        editorController.unfoldAll();
    }

    if (withReplace) {
        findState.showReplace = true;
    }

    replaceRow.hidden = !findState.showReplace;
    findToggleReplace.setAttribute('aria-expanded', String(findState.showReplace));
    findToggleReplace.textContent = findState.showReplace ? 'v' : '>';
    findWidget.hidden = false;

    try {
        findInput.focus({ preventScroll: true });
    } catch {
        findInput.focus();
    }

    const selected = editorController.getSelectedText();
    if (selected && !findInput.value) {
        findInput.value = selected;
    }
};

const updateFindToggleButtons = () => {
    findMatchCase.setAttribute('aria-pressed', String(findState.matchCase));
    findWholeWord.setAttribute('aria-pressed', String(findState.wholeWord));
    findUseRegex.setAttribute('aria-pressed', String(findState.useRegex));
};

const updateFindMatchState = ({ keepSelection = true } = {}) => {
    if (!findState.isOpen) return;
    const tab = getActiveCodeTab();
    if (!tab) {
        findState.matches = [];
        findState.activeIndex = -1;
        findCount.textContent = '0 / 0';
        return;
    }

    if (editorController.isFoldedViewActive()) {
        editorController.unfoldAll();
    }

    const query = findInput.value || '';
    const { regex, error } = buildSearchRegex(query, {
        useRegex: findState.useRegex,
        matchCase: findState.matchCase,
        wholeWord: findState.wholeWord
    });

    findState.lastRegexError = error;
    findError.hidden = !error;
    if (error) {
        findState.matches = [];
        findState.activeIndex = -1;
        findCount.textContent = '0 / 0';
        return;
    }

    const text = editorController.getContent();
    findState.matches = getMatches(text, regex);

    if (findState.matches.length === 0) {
        findState.activeIndex = -1;
        findCount.textContent = '0 / 0';
        return;
    }

    if (keepSelection) {
        const { start, end } = editorController.getSelectionOffsets();
        findState.activeIndex = findCurrentMatchIndex(findState.matches, start, end);
    } else if (findState.activeIndex >= findState.matches.length || findState.activeIndex < 0) {
        findState.activeIndex = 0;
    }

    const activeNumber = findState.activeIndex >= 0 ? (findState.activeIndex + 1) : 0;
    findCount.textContent = `${activeNumber} / ${findState.matches.length}`;
};

const selectFindMatch = (index) => {
    if (index < 0 || index >= findState.matches.length) return;

    const match = findState.matches[index];
    findState.activeIndex = index;
    editorController.setSelectionOffsets(match.start, match.end);

    const lineNumber = Math.max(1, (editorController.getContent().slice(0, match.start).match(/\n/g)?.length || 0) + 1);
    const lineHeight = parseFloat(window.getComputedStyle(editor).lineHeight) || 19;
    const targetTop = Math.max(0, (lineNumber - 1) * lineHeight - (editor.clientHeight * 0.35));
    editor.scrollTop = targetTop;
    lineNumbersManager.scheduleRenderViewport();
    statusBarManager.scheduleUpdate();
    findCount.textContent = `${index + 1} / ${findState.matches.length}`;
};

const moveFindMatch = (direction) => {
    updateFindMatchState({ keepSelection: true });
    if (findState.matches.length === 0) return;

    const nextIndex = nextMatchIndex(findState.matches, findState.activeIndex, direction);
    selectFindMatch(nextIndex);
};

const applyReplaceOne = () => {
    updateFindMatchState({ keepSelection: true });
    if (findState.matches.length === 0 || findState.activeIndex < 0) return;

    const text = editorController.getContent();
    const match = findState.matches[findState.activeIndex];
    const replaced = replaceAtMatch(text, match, replaceInput.value || '', {
        useRegex: findState.useRegex,
        matchCase: findState.matchCase,
        wholeWord: findState.wholeWord,
        query: findInput.value || ''
    });

    if (!replaced.changed) return;

    editorController.applyTextChange(replaced.text, replaced.nextSelectionStart, replaced.nextSelectionEnd);
    updateFindMatchState({ keepSelection: true });
};

const applyReplaceAll = () => {
    if (editorController.isFoldedViewActive()) {
        editorController.unfoldAll();
    }

    const query = findInput.value || '';
    const { regex, error } = buildSearchRegex(query, {
        useRegex: findState.useRegex,
        matchCase: findState.matchCase,
        wholeWord: findState.wholeWord
    });

    findState.lastRegexError = error;
    findError.hidden = !error;
    if (error || !regex) return;

    const text = editorController.getContent();
    const replaced = replaceAllMatches(text, regex, replaceInput.value || '');
    if (!replaced.changed) {
        updateFindMatchState({ keepSelection: true });
        return;
    }

    editorController.applyTextChange(replaced.text, 0, 0);
    updateFindMatchState({ keepSelection: false });
};

const updateQueryButtonState = () => {
    const mode = stateStore.getActiveTab()?.mode || 'markdown';
    const content = (editorController?.getContent() || '').trim();
    const canQuery = mode === 'json' && content.length > 0;

    if (!canQuery) {
        queryButton.hidden = true;
        queryButton.disabled = true;
        setQueryPanelOpen(false);
        return;
    }

    queryButton.hidden = false;
    queryButton.disabled = false;
};

const refreshEditorDependentUiState = ({
    refreshFind = true,
    refreshSearch = false
} = {}) => {
    updateDecodeButtonState();
    updateFormatJsonButtonState();
    updateQueryButtonState();

    if (refreshFind && findState.isOpen) {
        updateFindMatchState({ keepSelection: true });
    }

    if (refreshSearch && !searchPanel.hidden) {
        runSearch();
    }
};

const prettyPrint = (value) => JSON.stringify(value, null, 2);

const setQueryResultText = (text) => {
    const resultText = `${text || ''}`;
    queryResult.value = resultText;
    queryResultHighlight.innerHTML = highlightText(resultText, 'json');
};

const syncQueryResultScroll = () => {
    queryResultHighlight.style.transform = `translate(${-queryResult.scrollLeft}px, ${-queryResult.scrollTop}px)`;
};

const runQueryOnWholeJson = (queryText, rawText) => {
    try {
        const parsed = JSON.parse(rawText);
        const result = executeJpl(queryText, parsed, JPL_LIMITS);
        if (!result.ok) {
            return {
                ok: false,
                mode: 'whole',
                error: result.error,
                warnings: result.warnings || []
            };
        }

        return {
            ok: true,
            mode: 'whole',
            value: result.value,
            warnings: result.warnings || []
        };
    } catch {
        return null;
    }
};

const runQueryOnJsonChunks = (queryText, rawText) => {
    const chunks = extractJsonChunks(rawText);
    if (chunks.length === 0) {
        return {
            ok: false,
            mode: 'chunks',
            error: { message: 'No valid JSON chunks found in current content.' },
            warnings: []
        };
    }

    const chunkResults = [];
    let okCount = 0;

    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const parsed = JSON.parse(chunk.text);
        const result = executeJpl(queryText, parsed, JPL_LIMITS);
        if (result.ok) {
            okCount += 1;
            chunkResults.push({
                chunk: i + 1,
                start: chunk.start,
                ok: true,
                value: result.value,
                warnings: result.warnings || []
            });
        } else {
            chunkResults.push({
                chunk: i + 1,
                start: chunk.start,
                ok: false,
                error: result.error,
                warnings: result.warnings || []
            });
        }
    }

    return {
        ok: okCount > 0,
        mode: 'chunks',
        value: {
            chunksProcessed: chunks.length,
            chunksSucceeded: okCount,
            chunksFailed: chunks.length - okCount,
            results: chunkResults
        },
        warnings: []
    };
};

const runQuery = () => {
    const queryText = (queryInput.value || '').trim();
    if (!queryText) {
        queryResultMeta.textContent = 'Query is empty';
        setQueryResultText('Type a JPL query and run it.');
        return;
    }

    const rawText = editorController.getContent();
    if (!rawText.trim()) {
        queryResultMeta.textContent = 'No JSON content';
        setQueryResultText('Current tab is empty.');
        return;
    }

    const whole = runQueryOnWholeJson(queryText, rawText);
    const output = whole || runQueryOnJsonChunks(queryText, rawText);

    if (!output.ok) {
        queryResultMeta.textContent = `Query failed (${output.mode})`;
        setQueryResultText(`${prettyPrint({
            error: output.error,
            warnings: output.warnings || []
        })}\n`);
        return;
    }

    const warningsCount = (output.warnings || []).length;
    queryResultMeta.textContent = output.mode === 'whole'
        ? `Query success (whole JSON)${warningsCount ? `, warnings: ${warningsCount}` : ''}`
        : `Query success (chunked JSON)`;

    setQueryResultText(`${prettyPrint(output.value)}\n`);
};

const setFilesMenuOpen = (open) => {
    filesSubmenu.hidden = !open;
    filesMenuButton.setAttribute('aria-expanded', String(open));
};

const setDecodeMenuOpen = (open) => {
    decodeSubmenu.hidden = !open;
    decodeMenuButton.setAttribute('aria-expanded', String(open));
};

const setSearchMenuOpen = (open) => {
    searchSubmenu.hidden = !open;
    searchMenuButton.setAttribute('aria-expanded', String(open));
};

const setFormatJsonMenuOpen = (open) => {
    formatJsonSubmenu.hidden = !open;
    formatJsonButton.setAttribute('aria-expanded', String(open));
};

const closeTransientUi = ({
    keepFilesMenu = false,
    keepDecodeMenu = false,
    keepSearchMenu = false,
    keepFormatMenu = false,
    keepQueryPanel = false,
    keepSearchPanel = false,
    keepFindWidget = false
} = {}) => {
    if (!keepFilesMenu) setFilesMenuOpen(false);
    if (!keepDecodeMenu) setDecodeMenuOpen(false);
    if (!keepSearchMenu) setSearchMenuOpen(false);
    if (!keepFormatMenu) setFormatJsonMenuOpen(false);
    if (!keepQueryPanel) setQueryPanelOpen(false);
    if (!keepSearchPanel) setSearchPanelOpen(false);
    if (!keepFindWidget) setFindWidgetOpen(false);
};

const openFindWidget = (withReplace) => {
    closeTransientUi();
    setFindWidgetOpen(true, { withReplace });
    updateFindMatchState({ keepSelection: true });
};

setFilesMenuOpen(false);
setDecodeMenuOpen(false);
setSearchMenuOpen(false);
setFormatJsonMenuOpen(false);
setQueryPanelOpen(false);
setSearchPanelOpen(false);
setQueryGuideMode(false);
updateFindToggleButtons();

const lineNumbersManager = new LineNumbersManager(editor, lineNumbers, 24);

let editorController = null;
let statusBarManager = null;
let tabsView = null;
let diffModeController = null;
let lastSelectionRange = null;

const captureEditorSelection = () => {
    if (!editorController) return;

    const { start, end } = editorController.getSelectionOffsets();
    if (start === end) return;

    const selectedText = editorController.getSelectedText();
    if (!selectedText) return;

    lastSelectionRange = { start, end };
};

const runSearch = () => {
    const query = (searchInput.value || '').trim();
    if (!query) {
        currentSearchMatches = [];
        searchResultMeta.textContent = 'Type to search';
        searchResults.innerHTML = '';
        return;
    }

    currentSearchMatches = findTabMatches(stateStore.getTabs(), query, 150);

    if (currentSearchMatches.length === 0) {
        searchResultMeta.textContent = 'No matches';
        searchResults.innerHTML = '';
        return;
    }

    searchResultMeta.textContent = `${currentSearchMatches.length} matches`;
    searchResults.innerHTML = currentSearchMatches.map((match, index) => (
        `<button class="search-result-item" type="button" data-match-index="${index}">`
        + `<span class="search-result-meta">${escapeHtml(match.tabTitle)} - Ln ${match.lineNumber} (${match.mode})</span>`
        + `<span class="search-result-snippet">${escapeHtml(match.snippet)}</span>`
        + '</button>'
    )).join('');
};

const jumpToSearchMatch = (match) => {
    if (!match) return;

    stateStore.setActiveTab(match.tabId);
    render();

    if (stateStore.getActiveTab()?.mode === 'diff') return;

    if (editorController.isFoldedViewActive()) {
        editorController.unfoldAll();
    }

    const nextStart = Math.max(0, match.offset || 0);
    const nextEnd = Math.max(nextStart + 1, nextStart + (match.length || 1));
    editorController.setSelectionOffsets(nextStart, nextEnd);

    const lineHeight = parseFloat(window.getComputedStyle(editor).lineHeight) || 19;
    const targetTop = Math.max(0, (Math.max(1, match.lineNumber) - 1) * lineHeight - (editor.clientHeight * 0.35));
    editor.scrollTop = targetTop;
    lineNumbersManager.scheduleRenderViewport();
    statusBarManager.scheduleUpdate();
};

const render = () => {
    const activeTab = stateStore.getActiveTab();
    const mode = activeTab?.mode || 'markdown';
    const isDiffMode = mode === 'diff';

    tabsView.render(stateStore.getTabs(), stateStore.getActiveTabId());
    editorShell.hidden = false;
    diffModeShell.hidden = false;
    tabContent.dataset.mode = mode;
    editorShell.setAttribute('aria-hidden', String(isDiffMode));
    diffModeShell.setAttribute('aria-hidden', String(!isDiffMode));

    if (isDiffMode) {
        diffModeController.renderTab(activeTab);
    } else {
        editorController.renderActiveTab();
    }

    if (statusMode.value !== mode) {
        statusMode.value = mode;
    }

    if (isDiffMode) {
        statusPosition.textContent = 'Diff mode';
    } else {
        statusBarManager.scheduleUpdate();
    }

    refreshEditorDependentUiState({
        refreshFind: !isDiffMode,
        refreshSearch: true
    });

    if (isDiffMode) {
        setFindWidgetOpen(false);
    } else if (findState.isOpen) {
        setFindWidgetOpen(true);
    }
};

statusBarManager = new StatusBarManager({
    statusPosition,
    statusLines,
    statusChars,
    getText: () => editorController.getContent(),
    getSelectionOffsets: () => editorController.getSelectionOffsets(),
    getTotalLines: () => lineNumbersManager.getTotalLineCount()
});

tabsView = new TabsView({
    tabHeaders,
    addTabButton,
    onAdd: () => {
        stateStore.addTab();
        render();
    },
    onSelect: (tabId) => {
        stateStore.setActiveTab(tabId);
        render();
    },
    onClose: (tabId) => {
        stateStore.closeTab(tabId);
        render();
    }
});

editorController = new EditorController({
    editor,
    highlightLayer,
    stateStore,
    lineNumbers: lineNumbersManager,
    statusBar: statusBarManager,
    onActiveTitleChange: (title) => tabsView.updateActiveTabTitle(title)
});

lineNumbersManager.setLineNumberClickHandler((line) => {
    editorController.toggleFoldAtDisplayLine(line);
});

lineNumbersManager.setFoldIndicatorResolver((line) => editorController.getFoldIndicatorForDisplayLine(line));
lineNumbersManager.setLineLabelResolver((line) => editorController.getLineLabelForDisplayLine(line));

diffModeController = new DiffModeController({
    leftEditor: diffContentLeft,
    rightEditor: diffContentRight,
    leftLineNumbers: diffLeftLineNumbers,
    rightLineNumbers: diffRightLineNumbers,
    outputElement: diffOutput,
    onLeftInput: (value) => stateStore.updateActiveTabDiffContent('left', value),
    onRightInput: (value) => stateStore.updateActiveTabDiffContent('right', value),
    onSummaryChange: (summary) => {
        const mode = stateStore.getActiveTab()?.mode || 'markdown';
        if (mode !== 'diff') return;

        statusPosition.textContent = 'Diff mode';
        statusLines.textContent = `+${summary.added} -${summary.removed}`;
        statusChars.textContent = 'Ready';
    }
});

refreshEditorDependentUiState();

statusMode.addEventListener('change', () => {
    stateStore.updateActiveTabMode(statusMode.value);
    editorController.setMode(statusMode.value);
    render();
});

filesMenuButton.addEventListener('click', () => {
    captureEditorSelection();
    const isOpen = filesMenuButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        closeTransientUi({ keepFilesMenu: true });
    }
    setFilesMenuOpen(!isOpen);
});

decodeMenuButton.addEventListener('click', () => {
    if (decodeMenuButton.hidden) return;

    captureEditorSelection();
    const isOpen = decodeMenuButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        closeTransientUi({ keepDecodeMenu: true });
    }
    setDecodeMenuOpen(!isOpen);
});

searchMenuButton.addEventListener('click', () => {
    const isOpen = searchMenuButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        closeTransientUi({ keepSearchMenu: true, keepSearchPanel: true });
    }
    setSearchMenuOpen(!isOpen);
});

searchOpenButton.addEventListener('click', () => {
    setSearchMenuOpen(false);
    closeTransientUi({ keepSearchPanel: true });
    setSearchPanelOpen(true);
    runSearch();
});

findReplaceOpenButton.addEventListener('click', () => {
    setSearchMenuOpen(false);
    openFindWidget(true);
});

searchPanelClose.addEventListener('click', () => {
    setSearchPanelOpen(false);
});

searchInput.addEventListener('input', () => {
    runSearch();
});

searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && currentSearchMatches.length > 0) {
        event.preventDefault();
        jumpToSearchMatch(currentSearchMatches[0]);
    }
});

searchResults.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.search-result-item');
    if (!button) return;

    const indexRaw = button.getAttribute('data-match-index');
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0 || index >= currentSearchMatches.length) return;
    jumpToSearchMatch(currentSearchMatches[index]);
});

findToggleReplace.addEventListener('click', () => {
    findState.showReplace = !findState.showReplace;
    replaceRow.hidden = !findState.showReplace;
    findToggleReplace.setAttribute('aria-expanded', String(findState.showReplace));
    findToggleReplace.textContent = findState.showReplace ? 'v' : '>';
});

findClose.addEventListener('click', () => {
    setFindWidgetOpen(false);
});

findInput.addEventListener('input', () => {
    updateFindMatchState({ keepSelection: false });
});

findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        moveFindMatch(event.shiftKey ? -1 : 1);
    }
});

replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        applyReplaceOne();
    }
});

findPrevButton.addEventListener('click', () => {
    moveFindMatch(-1);
});

findNextButton.addEventListener('click', () => {
    moveFindMatch(1);
});

findMatchCase.addEventListener('click', () => {
    findState.matchCase = !findState.matchCase;
    updateFindToggleButtons();
    updateFindMatchState({ keepSelection: false });
});

findWholeWord.addEventListener('click', () => {
    findState.wholeWord = !findState.wholeWord;
    updateFindToggleButtons();
    updateFindMatchState({ keepSelection: false });
});

findUseRegex.addEventListener('click', () => {
    findState.useRegex = !findState.useRegex;
    updateFindToggleButtons();
    updateFindMatchState({ keepSelection: false });
});

replaceOne.addEventListener('click', () => {
    applyReplaceOne();
});

replaceAll.addEventListener('click', () => {
    applyReplaceAll();
});

editor.addEventListener('input', () => {
    if (!findState.isOpen) return;
    updateFindMatchState({ keepSelection: true });
});

formatJsonButton.addEventListener('click', () => {
    if (formatJsonButton.hidden || formatJsonButton.disabled) return;

    const isOpen = formatJsonButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        closeTransientUi({ keepFormatMenu: true });
    }
    setFormatJsonMenuOpen(!isOpen);
});

queryButton.addEventListener('click', () => {
    if (queryButton.hidden || queryButton.disabled) return;

    const isOpen = queryButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        closeTransientUi({ keepQueryPanel: true });
    }
    if (!isOpen) {
        setQueryGuideMode(false);
    }
    setQueryPanelOpen(!isOpen);
});

queryPanelClose.addEventListener('click', () => {
    setQueryPanelOpen(false);
    setQueryGuideMode(false);
});

queryGuideOpenButton.addEventListener('click', () => {
    setQueryGuideMode(true);
});

queryGuideBackButton.addEventListener('click', () => {
    setQueryGuideMode(false);
});

queryRunButton.addEventListener('click', () => {
    runQuery();
});

queryInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runQuery();
    }
});

queryResult.addEventListener('scroll', syncQueryResultScroll);

exportLocalStorageButton.addEventListener('click', () => {
    const snapshot = {};
    for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        snapshot[key] = localStorage.getItem(key);
    }

    downloadBlobText(JSON.stringify(snapshot, null, 2), 'scratchpad-localstorage.json');
    setFilesMenuOpen(false);
});

importLocalStorageButton.addEventListener('click', () => {
    importLocalStorageInput.value = '';
    importLocalStorageInput.click();
});

importLocalStorageInput.addEventListener('change', async () => {
    const file = importLocalStorageInput.files?.[0];
    if (!file) return;

    try {
        const raw = await file.text();
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Invalid localStorage format');
        }

        localStorage.clear();
        Object.entries(parsed).forEach(([key, value]) => {
            localStorage.setItem(key, String(value ?? ''));
        });

        stateStore.reloadFromStorage();
        render();
        setFilesMenuOpen(false);
    } catch {
        window.alert('Could not import localstorage JSON file.');
    }
});

downloadTabButton.addEventListener('click', () => {
    const activeTab = stateStore.getActiveTab();
    if (!activeTab) return;

    const ext = languageToExt[activeTab.mode] || 'txt';
    const title = sanitizeFileName(activeTab.title);
    const isDiffMode = activeTab.mode === 'diff';
    const text = isDiffMode ? diffModeController.getExportText() : (activeTab.content || '');
    const fileName = isDiffMode ? `${title}.${ext}` : `${title}.${ext}`;
    downloadBlobText(text, fileName);
    setFilesMenuOpen(false);
});

const applyDecodedSelection = (decoded) => {
    if (!decoded) return;

    const selection = editorController.getSelectionOffsets();
    if (selection.start === selection.end && lastSelectionRange) {
        editorController.setSelectionOffsets(lastSelectionRange.start, lastSelectionRange.end);
    }

    editorController.replaceSelectionText(decoded);
    lastSelectionRange = null;
    refreshEditorDependentUiState();
    setDecodeMenuOpen(false);
};

const registerDecodeAction = (button, candidateKey) => {
    button.addEventListener('click', () => {
        applyDecodedSelection(activeDecodeCandidates[candidateKey] || '');
    });
};

registerDecodeAction(decodeUrlButton, 'url');
registerDecodeAction(decodeEscapedButton, 'escaped');
registerDecodeAction(decodeUnicodeButton, 'unicode');
registerDecodeAction(decodeJwtPayloadButton, 'jwtPayload');
registerDecodeAction(decodeJwtHeaderButton, 'jwtHeader');

const applyJsonFormattingMode = (mode) => {
    const rawText = editorController.getContent();
    const result = formatJsonContent(rawText, mode);
    if (!result.changed) {
        window.alert('No valid JSON chunks found to format.');
        setFormatJsonMenuOpen(false);
        return;
    }

    const { start, end } = editorController.getSelectionOffsets();
    const nextStart = Math.min(start, result.output.length);
    const nextEnd = Math.min(end, result.output.length);
    editorController.applyTextChange(result.output, nextStart, nextEnd);
    refreshEditorDependentUiState();
    setFormatJsonMenuOpen(false);
};

formatJsonPrettyButton.addEventListener('click', () => {
    applyJsonFormattingMode('pretty');
});

formatJsonMinifiedButton.addEventListener('click', () => {
    applyJsonFormattingMode('minified');
});

const refreshDecodeState = () => {
    if ((stateStore.getActiveTab()?.mode || 'markdown') === 'diff') {
        refreshEditorDependentUiState({ refreshFind: false });
        return;
    }

    captureEditorSelection();
    refreshEditorDependentUiState();
};

editor.addEventListener('select', refreshDecodeState);
editor.addEventListener('keyup', refreshDecodeState);
editor.addEventListener('mouseup', refreshDecodeState);

document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('.left-panel')) return;
    closeTransientUi({ keepQueryPanel: true, keepSearchPanel: true, keepFindWidget: true });
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeTransientUi();
    }
});

window.addEventListener('keydown', (event) => {
    const activeElement = document.activeElement;
    const isMainEditorFocused = activeElement === editor;

    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openFindWidget(false);
        return;
    }

    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        openFindWidget(true);
        return;
    }

    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
        if (!isMainEditorFocused) return;
        event.preventDefault();
        editorController.undo();
        refreshEditorDependentUiState({ refreshFind: true, refreshSearch: true });
        return;
    }

    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'y') {
        if (!isMainEditorFocused) return;
        event.preventDefault();
        editorController.redo();
        refreshEditorDependentUiState({ refreshFind: true, refreshSearch: true });
        return;
    }

    if (event.ctrlKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        stateStore.addTab();
        render();
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        const activeTab = stateStore.getActiveTab();
        if (!activeTab) return;

        stateStore.closeTab(activeTab.id);
        render();
    }
});

window.addEventListener('storage', (event) => {
    if (event.key !== 'scratchpad.tabs.v2') return;
    stateStore.reloadFromStorage();
    render();
});

window.addEventListener('resize', () => {
    lineNumbersManager.scheduleRenderViewport();
    statusBarManager.scheduleUpdate();
});

window.addEventListener('beforeunload', () => {
    stateStore.flushSave();
});

stateStore.saveImmediate();
render();

const hideAppLoader = () => {
    if (!appLoader) return;
    appLoader.classList.add('is-hidden');
};

if (document.readyState === 'complete') {
    hideAppLoader();
} else {
    window.addEventListener('load', hideAppLoader, { once: true });
}


