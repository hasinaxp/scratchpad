import { createTabId, deriveTabTitle } from './utils.js';

const LEGACY_STORAGE_KEY = 'scratchpad.tabs.v2';

const INDEXED_DB_NAME = 'scratchpad';
const INDEXED_DB_VERSION = 1;
const INDEXED_DB_STORE = 'appState';
const INDEXED_DB_KEY = 'tabs.v3';

const STATE_CHANNEL_NAME = 'scratchpad.state.sync';
const SUPPORTED_MODES = new Set(['text', 'json', 'diff', 'table']);

const normalizeMode = (value) => {
    const raw = `${value || ''}`.toLowerCase();
    if (raw === 'markdown' || raw === 'python' || raw === 'java' || raw === 'yaml') {
        return 'text';
    }
    if (SUPPORTED_MODES.has(raw)) return raw;
    return 'text';
};

const createDefaultTable = () => ({
    rows: 20,
    cols: 8,
    cells: Array.from({ length: 20 }, () => Array.from({ length: 8 }, () => ''))
});

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
        wrap: true,
        scrollTop: 0,
        mode: 'text',
        diff: {
            left: '',
            right: ''
        },
        table: createDefaultTable()
    };

    state.nextTabNumber += 1;
    return tab;
};

const cloneValue = (value) => {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
};

const openDatabase = () => new Promise((resolve, reject) => {
    const request = window.indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);

    request.onerror = () => {
        reject(request.error || new Error('Could not open IndexedDB.'));
    };

    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(INDEXED_DB_STORE)) {
            db.createObjectStore(INDEXED_DB_STORE);
        }
    };

    request.onsuccess = () => {
        resolve(request.result);
    };
});

const readPersistedState = async () => {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(INDEXED_DB_STORE, 'readonly');
        const store = tx.objectStore(INDEXED_DB_STORE);
        const request = store.get(INDEXED_DB_KEY);

        request.onerror = () => {
            reject(request.error || new Error('Could not read IndexedDB state.'));
        };

        request.onsuccess = () => {
            resolve(request.result || null);
        };

        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
        tx.onabort = () => db.close();
    });
};

const writePersistedState = async (state) => {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(INDEXED_DB_STORE, 'readwrite');
        const store = tx.objectStore(INDEXED_DB_STORE);

        store.put(cloneValue(state), INDEXED_DB_KEY);

        tx.onerror = () => {
            reject(tx.error || new Error('Could not write IndexedDB state.'));
        };

        tx.oncomplete = () => {
            db.close();
            resolve();
        };

        tx.onabort = () => {
            db.close();
            reject(tx.error || new Error('IndexedDB write aborted.'));
        };
    });
};

const readLegacyValue = (map, key) => {
    if (!map || typeof map !== 'object') return null;
    if (!(key in map)) return null;
    return String(map[key] ?? '');
};

const buildFromLegacyStorageMap = (legacyMap) => {
    const state = createEmptyState();
    const oldTabsRaw = readLegacyValue(legacyMap, 'tabs');
    const oldActiveTab = readLegacyValue(legacyMap, 'activeTab');

    let oldTabs = [];
    try {
        oldTabs = JSON.parse(oldTabsRaw || '[]');
    } catch {
        oldTabs = [];
    }

    if (!Array.isArray(oldTabs) || oldTabs.length === 0) {
        const tab = createTabRecord(state, '');
        state.tabs.push(tab);
        state.activeTabId = tab.id;
        return state;
    }

    oldTabs.forEach((oldId, index) => {
        const content = readLegacyValue(legacyMap, oldId) || '';
        state.tabs.push({
            id: String(oldId),
            title: deriveTabTitle(content, index + 1),
            content,
            wrap: true,
            scrollTop: 0,
            mode: 'text',
            diff: {
                left: '',
                right: ''
            },
            table: createDefaultTable()
        });
    });

    state.nextTabNumber = state.tabs.length + 1;
    state.activeTabId = state.tabs.some((tab) => tab.id === oldActiveTab)
        ? oldActiveTab
        : state.tabs[0].id;

    return state;
};

const migrateLegacyState = () => {
    const legacyMap = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key) continue;
        legacyMap[key] = window.localStorage.getItem(key);
    }

    return buildFromLegacyStorageMap(legacyMap);
};

const normalizeState = (candidate) => {
    if (!candidate || !Array.isArray(candidate.tabs) || typeof candidate.nextTabNumber !== 'number') {
        return null;
    }

    const normalized = {
        tabs: candidate.tabs.map((tab, index) => ({
            id: typeof tab?.id === 'string' && tab.id.length > 0 ? tab.id : createTabId(),
            title: deriveTabTitle(tab?.content || '', index + 1),
            content: typeof tab?.content === 'string' ? tab.content : '',
            wrap: typeof tab?.wrap === 'boolean' ? tab.wrap : true,
            scrollTop: typeof tab?.scrollTop === 'number' ? tab.scrollTop : 0,
            mode: normalizeMode(typeof tab?.mode === 'string'
                ? tab.mode
                : tab?.language),
            diff: {
                left: typeof tab?.diff?.left === 'string' ? tab.diff.left : '',
                right: typeof tab?.diff?.right === 'string' ? tab.diff.right : ''
            },
            table: {
                rows: Number.isInteger(tab?.table?.rows) ? tab.table.rows : createDefaultTable().rows,
                cols: Number.isInteger(tab?.table?.cols) ? tab.table.cols : createDefaultTable().cols,
                cells: Array.isArray(tab?.table?.cells) ? tab.table.cells : createDefaultTable().cells
            }
        })),
        activeTabId: typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null,
        nextTabNumber: Number.isFinite(candidate.nextTabNumber)
            ? Math.max(1, Math.floor(candidate.nextTabNumber))
            : 1
    };

    if (normalized.tabs.length === 0) {
        const tab = createTabRecord(normalized, '');
        normalized.tabs.push(tab);
        normalized.activeTabId = tab.id;
    }

    if (!normalized.tabs.some((tab) => tab.id === normalized.activeTabId)) {
        normalized.activeTabId = normalized.tabs[0].id;
    }

    normalized.nextTabNumber = Math.max(normalized.nextTabNumber, normalized.tabs.length + 1);
    return normalized;
};

