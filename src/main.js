import { EditorStateStore } from './state.js';
import { LineNumbersManager } from './lineNumbers.js';
import { StatusBarManager } from './statusBar.js';
import { TabsView } from './tabs.js';
import { EditorController } from './editor.js';
import { getDecodeCandidates } from './decoding.js';
import { formatJsonContent, extractJsonChunks } from './jsonFormatting.js';
import { execute as executeJpl } from './jpl.js';
import { highlightText } from './syntaxHighlighter.js';

const q = (selector) => document.querySelector(selector);
const byId = (id) => document.getElementById(id);

const appLoader = byId('app-loader');

const tabHeaders = q('.tab-headers');
const addTabButton = byId('add-tab');
const editor = byId('tab-editor');
const lineNumbers = byId('line-numbers');
const highlightLayer = byId('editor-highlight');
const filesMenuButton = byId('files-menu-btn');
const decodeMenuButton = byId('decode-menu-btn');
const formatJsonButton = byId('format-json-btn');
const queryButton = byId('query-btn');
const filesSubmenu = byId('files-submenu');
const decodeSubmenu = byId('decode-submenu');
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
const statusLanguage = byId('status-language');

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
    json: 'json'
};

const QUERY_PANEL_TRANSITION_MS = 180;
const JPL_LIMITS = {
    maxSteps: 3000,
    maxOutputItems: 50000
};

let activeDecodeCandidates = {
    url: null,
    unicode: null,
    jwtHeader: null,
    jwtPayload: null,
    hasAny: false
};

const setDecodeAction = (button, enabled) => {
    button.hidden = !enabled;
};

