import {
    CellError,
    colName,
    evaluateSheet,
    fillSeries,
    formatValue,
    parseCellName,
    transformRefs
} from './tableFormula.js';
import { escapeHtml } from './utils.js';

const MIN_ROWS = 100;
const MIN_COLS = 26;
const MAX_ROWS = 100000;
const MAX_COLS = 702;
const GROW_ROWS = 100;
const GROW_COLS = 10;
const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 24;
const ROW_HEADER_WIDTH = 52;
const DEFAULT_WIDTH = 110;
const MIN_WIDTH = 36;
const OVERSCAN = 8;
const EDGE = 4;
const HISTORY_LIMIT = 50;

const MENU_ITEMS = [
    ['cut', 'Cut', 'Ctrl+X'],
    ['copy', 'Copy', 'Ctrl+C'],
    ['paste', 'Paste', 'Ctrl+V'],
    null,
    ['insertRowAbove', 'Insert row above'],
    ['insertRowBelow', 'Insert row below'],
    ['insertColLeft', 'Insert column left'],
    ['insertColRight', 'Insert column right'],
    null,
    ['deleteRows', 'Delete row(s)'],
    ['deleteCols', 'Delete column(s)'],
    null,
    ['sortAsc', 'Sort A → Z'],
    ['sortDesc', 'Sort Z → A'],
    ['fillDown', 'Fill down', 'Ctrl+D'],
    ['fillRight', 'Fill right', 'Ctrl+R'],
    ['clear', 'Clear', 'Del'],
    null,
    ['exportCsv', 'Export range as CSV…']
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const emptyRow = (cols) => Array.from({ length: cols }, () => '');
const cellLabel = (r, c) => `${colName(c)}${r + 1}`;

// Quote-aware CSV/TSV parser; the delimiter is guessed from the text unless given.
const parseDelimited = (text, delimiter = text.includes('\t') ? '\t' : ',') => {
    const src = `${text || ''}`.replaceAll('\r\n', '\n');
    const rows = [[]];
    let field = '';
    let quoted = false;

    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"' && src[i + 1] === '"') {
                field += '"';
                i += 1;
            } else if (ch === '"') {
                quoted = false;
            } else {
                field += ch;
            }
        } else if (ch === '"' && field === '') {
            quoted = true;
        } else if (ch === delimiter) {
            rows[rows.length - 1].push(field);
            field = '';
        } else if (ch === '\n') {
            rows[rows.length - 1].push(field);
            field = '';
            rows.push([]);
        } else {
            field += ch;
        }
    }

    rows[rows.length - 1].push(field);
    return rows;
};

const quoteField = (value, delimiter) => (
    value.startsWith('"') || value.includes('\n') || value.includes(delimiter)
        ? `"${value.replaceAll('"', '""')}"`
        : value
);

// Trailing empty cells and rows are dropped so the saved text stays compact.
const serialize = (grid, delimiter) => {
    const lines = grid.map((row) => {
        let last = row.length - 1;
        while (last >= 0 && row[last] === '') last -= 1;
        return row.slice(0, last + 1).map((cell) => quoteField(cell, delimiter)).join(delimiter);
    });
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
};

const toGrid = (source, minRows = MIN_ROWS, minCols = MIN_COLS) => {
    const input = Array.isArray(source) ? source : [];
    const rows = clamp(Math.max(input.length, minRows), 1, MAX_ROWS);
    const cols = clamp(Math.max(minCols, ...input.map((row) => (Array.isArray(row) ? row.length : 0))), 1, MAX_COLS);
    return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (__, c) => `${input[r]?.[c] ?? ''}`));
};

const compareForSort = (a, b) => {
    const blankA = a === '';
    const blankB = b === '';
    if (blankA || blankB) return blankA - blankB;
    const numA = typeof a === 'number';
    const numB = typeof b === 'number';
    if (numA && numB) return a - b;
    if (numA !== numB) return numA ? -1 : 1;
    return formatValue(a).localeCompare(formatValue(b), undefined, { numeric: true, sensitivity: 'base' });
};

const makeDiv = (className) => {
    const el = document.createElement('div');
    el.className = className;
    return el;
};

export class TableModeController {
    constructor({ shell, grid, onTableChange, onStatusChange, onExportCsv }) {
        this.shell = shell;
        this.grid = grid;
        this.onTableChange = onTableChange;
        this.onStatusChange = onStatusChange;
        this.onExportCsv = onExportCsv;
        this.cellName = shell.querySelector('#table-cell-name');
        this.formulaInput = shell.querySelector('#table-formula');
        this.exportPanel = shell.querySelector('#table-export');
        this.exportFrom = shell.querySelector('#table-export-from');
        this.exportTo = shell.querySelector('#table-export-to');
        this.exportHint = shell.querySelector('#table-export-hint');
        this.exportGo = shell.querySelector('#table-export-go');

        this.cells = toGrid(null);
        this.values = evaluateSheet(this.cells);
        this.used = { rows: 0, cols: 0 };
        this.widths = [];
        this.colX = [];
        this.sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
        this.editing = null;
        this.drag = null;
        this.clipboard = null;
        this.tabId = null;
        this.histories = new Map();
        this.windowKey = '';

        this.sheet = makeDiv('table-sheet');
        this.table = document.createElement('table');
        this.table.className = 'table-grid-sheet';
        this.selBox = makeDiv('table-selection');
        this.activeBox = makeDiv('table-active-cell');
        this.fillHandle = makeDiv('table-fill-handle');
        this.fillHandle.title = 'Drag to fill a series, double-click to fill down';
        this.preview = makeDiv('table-drag-preview');
        this.preview.hidden = true;
        this.editor = document.createElement('input');
        this.editor.className = 'table-cell-editor';
        this.editor.spellcheck = false;
        this.editor.autocomplete = 'off';
        this.editor.hidden = true;
        this.sheet.append(this.table, this.selBox, this.activeBox, this.preview, this.fillHandle, this.editor);
        this.grid.replaceChildren(this.sheet);

        this.menu = makeDiv('table-menu');
        this.menu.hidden = true;
        this.menu.setAttribute('role', 'menu');
        this.menu.innerHTML = MENU_ITEMS.map((item) => (item
            ? `<button type="button" role="menuitem" data-table-action="${item[0]}"><span>${item[1]}</span><kbd>${item[2] || ''}</kbd></button>`
            : '<hr>')).join('');
        document.body.append(this.menu);

        this.bindEvents();
        this.layout();
        this.renderWindow(true);
    }