const parseSnapshotPayload = (payload) => {
    const directState = normalizeState(payload);
    if (directState) return directState;

    if (payload && typeof payload === 'object' && payload.format === 'scratchpad.indexeddb.v1') {
        return normalizeState(payload.state);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    const legacyJsonState = readLegacyValue(payload, LEGACY_STORAGE_KEY);
    if (legacyJsonState) {
        try {
            const parsed = JSON.parse(legacyJsonState);
            const normalized = normalizeState(parsed);
            if (normalized) return normalized;
        } catch {
            // Ignore and fall through to key/value legacy import.
        }
    }

    return buildFromLegacyStorageMap(payload);
};

export class EditorStateStore {
    constructor() {
        const initial = createEmptyState();
        const firstTab = createTabRecord(initial, '');
        initial.tabs.push(firstTab);
        initial.activeTabId = firstTab.id;

        this.state = initial;
        this.saveTimer = null;
        this.persistQueue = Promise.resolve();
        this.externalUpdateListeners = new Set();
        this.syncClientId = createTabId();
        this.channel = typeof window.BroadcastChannel === 'function'
            ? new window.BroadcastChannel(STATE_CHANNEL_NAME)
            : null;

        if (this.channel) {
            this.channel.onmessage = (event) => {
                const data = event?.data;
                if (!data || data.type !== 'state-updated') return;
                if (data.source === this.syncClientId) return;

                this.reloadFromStorage()
                    .then(() => this.emitExternalUpdate())
                    .catch(() => {});
            };
        }

        this.ready = this.initialize();
    }

    async initialize() {
        try {
            const persisted = await readPersistedState();
            const normalizedPersisted = normalizeState(persisted);
            if (normalizedPersisted) {
                this.state = normalizedPersisted;
                return;
            }

            const migrated = migrateLegacyState();
            this.state = migrated;
            await writePersistedState(this.state);
        } catch {
            this.state = migrateLegacyState();
        }
    }

    async reloadFromStorage() {
        try {
            const persisted = await readPersistedState();
            const normalized = normalizeState(persisted);
            if (normalized) {
                this.state = normalized;
                return;
            }
        } catch {
            // Keep current in-memory state if reload fails.
        }
    }

    onExternalUpdate(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }

        this.externalUpdateListeners.add(listener);
        return () => {
            this.externalUpdateListeners.delete(listener);
        };
    }

    emitExternalUpdate() {
        this.externalUpdateListeners.forEach((listener) => {
            try {
                listener();
            } catch {
                // Keep notifying other listeners.
            }
        });
    }

    announceUpdate() {
        if (!this.channel) return;

        try {
            this.channel.postMessage({
                type: 'state-updated',
                source: this.syncClientId,
                ts: Date.now()
            });
        } catch {
            // Best effort broadcast.
        }
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

    queuePersist(snapshot) {
        const toWrite = cloneValue(snapshot);

        this.persistQueue = this.persistQueue
            .catch(() => {})
            .then(async () => {
                await writePersistedState(toWrite);
                this.announceUpdate();
            })
            .catch(() => {
                // Keep queue alive on write errors.
            });

        return this.persistQueue;
    }

    saveImmediate() {
        return this.queuePersist(this.state);
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

    exportStateSnapshot() {
        return {
            format: 'scratchpad.indexeddb.v1',
            exportedAt: new Date().toISOString(),
            state: cloneValue(this.state)
        };
    }

    importStateSnapshot(payload) {
        const normalized = parseSnapshotPayload(payload);
        if (!normalized) {
            return false;
        }

        this.state = normalized;
        this.saveImmediate();
        this.announceUpdate();
        return true;
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

    updateActiveTabMode(mode) {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        activeTab.mode = mode;
        this.saveImmediate();
    }

    updateActiveTabWrap(enabled) {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        activeTab.wrap = Boolean(enabled);
        this.saveImmediate();
    }

    updateActiveTabDiffContent(side, value) {
        const activeTab = this.getActiveTab();
        if (!activeTab || !activeTab.diff || (side !== 'left' && side !== 'right')) return;

        activeTab.diff[side] = value;
        this.saveImmediate();
    }

    updateActiveTabTable(tableData, content) {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        activeTab.table = {
            rows: Number.isInteger(tableData?.rows) ? tableData.rows : createDefaultTable().rows,
            cols: Number.isInteger(tableData?.cols) ? tableData.cols : createDefaultTable().cols,
            cells: Array.isArray(tableData?.cells) ? tableData.cells : createDefaultTable().cells
        };

        if (typeof content === 'string') {
            activeTab.content = content;
            const tabIndex = this.state.tabs.findIndex((tab) => tab.id === activeTab.id);
            activeTab.title = deriveTabTitle(content, tabIndex + 1);
        }

        this.scheduleSave();
    }
}