const updateDecodeButtonState = () => {
    const selected = editorController?.getSelectedText() || '';
    if (!selected) {
        decodeMenuButton.hidden = true;
        decodeMenuButton.disabled = true;
        activeDecodeCandidates = {
            url: null,
            unicode: null,
            jwtHeader: null,
            jwtPayload: null,
            hasAny: false
        };
        setDecodeAction(decodeUrlButton, false);
        setDecodeAction(decodeUnicodeButton, false);
        setDecodeAction(decodeJwtPayloadButton, false);
        setDecodeAction(decodeJwtHeaderButton, false);
        setDecodeMenuOpen(false);
        return;
    }

    activeDecodeCandidates = getDecodeCandidates(selected);

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
    const language = stateStore.getActiveTab()?.language || 'markdown';
    if (language !== 'json') {
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

const updateQueryButtonState = () => {
    const language = stateStore.getActiveTab()?.language || 'markdown';
    const content = (editorController?.getContent() || '').trim();
    const canQuery = language === 'json' && content.length > 0;

    if (!canQuery) {
        queryButton.hidden = true;
        queryButton.disabled = true;
        setQueryPanelOpen(false);
        return;
    }

    queryButton.hidden = false;
    queryButton.disabled = false;
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

const setFormatJsonMenuOpen = (open) => {
    formatJsonSubmenu.hidden = !open;
    formatJsonButton.setAttribute('aria-expanded', String(open));
};

setFilesMenuOpen(false);
setDecodeMenuOpen(false);
setFormatJsonMenuOpen(false);
setQueryPanelOpen(false);
setQueryGuideMode(false);

const lineNumbersManager = new LineNumbersManager(editor, lineNumbers, 24);

let editorController = null;
let statusBarManager = null;
let tabsView = null;
let lastSelectionRange = null;
const decodeUndoStack = [];
const decodeRedoStack = [];

const captureEditorSnapshot = () => {
    const { start, end } = editorController.getSelectionOffsets();
    return {
        text: editorController.getContent(),
        start,
        end
    };
};

const applyEditorSnapshot = (snapshot) => {
    editorController.applyTextChange(snapshot.text, snapshot.start, snapshot.end);
};

const pushDecodeHistory = (before, after) => {
    if (before.text === after.text && before.start === after.start && before.end === after.end) {
        return;
    }

    decodeUndoStack.push({ before, after });
    decodeRedoStack.length = 0;
};

const undoDecodeStep = () => {
    const operation = decodeUndoStack.pop();
    if (!operation) return false;

    const current = captureEditorSnapshot();
    if (current.text !== operation.after.text) {
        decodeUndoStack.push(operation);
        return false;
    }

    applyEditorSnapshot(operation.before);
    decodeRedoStack.push(operation);
    return true;
};

const canUndoDecodeStep = () => {
    const operation = decodeUndoStack[decodeUndoStack.length - 1];
    if (!operation) return false;
    return captureEditorSnapshot().text === operation.after.text;
};

const redoDecodeStep = () => {
    const operation = decodeRedoStack.pop();
    if (!operation) return false;

    const current = captureEditorSnapshot();
    if (current.text !== operation.before.text) {
        decodeRedoStack.push(operation);
        return false;
    }

    applyEditorSnapshot(operation.after);
    decodeUndoStack.push(operation);
    return true;
};

const canRedoDecodeStep = () => {
    const operation = decodeRedoStack[decodeRedoStack.length - 1];
    if (!operation) return false;
    return captureEditorSnapshot().text === operation.before.text;
};

const captureEditorSelection = () => {
    if (!editorController) return;

    const { start, end } = editorController.getSelectionOffsets();
    if (start === end) return;

    const selectedText = editorController.getSelectedText();
    if (!selectedText) return;

    lastSelectionRange = { start, end };
};

const render = () => {
    tabsView.render(stateStore.getTabs(), stateStore.getActiveTabId());
    editorController.renderActiveTab();

    const language = stateStore.getActiveTab()?.language || 'markdown';
    if (statusLanguage.value !== language) {
        statusLanguage.value = language;
    }

    updateDecodeButtonState();
    updateFormatJsonButtonState();
    updateQueryButtonState();
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

updateDecodeButtonState();
updateFormatJsonButtonState();
updateQueryButtonState();

statusLanguage.addEventListener('change', () => {
    editorController.setLanguage(statusLanguage.value);
    updateFormatJsonButtonState();
    updateQueryButtonState();
});

filesMenuButton.addEventListener('click', () => {
    captureEditorSelection();
    const isOpen = filesMenuButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        setDecodeMenuOpen(false);
        setFormatJsonMenuOpen(false);
        setQueryPanelOpen(false);
    }
    setFilesMenuOpen(!isOpen);
});

decodeMenuButton.addEventListener('click', () => {
    if (decodeMenuButton.hidden) return;

    captureEditorSelection();
    const isOpen = decodeMenuButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        setFilesMenuOpen(false);
        setFormatJsonMenuOpen(false);
        setQueryPanelOpen(false);
    }
    setDecodeMenuOpen(!isOpen);
});

formatJsonButton.addEventListener('click', () => {
    if (formatJsonButton.hidden || formatJsonButton.disabled) return;

    const isOpen = formatJsonButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        setFilesMenuOpen(false);
        setDecodeMenuOpen(false);
        setQueryPanelOpen(false);
    }
    setFormatJsonMenuOpen(!isOpen);
});

queryButton.addEventListener('click', () => {
    if (queryButton.hidden || queryButton.disabled) return;

    const isOpen = queryButton.getAttribute('aria-expanded') === 'true';
    if (!isOpen) {
        setFilesMenuOpen(false);
        setDecodeMenuOpen(false);
        setFormatJsonMenuOpen(false);
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

    const ext = languageToExt[activeTab.language] || 'txt';
    const title = sanitizeFileName(activeTab.title);
    downloadBlobText(activeTab.content || '', `${title}.${ext}`);
    setFilesMenuOpen(false);
});

const applyDecodedSelection = (decoded) => {
    if (!decoded) return;

    const beforeSnapshot = captureEditorSnapshot();

    const selection = editorController.getSelectionOffsets();
    if (selection.start === selection.end && lastSelectionRange) {
        editorController.setSelectionOffsets(lastSelectionRange.start, lastSelectionRange.end);
    }

    editorController.replaceSelectionText(decoded);
    const afterSnapshot = captureEditorSnapshot();
    pushDecodeHistory(beforeSnapshot, afterSnapshot);
    lastSelectionRange = null;
    updateDecodeButtonState();
    setDecodeMenuOpen(false);
};

decodeUrlButton.addEventListener('click', () => {
    applyDecodedSelection(activeDecodeCandidates.url || '');
});

decodeUnicodeButton.addEventListener('click', () => {
    applyDecodedSelection(activeDecodeCandidates.unicode || '');
});

decodeJwtPayloadButton.addEventListener('click', () => {
    applyDecodedSelection(activeDecodeCandidates.jwtPayload || '');
});

decodeJwtHeaderButton.addEventListener('click', () => {
    applyDecodedSelection(activeDecodeCandidates.jwtHeader || '');
});

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
    updateFormatJsonButtonState();
    setFormatJsonMenuOpen(false);
};

formatJsonPrettyButton.addEventListener('click', () => {
    applyJsonFormattingMode('pretty');
});

formatJsonMinifiedButton.addEventListener('click', () => {
    applyJsonFormattingMode('minified');
});

const refreshDecodeState = () => {
    captureEditorSelection();
    updateDecodeButtonState();
    updateFormatJsonButtonState();
    updateQueryButtonState();
};

editor.addEventListener('select', refreshDecodeState);
editor.addEventListener('keyup', refreshDecodeState);
editor.addEventListener('mouseup', refreshDecodeState);

document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('.left-panel')) return;
    setFilesMenuOpen(false);
    setDecodeMenuOpen(false);
    setFormatJsonMenuOpen(false);
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        setFilesMenuOpen(false);
        setDecodeMenuOpen(false);
        setFormatJsonMenuOpen(false);
        setQueryPanelOpen(false);
    }
});

window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
        if (!canUndoDecodeStep()) return;
        event.preventDefault();
        undoDecodeStep();
        updateDecodeButtonState();
        return;
    }

    if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'y') {
        if (!canRedoDecodeStep()) return;
        event.preventDefault();
        redoDecodeStep();
        updateDecodeButtonState();
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


