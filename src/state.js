import { createTabId, deriveTabTitle } from './utils.js';

const STORAGE_KEY = 'scratchpad.tabs.v2';

const createEmptyState = () => ({
    tabs: [],
    activeTabId: null,
    nextTabNumber: 1
});

const createTabRecord = (state, content = '') => {
    const id = createTabId();
    const index = state.nextTabNumber;
    const tab = {
        id,
        title: deriveTabTitle(content, index),
        content,
        scrollTop: 0,
        language: 'markdown'
    };

    state.nextTabNumber += 1;
    return tab;
};

const migrateLegacyState = () => {
    const state = createEmptyState();
    const oldTabs = JSON.parse(localStorage.getItem('tabs') || '[]');
    const oldActiveTab = localStorage.getItem('activeTab');

    if (!Array.isArray(oldTabs) || oldTabs.length === 0) {
        const tab = createTabRecord(state, '');
        state.tabs.push(tab);
        state.activeTabId = tab.id;
        return state;
    }

    oldTabs.forEach((oldId, index) => {
        const content = localStorage.getItem(oldId) || '';
        state.tabs.push({
            id: oldId,
            title: deriveTabTitle(content, index + 1),
            content,
            scrollTop: 0,
            language: 'markdown'
        });
    });

    state.nextTabNumber = state.tabs.length + 1;
    state.activeTabId = state.tabs.some((tab) => tab.id === oldActiveTab)
        ? oldActiveTab
        : state.tabs[0].id;

    return state;
};

export class EditorStateStore {
    constructor() {
        this.state = this.load();
        this.saveTimer = null;
    }

    load() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return migrateLegacyState();

        try {
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.tabs) || typeof parsed.nextTabNumber !== 'number') {
                return migrateLegacyState();
            }

            if (parsed.tabs.length === 0) {
                const tab = createTabRecord(parsed, '');
                parsed.tabs.push(tab);
                parsed.activeTabId = tab.id;
            }

            if (!parsed.tabs.some((tab) => tab.id === parsed.activeTabId)) {
                parsed.activeTabId = parsed.tabs[0].id;
            }

            parsed.tabs = parsed.tabs.map((tab, index) => ({
                ...tab,
                title: deriveTabTitle(tab.content || '', index + 1),
                scrollTop: typeof tab.scrollTop === 'number' ? tab.scrollTop : 0,
                language: typeof tab.language === 'string' ? tab.language : 'markdown'
            }));

            return parsed;
        } catch {
            return migrateLegacyState();
        }
    }

    reloadFromStorage() {
        this.state = this.load();
    }

    getTabs() {
        return this.state.tabs;
    }

    getActiveTabId() {
        return this.state.activeTabId;
    }

    getActiveTab() {
        return this.state.tabs.find((tab) => tab.id === this.state.activeTabId) || null;
    }

    saveImmediate() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    }

    scheduleSave(delay = 120) {
        if (this.saveTimer) {
            window.clearTimeout(this.saveTimer);
        }

        this.saveTimer = window.setTimeout(() => {
            this.saveImmediate();
            this.saveTimer = null;
        }, delay);
    }

    flushSave() {
        if (this.saveTimer) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.saveImmediate();
    }

    setActiveTab(tabId) {
        if (!this.state.tabs.some((tab) => tab.id === tabId)) return;
        this.state.activeTabId = tabId;
        this.saveImmediate();
    }

    addTab(content = '') {
        const tab = createTabRecord(this.state, content);
        this.state.tabs.push(tab);
        this.state.activeTabId = tab.id;
        this.saveImmediate();
    }

    closeTab(tabId) {
        const closedIndex = this.state.tabs.findIndex((tab) => tab.id === tabId);
        if (closedIndex === -1) return;

        this.state.tabs.splice(closedIndex, 1);

        if (this.state.tabs.length === 0) {
            const tab = createTabRecord(this.state, '');
            this.state.tabs.push(tab);
            this.state.activeTabId = tab.id;
            this.saveImmediate();
            return;
        }

        if (!this.state.tabs.some((tab) => tab.id === this.state.activeTabId)) {
            const fallbackIndex = Math.max(0, closedIndex - 1);
            this.state.activeTabId = this.state.tabs[fallbackIndex].id;
        }

        this.saveImmediate();
    }

    updateActiveTabContent(content) {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        activeTab.content = content;
        const tabIndex = this.state.tabs.findIndex((tab) => tab.id === activeTab.id);
        activeTab.title = deriveTabTitle(content, tabIndex + 1);
        this.scheduleSave();
    }

    updateActiveTabScroll(scrollTop) {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        activeTab.scrollTop = scrollTop;
        this.scheduleSave(180);
    }

    updateActiveTabLanguage(language) {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        activeTab.language = language;
        this.saveImmediate();
    }
}