    get rows() {
        return this.cells.length;
    }

    get cols() {
        return this.cells[0].length;
    }

    colWidth(c) {
        return this.widths[c] || DEFAULT_WIDTH;
    }

    valueAt(r, c) {
        return this.values[r]?.[c] ?? '';
    }

    range() {
        const { ar, ac, fr, fc } = this.sel;
        return {
            r1: Math.min(ar, fr),
            c1: Math.min(ac, fc),
            r2: Math.max(ar, fr),
            c2: Math.max(ac, fc)
        };
    }

    computeUsed() {
        let rows = 0;
        let cols = 0;
        this.cells.forEach((row, r) => {
            let last = row.length - 1;
            while (last >= 0 && row[last] === '') last -= 1;
            if (last >= 0) {
                rows = r + 1;
                cols = Math.max(cols, last + 1);
            }
        });
        this.used = { rows, cols };
    }

    /* ---------- geometry (fixed row height, prefix-summed column widths) ---------- */

    layout() {
        this.colX = [ROW_HEADER_WIDTH];
        for (let c = 0; c < this.cols; c += 1) this.colX.push(this.colX[c] + this.colWidth(c));
        const width = `${this.colX[this.cols]}px`;
        this.sheet.style.width = width;
        this.sheet.style.height = `${HEADER_HEIGHT + (this.rows * ROW_HEIGHT)}px`;
        this.table.style.width = width;
        this.windowKey = '';
    }

