import { EditorStateStore } from './state.js';
import { LineNumbersManager } from './lineNumbers.js';
import { StatusBarManager } from './statusBar.js';
import { TabsView } from './tabs.js';
import { EditorController } from './editor.js';

const q = (selector) => document.querySelector(selector);
const byId = (id) => document.getElementById(id);

const tabHeaders = q('.tab-headers');
const addTabButton = byId('add-tab');
const editor = byId('tab-editor');
const lineNumbers = byId('line-numbers');
const highlightLayer = byId('editor-highlight');
const statusPosition = byId('status-position');
const statusLines = byId('status-lines');
const statusChars = byId('status-chars');
const statusLanguage = byId('status-language');

const stateStore = new EditorStateStore();

const lineNumbersManager = new LineNumbersManager(editor, lineNumbers, 24);

let editorController = null;
let statusBarManager = null;
let tabsView = null;

const render = () => {
    tabsView.render(stateStore.getTabs(), stateStore.getActiveTabId());
    editorController.renderActiveTab();

    const language = stateStore.getActiveTab()?.language || 'markdown';
    if (statusLanguage.value !== language) {
        statusLanguage.value = language;
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

statusLanguage.addEventListener('change', () => {
    editorController.setLanguage(statusLanguage.value);
});

window.addEventListener('keydown', (event) => {
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