    colAt(x) {
        let lo = 0;
        let hi = this.cols - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.colX[mid] <= x) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    rowAt(y) {
        return clamp(Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT), 0, this.rows - 1);
    }

    rect(r1, c1, r2, c2) {
        return {
            left: this.colX[c1],
            top: HEADER_HEIGHT + (r1 * ROW_HEIGHT),
            width: this.colX[c2 + 1] - this.colX[c1],
            height: (r2 - r1 + 1) * ROW_HEIGHT
        };
    }

    placeBox(el, { left, top, width, height }) {
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
    }

    pointAt(clientX, clientY) {
        const box = this.grid.getBoundingClientRect();
        const gx = clientX - box.left;
        const gy = clientY - box.top;
        const x = gx + this.grid.scrollLeft;
        const y = gy + this.grid.scrollTop;
        return {
            x,
            y,
            r: this.rowAt(y),
            c: this.colAt(x),
            colHeader: gy < HEADER_HEIGHT,
            rowHeader: gx < ROW_HEADER_WIDTH,
            inside: gx >= 0 && gy >= 0 && gx < this.grid.clientWidth && gy < this.grid.clientHeight
        };
    }

    nearSelectionEdge(p) {
        if (p.colHeader || p.rowHeader) return false;
        const { r1, c1, r2, c2 } = this.range();
        const b = this.rect(r1, c1, r2, c2);
        const right = b.left + b.width;
        const bottom = b.top + b.height;
        if (p.x < b.left - EDGE || p.x > right + EDGE || p.y < b.top - EDGE || p.y > bottom + EDGE) return false;
        return Math.abs(p.x - b.left) <= EDGE || Math.abs(p.x - right) <= EDGE
            || Math.abs(p.y - b.top) <= EDGE || Math.abs(p.y - bottom) <= EDGE;
    }

    /* ---------- rendering: only the visible window of rows/columns is in the DOM ---------- */

    // Grows the sheet when the viewport nears its end so it feels endless.
    growIfNeeded() {
        const g = this.grid;
        let rows = this.rows;
        let cols = this.cols;
        if (g.scrollTop + g.clientHeight > HEADER_HEIGHT + ((rows - 10) * ROW_HEIGHT)) rows += GROW_ROWS;
        if (g.scrollLeft + g.clientWidth > this.colX[cols] - (3 * DEFAULT_WIDTH)) cols += GROW_COLS;
        if (rows === this.rows && cols === this.cols) return;
        this.ensureSize(rows, cols);
        this.layout();
    }

    renderWindow(force = false) {
        const g = this.grid;
        const r0 = Math.max(0, Math.floor(g.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const r1 = Math.min(this.rows, Math.ceil((g.scrollTop + g.clientHeight) / ROW_HEIGHT) + OVERSCAN);
        const c0 = Math.max(0, this.colAt(g.scrollLeft + ROW_HEADER_WIDTH) - 1);
        const c1 = Math.min(this.cols, this.colAt(g.scrollLeft + g.clientWidth) + 2);
        const key = `${r0},${r1},${c0},${c1}`;
        if (!force && key === this.windowKey) return;
        this.windowKey = key;

        const { r1: sr1, c1: sc1, r2: sr2, c2: sc2 } = this.range();
        const span = c1 - c0 + 3;
        const colgroup = [
            `<col style="width:${ROW_HEADER_WIDTH}px">`,
            `<col style="width:${this.colX[c0] - ROW_HEADER_WIDTH}px">`
        ];
        const head = ['<th class="table-corner" title="Select all"></th><th class="table-pad"></th>'];
        for (let c = c0; c < c1; c += 1) {
            colgroup.push(`<col style="width:${this.colWidth(c)}px">`);
            const selected = c >= sc1 && c <= sc2 ? ' is-selected' : '';
            head.push(`<th class="table-col-header${selected}" data-c="${c}">${colName(c)}<span class="table-col-resize" data-col="${c}"></span></th>`);
        }
        colgroup.push(`<col style="width:${this.colX[this.cols] - this.colX[c1]}px">`);
        head.push('<th class="table-pad"></th>');

        const body = [];
        if (r0 > 0) body.push(`<tr class="table-spacer" style="height:${r0 * ROW_HEIGHT}px"><td colspan="${span}"></td></tr>`);
        for (let r = r0; r < r1; r += 1) {
            const selected = r >= sr1 && r <= sr2 ? ' is-selected' : '';
            body.push(`<tr><th class="table-row-header${selected}" data-r="${r}">${r + 1}</th><td class="table-pad"></td>`);
            for (let c = c0; c < c1; c += 1) {
                const value = this.valueAt(r, c);
                body.push(`<td class="${this.cellClass(value)}">${escapeHtml(formatValue(value))}</td>`);
            }
            body.push('<td class="table-pad"></td></tr>');
        }
        if (r1 < this.rows) {
            body.push(`<tr class="table-spacer" style="height:${(this.rows - r1) * ROW_HEIGHT}px"><td colspan="${span}"></td></tr>`);
        }

        this.table.innerHTML = `<colgroup>${colgroup.join('')}</colgroup><thead><tr>${head.join('')}</tr></thead><tbody>${body.join('')}</tbody>`;
    }

    cellClass(value) {
        if (value instanceof CellError) return 'err';
        return typeof value === 'number' || typeof value === 'boolean' ? 'num' : '';
    }

    paintHeaders() {
        const { r1, c1, r2, c2 } = this.range();
        this.table.querySelectorAll('th[data-c]').forEach((th) => {
            const c = Number(th.dataset.c);
            th.classList.toggle('is-selected', c >= c1 && c <= c2);
        });
        this.table.querySelectorAll('th[data-r]').forEach((th) => {
            const r = Number(th.dataset.r);
            th.classList.toggle('is-selected', r >= r1 && r <= r2);
        });
    }

    drawSelection() {
        const { ar, ac } = this.sel;
        const { r1, c1, r2, c2 } = this.range();
        const box = this.rect(r1, c1, r2, c2);
        this.placeBox(this.selBox, box);
        this.selBox.hidden = r1 === r2 && c1 === c2;
        this.placeBox(this.activeBox, this.rect(ar, ac, ar, ac));
        this.fillHandle.style.left = `${box.left + box.width - 4}px`;
        this.fillHandle.style.top = `${box.top + box.height - 4}px`;
        this.paintHeaders();

        this.cellName.textContent = this.selBox.hidden ? cellLabel(ar, ac) : `${cellLabel(r1, c1)}:${cellLabel(r2, c2)}`;
        if (document.activeElement !== this.formulaInput) {
            this.formulaInput.value = this.cells[ar][ac];
        }
        this.emitStatus();
    }

    scrollToCell(r, c) {
        const g = this.grid;
        const b = this.rect(r, c, r, c);
        if (b.top - HEADER_HEIGHT < g.scrollTop) g.scrollTop = b.top - HEADER_HEIGHT;
        else if (b.top + b.height > g.scrollTop + g.clientHeight) g.scrollTop = b.top + b.height - g.clientHeight;
        if (b.left - ROW_HEADER_WIDTH < g.scrollLeft) g.scrollLeft = b.left - ROW_HEADER_WIDTH;
        else if (b.left + b.width > g.scrollLeft + g.clientWidth) g.scrollLeft = b.left + b.width - g.clientWidth;
    }

    emitStatus() {
        if (typeof this.onStatusChange !== 'function') return;
        const { r1, c1, r2, c2 } = this.range();
        let count = 0;
        let numbers = 0;
        let sum = 0;
        // Cells beyond the used area are empty, so whole-column selections stay cheap.
        for (let r = r1; r <= Math.min(r2, this.used.rows - 1); r += 1) {
            for (let c = c1; c <= Math.min(c2, this.used.cols - 1); c += 1) {
                const value = this.valueAt(r, c);
                if (value !== '') count += 1;
                if (typeof value === 'number') {
                    numbers += 1;
                    sum += value;
                }
            }
        }
        const multi = r1 !== r2 || c1 !== c2;
        this.onStatusChange({
            position: this.cellName.textContent,
            summary: multi && numbers ? `Sum ${formatValue(sum)} · Avg ${formatValue(sum / numbers)} · Count ${count}` : '',
            rows: this.used.rows,
            cols: this.used.cols
        });
    }

    usedCells() {
        return this.cells.slice(0, this.used.rows).map((row) => row.slice(0, this.used.cols));
    }

    emitChange() {
        if (typeof this.onTableChange !== 'function') return;
        // Only the used area is stored; the empty space around it is recreated on load.
        const cells = this.usedCells();
        this.onTableChange({
            tableData: { rows: this.used.rows, cols: this.used.cols, cells, widths: this.widths },
            content: serialize(cells, '\t')
        });
    }

    /* ---------- state changes ---------- */

    history() {
        if (!this.histories.has(this.tabId)) this.histories.set(this.tabId, { undo: [], redo: [] });
        return this.histories.get(this.tabId);
    }

    snapshot() {
        return {
            cells: this.usedCells(),
            rows: this.rows,
            cols: this.cols,
            widths: this.widths.slice(),
            sel: { ...this.sel }
        };
    }

    pushHistory() {
        const history = this.history();
        history.undo.push(this.snapshot());
        if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
        history.redo = [];
    }

    commit() {
        this.values = evaluateSheet(this.cells);
        this.computeUsed();
        this.layout();
        this.clampSelection();
        this.renderWindow(true);
        this.drawSelection();
        this.emitChange();
    }

    mutate(fn) {
        this.pushHistory();
        fn();
        this.commit();
    }

    restore(from, to) {
        const state = this.history()[from].pop();
        if (!state) return;
        this.history()[to].push(this.snapshot());
        this.cells = toGrid(state.cells, state.rows, state.cols);
        this.widths = state.widths;
        this.sel = state.sel;
        this.commit();
    }

    clampSelection() {
        const s = this.sel;
        s.ar = clamp(s.ar, 0, this.rows - 1);
        s.fr = clamp(s.fr, 0, this.rows - 1);
        s.ac = clamp(s.ac, 0, this.cols - 1);
        s.fc = clamp(s.fc, 0, this.cols - 1);
    }

    ensureSize(rows, cols) {
        const targetCols = clamp(Math.max(cols, this.cols), 1, MAX_COLS);
        this.cells.forEach((row) => {
            while (row.length < targetCols) row.push('');
        });
        while (this.cells.length < Math.min(rows, MAX_ROWS)) this.cells.push(emptyRow(targetCols));
    }

    // Writes a block of raw values at (r, c), growing the sheet if needed.
    writeBlock(r, c, block) {
        this.ensureSize(r + block.length, c + Math.max(...block.map((row) => row.length)));
        block.forEach((row, i) => row.forEach((value, j) => {
            if (r + i < this.rows && c + j < this.cols) this.cells[r + i][c + j] = value;
        }));
    }

    setActiveValue(value) {
        const { ar, ac } = this.sel;
        if (this.cells[ar][ac] === value) return;
        this.mutate(() => {
            this.cells[ar][ac] = value;
        });
    }

    mapFormulas(fn) {
        this.cells = this.cells.map((row) => row.map((raw) => transformRefs(raw, fn)));
    }

    shiftFormula(raw, dr, dc) {
        return transformRefs(raw, (ref) => {
            const row = ref.absRow ? ref.row : ref.row + dr;
            const col = ref.absCol ? ref.col : ref.col + dc;
            return row < 0 || col < 0 ? null : { ...ref, row, col };
        });
    }

    insertRows(at, count) {
        if (this.rows + count > MAX_ROWS) return;
        this.mutate(() => {
            this.mapFormulas((ref) => (ref.row >= at ? { ...ref, row: ref.row + count } : ref));
            this.cells.splice(at, 0, ...Array.from({ length: count }, () => emptyRow(this.cols)));
            this.sel = { ar: at, ac: this.sel.ac, fr: at + count - 1, fc: this.sel.fc };
        });
    }

    // shortcut: a range whose end row/col is deleted becomes #REF! instead of shrinking; refine if it bites.
    deleteRows(at, count) {
        this.mutate(() => {
            this.mapFormulas((ref) => {
                if (ref.row >= at && ref.row < at + count) return null;
                return ref.row >= at + count ? { ...ref, row: ref.row - count } : ref;
            });
            this.cells.splice(at, count);
            this.ensureSize(MIN_ROWS, this.cols);
        });
    }

    insertCols(at, count) {
        if (this.cols + count > MAX_COLS) return;
        this.mutate(() => {
            this.mapFormulas((ref) => (ref.col >= at ? { ...ref, col: ref.col + count } : ref));
            this.cells.forEach((row) => row.splice(at, 0, ...emptyRow(count)));
            this.widths = Array.from({ length: this.cols - count }, (_, c) => this.colWidth(c));
            this.widths.splice(at, 0, ...Array(count).fill(DEFAULT_WIDTH));
            this.sel = { ar: this.sel.ar, ac: at, fr: this.sel.fr, fc: at + count - 1 };
        });
    }

    deleteCols(at, count) {
        this.mutate(() => {
            this.mapFormulas((ref) => {
                if (ref.col >= at && ref.col < at + count) return null;
                return ref.col >= at + count ? { ...ref, col: ref.col - count } : ref;
            });
            this.cells.forEach((row) => row.splice(at, count));
            this.widths.splice(at, count);
            this.cells.forEach((row) => {
                while (row.length < MIN_COLS) row.push('');
            });
        });
    }

    clearRange() {
        const { r1, c1, r2, c2 } = this.range();
        this.mutate(() => {
            for (let r = r1; r <= r2; r += 1) {
                for (let c = c1; c <= c2; c += 1) this.cells[r][c] = '';
            }
        });
    }

    // Sorts the selected rows, or every used row when a single row is selected.
    sortRows(descending) {
        const { r1, r2 } = this.range();
        const [from, to] = r1 === r2 ? [0, Math.max(0, this.used.rows - 1)] : [r1, r2];
        const col = this.sel.ac;
        this.mutate(() => {
            const order = [];
            for (let r = from; r <= to; r += 1) order.push(r);
            order.sort((a, b) => {
                const va = this.valueAt(a, col);
                const vb = this.valueAt(b, col);
                const result = compareForSort(va, vb);
                return descending && va !== '' && vb !== '' ? -result : result;
            });
            const sorted = order.map((r) => this.cells[r]);
            this.cells.splice(from, sorted.length, ...sorted);
        });
    }

    // Ctrl+D / Ctrl+R: copy the first row/column of the selection across it.
    fill(down) {
        const { r1, c1, r2, c2 } = this.range();
        if (down ? r1 === r2 : c1 === c2) return;
        this.mutate(() => {
            for (let r = r1; r <= r2; r += 1) {
                for (let c = c1; c <= c2; c += 1) {
                    const sr = down ? r1 : r;
                    const sc = down ? c : c1;
                    if (r !== sr || c !== sc) this.cells[r][c] = this.shiftFormula(this.cells[sr][sc], r - sr, c - sc);
                }
            }
        });
    }

    // Fill-handle drag: project each source row/column as a series into the target area.
    autofill(src, target) {
        const vertical = target.r1 !== src.r1 || target.r2 !== src.r2;
        if (!vertical && target.c1 === src.c1 && target.c2 === src.c2) return;
        this.mutate(() => {
            if (vertical) {
                for (let c = src.c1; c <= src.c2; c += 1) {
                    const source = [];
                    for (let r = src.r1; r <= src.r2; r += 1) source.push(this.cells[r][c]);
                    const project = fillSeries(source, (raw, delta) => this.shiftFormula(raw, delta, 0));
                    for (let r = target.r1; r <= target.r2; r += 1) {
                        if (r < src.r1 || r > src.r2) this.cells[r][c] = project(r - src.r1);
                    }
                }
            } else {
                for (let r = src.r1; r <= src.r2; r += 1) {
                    const source = this.cells[r].slice(src.c1, src.c2 + 1);
                    const project = fillSeries(source, (raw, delta) => this.shiftFormula(raw, 0, delta));
                    for (let c = target.c1; c <= target.c2; c += 1) {
                        if (c < src.c1 || c > src.c2) this.cells[r][c] = project(c - src.c1);
                    }
                }
            }
            this.sel = { ar: target.r1, ac: target.c1, fr: target.r2, fc: target.c2 };
        });
    }

    // Double-click on the fill handle: fill down as far as the neighboring column has data.
    autofillToData() {
        const src = this.range();
        const below = src.r2 + 1;
        const neighbor = [src.c1 - 1, src.c2 + 1].find((c) => c >= 0 && c < this.cols && this.cells[below]?.[c]);
        if (neighbor === undefined) return;
        let end = below;
        while (end + 1 < this.rows && this.cells[end + 1][neighbor] !== '') end += 1;
        this.autofill(src, { ...src, r2: end });
    }

    // Dragging the selection border moves cells; formulas pointing at them follow, like spreadsheets.
    moveRange(src, dr, dc) {
        this.mutate(() => {
            const block = [];
            for (let r = src.r1; r <= src.r2; r += 1) {
                block.push(this.cells[r].slice(src.c1, src.c2 + 1));
                for (let c = src.c1; c <= src.c2; c += 1) this.cells[r][c] = '';
            }
            this.writeBlock(src.r1 + dr, src.c1 + dc, block);
            const inside = (ref) => ref.row >= src.r1 && ref.row <= src.r2 && ref.col >= src.c1 && ref.col <= src.c2;
            this.mapFormulas((ref) => (inside(ref) ? { ...ref, row: ref.row + dr, col: ref.col + dc } : ref));
            this.sel = { ar: src.r1 + dr, ac: src.c1 + dc, fr: src.r2 + dr, fc: src.c2 + dc };
        });
    }

    /* ---------- clipboard & export ---------- */

    copyRange() {
        const { r1, c1 } = this.range();
        // Whole-row/column selections are trimmed to the used area.
        const r2 = Math.max(r1, Math.min(this.range().r2, this.used.rows - 1));
        const c2 = Math.max(c1, Math.min(this.range().c2, this.used.cols - 1));
        const raw = this.cells.slice(r1, r2 + 1).map((row) => row.slice(c1, c2 + 1));
        const text = this.toDelimited(r1, c1, r2, c2, '\t');
        this.clipboard = { text, raw, r: r1, c: c1 };
        return text;
    }

    toDelimited(r1, c1, r2, c2, delimiter) {
        const lines = [];
        for (let r = r1; r <= r2; r += 1) {
            const line = [];
            for (let c = c1; c <= c2; c += 1) line.push(quoteField(formatValue(this.valueAt(r, c)), delimiter));
            lines.push(line.join(delimiter));
        }
        return lines.join('\n');
    }

    pasteText(text) {
        if (!text) return;
        const { ar, ac } = this.sel;
        let block;
        // Our own copy pastes formulas with shifted refs; anything else pastes as values.
        if (this.clipboard && text === this.clipboard.text) {
            const { raw, r, c } = this.clipboard;
            block = raw.map((row) => row.map((value) => this.shiftFormula(value, ar - r, ac - c)));
        } else {
            block = parseDelimited(text.replace(/\r?\n$/, ''), '\t');
        }

        const { r1, c1, r2, c2 } = this.range();
        if (block.length === 1 && block[0].length === 1 && (r1 !== r2 || c1 !== c2)) {
            this.mutate(() => {
                // Whole-column selections only fill a little past the data, not all the endless rows.
                for (let r = r1; r <= Math.min(r2, Math.max(this.used.rows, r1 + 1000)); r += 1) {
                    for (let c = c1; c <= c2; c += 1) this.cells[r][c] = block[0][0];
                }
            });
            return;
        }

        this.mutate(() => {
            this.writeBlock(ar, ac, block);
            this.sel = {
                ar,
                ac,
                fr: Math.min(ar + block.length - 1, this.rows - 1),
                fc: Math.min(ac + Math.max(...block.map((row) => row.length)) - 1, this.cols - 1)
            };
        });
    }

    exportRange() {
        const from = parseCellName(this.exportFrom.value);
        const to = parseCellName(this.exportTo.value);
        if (!from || !to) return null;
        const range = {
            r1: Math.min(from.row, to.row),
            c1: Math.min(from.col, to.col),
            r2: Math.max(from.row, to.row),
            c2: Math.max(from.col, to.col)
        };
        return range.r2 < MAX_ROWS && range.c2 < MAX_COLS ? range : null;
    }

    updateExportHint() {
        const range = this.exportRange();
        this.exportHint.textContent = range
            ? `${range.r2 - range.r1 + 1} rows × ${range.c2 - range.c1 + 1} columns`
            : 'Enter two corner cells, e.g. A1 and D20';
        this.exportHint.classList.toggle('is-invalid', !range);
        this.exportGo.disabled = !range;
    }

    fillExportFromSelection() {
        const { r1, c1, r2, c2 } = this.range();
        const single = r1 === r2 && c1 === c2;
        const end = single
            ? [Math.max(0, this.used.rows - 1), Math.max(0, this.used.cols - 1)]
            : [Math.min(r2, Math.max(r1, this.used.rows - 1)), Math.min(c2, Math.max(c1, this.used.cols - 1))];
        this.exportFrom.value = single ? 'A1' : cellLabel(r1, c1);
        this.exportTo.value = cellLabel(...end);
        this.updateExportHint();
    }

    toggleExport(open = this.exportPanel.hidden) {
        this.exportPanel.hidden = !open;
        if (!open) return;
        this.fillExportFromSelection();
        this.exportFrom.focus();
        this.exportFrom.select();
    }

    doExport() {
        const range = this.exportRange();
        if (!range) return;
        const text = this.toDelimited(range.r1, range.c1, range.r2, range.c2, ',');
        this.onExportCsv?.(text, `${cellLabel(range.r1, range.c1)}-${cellLabel(range.r2, range.c2)}`);
        this.toggleExport(false);
        this.grid.focus({ preventScroll: true });
    }

    /* ---------- selection & editing ---------- */

    select(hit, extend = false) {
        const s = this.sel;
        const r = hit.r ?? s.fr;
        const c = hit.c ?? s.fc;
        if (hit.type === 'corner') {
            this.sel = { ar: 0, ac: 0, fr: this.rows - 1, fc: this.cols - 1 };
        } else if (hit.type === 'col') {
            this.sel = { ar: 0, ac: extend ? s.ac : c, fr: this.rows - 1, fc: c };
        } else if (hit.type === 'row') {
            this.sel = { ar: extend ? s.ar : r, ac: 0, fr: r, fc: this.cols - 1 };
        } else if (extend) {
            this.sel = { ...s, fr: r, fc: c };
        } else {
            this.sel = { ar: r, ac: c, fr: r, fc: c };
        }
        this.drawSelection();
    }

    // Ctrl+Arrow: jump to the edge of the current data block, like spreadsheets do.
    jumpTarget(r, c, dr, dc) {
        const inside = (row, col) => row >= 0 && col >= 0 && row < this.rows && col < this.cols;
        const filled = (row, col) => this.cells[row][col] !== '';
        if (!inside(r + dr, c + dc)) return [r, c];
        if (filled(r, c) && filled(r + dr, c + dc)) {
            while (inside(r + dr, c + dc) && filled(r + dr, c + dc)) {
                r += dr;
                c += dc;
            }
            return [r, c];
        }
        do {
            r += dr;
            c += dc;
        } while (inside(r + dr, c + dc) && !filled(r, c));
        return [r, c];
    }

    move(dr, dc, { extend = false, jump = false } = {}) {
        const s = this.sel;
        const baseR = extend ? s.fr : s.ar;
        const baseC = extend ? s.fc : s.ac;
        let [r, c] = jump ? this.jumpTarget(baseR, baseC, dr, dc) : [baseR + dr, baseC + dc];

        if (r >= this.rows || c >= this.cols) {
            this.ensureSize(r >= this.rows ? this.rows + GROW_ROWS : this.rows, c >= this.cols ? this.cols + GROW_COLS : this.cols);
            this.layout();
        }
        r = clamp(r, 0, this.rows - 1);
        c = clamp(c, 0, this.cols - 1);
        this.sel = extend ? { ...s, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c };
        this.scrollToCell(r, c);
        this.renderWindow();
        this.drawSelection();
    }

    startEdit(initial, mode) {
        const { ar, ac } = this.sel;
        this.scrollToCell(ar, ac);
        const b = this.rect(ar, ac, ar, ac);
        this.editing = { r: ar, c: ac, mode };
        this.editor.value = initial ?? this.cells[ar][ac];
        this.placeBox(this.editor, b);
        this.editor.style.minWidth = `${b.width}px`;
        this.editor.style.width = `${Math.max(b.width, (this.editor.value.length + 2) * 7.5)}px`;
        this.editor.hidden = false;
        this.fillHandle.hidden = true;
        this.editor.focus({ preventScroll: true });
        this.editor.setSelectionRange(this.editor.value.length, this.editor.value.length);
        this.formulaInput.value = this.editor.value;
    }

    stopEdit(refocus = true) {
        this.editing = null;
        this.editor.hidden = true;
        this.fillHandle.hidden = false;
        if (refocus) this.grid.focus({ preventScroll: true });
    }

    commitEdit(refocus = true) {
        if (!this.editing) return;
        const { r, c } = this.editing;
        const value = this.editor.value;
        this.stopEdit(refocus);
        this.sel = { ar: r, ac: c, fr: r, fc: c };
        this.setActiveValue(value);
    }

    /* ---------- drags: select, fill handle, move ---------- */

    startDrag(mode, event) {
        const p = this.pointAt(event.clientX, event.clientY);
        this.drag = { mode, start: { r: p.r, c: p.c }, origin: this.range(), x: event.clientX, y: event.clientY, target: null };
        this.grid.dataset.drag = mode;

        const onMove = (moveEvent) => {
            this.drag.x = moveEvent.clientX;
            this.drag.y = moveEvent.clientY;
            this.updateDrag();
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.cancelAnimationFrame(this.drag.raf);
            this.finishDrag();
        };
        // Auto-scroll while the pointer is past an edge; scrolling also grows the sheet.
        const tick = () => {
            const box = this.grid.getBoundingClientRect();
            const speed = (distance) => Math.min(40, Math.ceil(distance / 3));
            const { x, y } = this.drag;
            let dx = 0;
            let dy = 0;
            if (mode !== 'col') {
                if (y < box.top + HEADER_HEIGHT) dy = -speed(box.top + HEADER_HEIGHT - y);
                else if (y > box.top + this.grid.clientHeight) dy = speed(y - box.top - this.grid.clientHeight);
            }
            if (mode !== 'row') {
                if (x < box.left + ROW_HEADER_WIDTH) dx = -speed(box.left + ROW_HEADER_WIDTH - x);
                else if (x > box.left + this.grid.clientWidth) dx = speed(x - box.left - this.grid.clientWidth);
            }
            if (dx || dy) {
                this.grid.scrollLeft += dx;
                this.grid.scrollTop += dy;
                this.updateDrag();
            }
            this.drag.raf = window.requestAnimationFrame(tick);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        this.drag.raf = window.requestAnimationFrame(tick);
    }

    updateDrag() {
        const d = this.drag;
        const p = this.pointAt(d.x, d.y);
        const o = d.origin;

        if (d.mode === 'cell' || d.mode === 'col' || d.mode === 'row') {
            this.select({ type: d.mode, r: p.r, c: p.c }, true);
            return;
        }

        let target = { ...o };
        if (d.mode === 'fill') {
            const down = p.r > o.r2 ? p.r - o.r2 : Math.min(0, p.r - o.r1);
            const right = p.c > o.c2 ? p.c - o.c2 : Math.min(0, p.c - o.c1);
            // Like spreadsheets, a fill extends along one axis only: whichever the pointer moved further on.
            if (Math.abs(down) >= Math.abs(right) && down) {
                if (down > 0) target.r2 = p.r;
                else target.r1 = p.r;
            } else if (right) {
                if (right > 0) target.c2 = p.c;
                else target.c1 = p.c;
            }
        } else {
            const dr = clamp(p.r - d.start.r, -o.r1, this.rows - 1 - o.r2);
            const dc = clamp(p.c - d.start.c, -o.c1, this.cols - 1 - o.c2);
            target = { r1: o.r1 + dr, c1: o.c1 + dc, r2: o.r2 + dr, c2: o.c2 + dc, dr, dc };
        }
        d.target = target;
        this.placeBox(this.preview, this.rect(target.r1, target.c1, target.r2, target.c2));
        this.preview.hidden = false;
    }

    finishDrag() {
        const d = this.drag;
        this.drag = null;
        delete this.grid.dataset.drag;
        this.preview.hidden = true;
        if (!d.target) return;
        if (d.mode === 'fill') this.autofill(d.origin, d.target);
        if (d.mode === 'move' && (d.target.dr || d.target.dc)) this.moveRange(d.origin, d.target.dr, d.target.dc);
    }

    startResize(event, c) {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startWidth = this.colWidth(c);
        this.pushHistory();
        const onMove = (moveEvent) => {
            this.widths = Array.from({ length: Math.max(this.widths.length, c + 1) }, (_, i) => this.colWidth(i));
            this.widths[c] = Math.max(MIN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX));
            this.layout();
            this.renderWindow(true);
            this.drawSelection();
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.emitChange();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    /* ---------- menu & actions ---------- */

    runAction(name) {
        const { r1, c1, r2, c2 } = this.range();
        const actions = {
            undo: () => this.restore('undo', 'redo'),
            redo: () => this.restore('redo', 'undo'),
            copy: () => navigator.clipboard?.writeText(this.copyRange()),
            cut: () => {
                navigator.clipboard?.writeText(this.copyRange());
                this.clearRange();
            },
            paste: () => navigator.clipboard?.readText().then((text) => this.pasteText(text)).catch(() => {}),
            insertRowAbove: () => this.insertRows(r1, r2 - r1 + 1),
            insertRowBelow: () => this.insertRows(r2 + 1, r2 - r1 + 1),
            insertColLeft: () => this.insertCols(c1, c2 - c1 + 1),
            insertColRight: () => this.insertCols(c2 + 1, c2 - c1 + 1),
            deleteRows: () => this.deleteRows(r1, r2 - r1 + 1),
            deleteCols: () => this.deleteCols(c1, c2 - c1 + 1),
            sortAsc: () => this.sortRows(false),
            sortDesc: () => this.sortRows(true),
            fillDown: () => this.fill(true),
            fillRight: () => this.fill(false),
            clear: () => this.clearRange(),
            exportCsv: () => this.toggleExport()
        };
        if (this.editing) this.commitEdit();
        actions[name]?.();
        if (!this.editing && this.exportPanel.hidden) this.grid.focus({ preventScroll: true });
    }

    showMenu(x, y) {
        this.menu.hidden = false;
        const { width, height } = this.menu.getBoundingClientRect();
        this.menu.style.left = `${Math.min(x, window.innerWidth - width - 4)}px`;
        this.menu.style.top = `${Math.min(y, window.innerHeight - height - 4)}px`;
        this.menu.querySelector('button')?.focus();
    }

    hideMenu() {
        this.menu.hidden = true;
    }

    /* ---------- events ---------- */

    bindEvents() {
        this.shell.querySelectorAll('.table-toolbar [data-table-action]').forEach((button) => {
            button.addEventListener('click', () => this.runAction(button.dataset.tableAction));
        });

        this.menu.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest('[data-table-action]') : null;
            if (!button) return;
            this.hideMenu();
            this.runAction(button.dataset.tableAction);
        });

        this.menu.addEventListener('keydown', (event) => {
            const items = [...this.menu.querySelectorAll('button')];
            const index = items.indexOf(document.activeElement);
            if (event.key === 'Escape') {
                this.hideMenu();
                this.grid.focus();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const step = event.key === 'ArrowDown' ? 1 : -1;
                items[(index + step + items.length) % items.length].focus();
            } else {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
        });

        window.addEventListener('mousedown', (event) => {
            if (!this.menu.hidden && !this.menu.contains(event.target)) this.hideMenu();
            const exportButton = event.target instanceof Element ? event.target.closest('[data-table-action="exportCsv"]') : null;
            if (!this.exportPanel.hidden && !this.exportPanel.contains(event.target) && !exportButton) this.toggleExport(false);
        }, true);
        window.addEventListener('blur', () => this.hideMenu());

        this.grid.addEventListener('scroll', () => {
            this.hideMenu();
            this.growIfNeeded();
            this.renderWindow();
        });
        new ResizeObserver(() => {
            this.growIfNeeded();
            this.renderWindow();
        }).observe(this.grid);

        this.grid.addEventListener('mousedown', (event) => this.onMouseDown(event));

        this.grid.addEventListener('mousemove', (event) => {
            if (this.drag) return;
            const p = this.pointAt(event.clientX, event.clientY);
            this.grid.classList.toggle('is-move-edge', event.target !== this.fillHandle && this.nearSelectionEdge(p));
        });

        this.grid.addEventListener('dblclick', (event) => {
            if (event.target === this.fillHandle) {
                this.autofillToData();
                return;
            }
            const p = this.pointAt(event.clientX, event.clientY);
            if (p.inside && !p.colHeader && !p.rowHeader && event.target !== this.editor) this.startEdit(null, 'edit');
        });

        this.grid.addEventListener('contextmenu', (event) => {
            if (event.target === this.editor || !this.pointAt(event.clientX, event.clientY).inside) return;
            event.preventDefault();
            this.showMenu(event.clientX, event.clientY);
        });

        this.grid.addEventListener('keydown', (event) => {
            if (event.target === this.grid) this.onGridKey(event);
        });

        this.editor.addEventListener('keydown', (event) => this.onEditorKey(event));
        this.editor.addEventListener('input', () => {
            this.formulaInput.value = this.editor.value;
            const minWidth = parseFloat(this.editor.style.minWidth) || 0;
            this.editor.style.width = `${Math.max(minWidth, (this.editor.value.length + 2) * 7.5)}px`;
        });
        // Focus is already moving elsewhere (e.g. the formula bar), so don't pull it back.
        this.editor.addEventListener('blur', () => this.commitEdit(false));

        this.formulaInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.setActiveValue(this.formulaInput.value);
                // Blur (and its change event) must happen before the selection moves.
                this.grid.focus({ preventScroll: true });
                this.move(1, 0);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.formulaInput.value = this.cells[this.sel.ar][this.sel.ac];
                this.grid.focus({ preventScroll: true });
            }
        });
        this.formulaInput.addEventListener('change', () => this.setActiveValue(this.formulaInput.value));

        this.exportFrom.addEventListener('input', () => this.updateExportHint());
        this.exportTo.addEventListener('input', () => this.updateExportHint());
        this.exportPanel.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.doExport();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.toggleExport(false);
                this.grid.focus({ preventScroll: true });
            }
        });
        this.shell.querySelector('#table-export-selection').addEventListener('click', () => this.fillExportFromSelection());
        this.exportGo.addEventListener('click', () => this.doExport());

        // Copy/paste events fire on the document when a non-editable element like the grid has focus.
        document.addEventListener('copy', (event) => {
            if (document.activeElement !== this.grid) return;
            event.preventDefault();
            event.clipboardData.setData('text/plain', this.copyRange());
        });
        document.addEventListener('cut', (event) => {
            if (document.activeElement !== this.grid) return;
            event.preventDefault();
            event.clipboardData.setData('text/plain', this.copyRange());
            this.clearRange();
        });
        document.addEventListener('paste', (event) => {
            if (document.activeElement !== this.grid) return;
            event.preventDefault();
            this.pasteText(event.clipboardData.getData('text/plain'));
        });
    }

    onMouseDown(event) {
        const handle = event.target instanceof Element ? event.target.closest('.table-col-resize') : null;
        if (handle) {
            this.startResize(event, Number(handle.dataset.col));
            return;
        }
        if (event.target === this.editor) return;
        const p = this.pointAt(event.clientX, event.clientY);
        if (!p.inside) return;

        let hit = { type: 'cell', r: p.r, c: p.c };
        if (p.colHeader && p.rowHeader) hit = { type: 'corner' };
        else if (p.colHeader) hit = { type: 'col', c: p.c };
        else if (p.rowHeader) hit = { type: 'row', r: p.r };

        if (event.button !== 0) {
            const { r1, c1, r2, c2 } = this.range();
            const inside = (hit.r ?? r1) >= r1 && (hit.r ?? r1) <= r2 && (hit.c ?? c1) >= c1 && (hit.c ?? c1) <= c2;
            if (!inside) this.select(hit);
            return;
        }

        event.preventDefault();
        this.commitEdit(false);
        this.grid.focus({ preventScroll: true });

        if (event.target === this.fillHandle) {
            this.startDrag('fill', event);
        } else if (hit.type === 'cell' && !event.shiftKey && this.nearSelectionEdge(p)) {
            this.startDrag('move', event);
        } else {
            this.select(hit, event.shiftKey);
            if (hit.type !== 'corner') this.startDrag(hit.type, event);
        }
    }

    onGridKey(event) {
        const ctrl = event.ctrlKey || event.metaKey;
        const key = event.key;
        const lower = key.toLowerCase();
        const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

        if (ctrl && lower === 'z') this.runAction(event.shiftKey ? 'redo' : 'undo');
        else if (ctrl && lower === 'y') this.runAction('redo');
        else if (ctrl && lower === 'a') this.select({ type: 'corner' });
        else if (ctrl && lower === 'd') this.fill(true);
        else if (ctrl && lower === 'r') this.fill(false);
        else if (ctrl && lower === 'e') this.toggleExport(true);
        else if (arrows[key]) this.move(...arrows[key], { extend: event.shiftKey, jump: ctrl });
        else if (key === 'Tab') this.move(0, event.shiftKey ? -1 : 1);
        else if (key === 'Enter' && event.shiftKey) this.move(-1, 0);
        else if (key === 'Enter' || key === 'F2') this.startEdit(null, 'edit');
        else if (key === 'Delete' || key === 'Backspace') this.clearRange();
        else if (key === 'Home') this.move(ctrl ? -this.sel.ar : 0, -this.sel.ac);
        else if (key === 'End') {
            const row = ctrl ? Math.max(0, this.used.rows - 1) : this.sel.ar;
            let col = ctrl ? Math.max(0, this.used.cols - 1) : this.cols - 1;
            if (!ctrl) while (col > 0 && this.cells[row][col] === '') col -= 1;
            this.move(row - this.sel.ar, col - this.sel.ac);
        } else if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) {
            const box = this.activeBox.getBoundingClientRect();
            this.showMenu(box.left, box.bottom);
        } else if (key.length === 1 && !ctrl && !event.altKey) this.startEdit(key, 'enter');
        else return;

        event.preventDefault();
    }

    onEditorKey(event) {
        const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        let step = null;
        if (event.key === 'Enter') step = [event.shiftKey ? -1 : 1, 0];
        else if (event.key === 'Tab') step = [0, event.shiftKey ? -1 : 1];
        // Typing-started edits commit on arrows like spreadsheets; F2/double-click edits move the caret.
        else if (arrows[event.key] && this.editing?.mode === 'enter') step = arrows[event.key];
        else if (event.key === 'Escape') {
            event.preventDefault();
            this.formulaInput.value = this.cells[this.sel.ar][this.sel.ac];
            this.stopEdit();
            return;
        }
        if (!step) return;
        event.preventDefault();
        this.commitEdit();
        this.move(...step);
    }

    /* ---------- public API ---------- */

    renderTab(tab) {
        if (this.editing) this.stopEdit(false);
        this.hideMenu();
        const tabChanged = tab?.id !== this.tabId;
        this.tabId = tab?.id ?? null;

        // Same tab re-render: keep the grown sheet size so the scroll position survives.
        const minRows = tabChanged ? MIN_ROWS : Math.max(MIN_ROWS, this.rows);
        const minCols = tabChanged ? MIN_COLS : Math.max(MIN_COLS, this.cols);
        const content = `${tab?.content || ''}`;
        this.cells = toGrid(content.trim() ? parseDelimited(content) : tab?.table?.cells, minRows, minCols);
        this.widths = Array.isArray(tab?.table?.widths) ? tab.table.widths.slice() : [];
        if (tabChanged) {
            this.sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
            this.grid.scrollTop = 0;
            this.grid.scrollLeft = 0;
            this.toggleExport(false);
        }

        this.values = evaluateSheet(this.cells);
        this.computeUsed();
        this.layout();
        this.growIfNeeded();
        this.clampSelection();
        this.renderWindow(true);
        this.drawSelection();
    }

    // Exports the used area as CSV of what the sheet shows (formula results).
    getExportText() {
        const { rows, cols } = this.used;
        return rows ? this.toDelimited(0, 0, rows - 1, cols - 1, ',') : '';
    }
}
