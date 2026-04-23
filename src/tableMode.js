const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toCellString = (value) => `${value ?? ''}`;

const createCellGrid = (rows, cols) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));

const normalizeTableData = (tableData) => {
    const rowCount = Number.isInteger(tableData?.rows) ? tableData.rows : 0;
    const colCount = Number.isInteger(tableData?.cols) ? tableData.cols : 0;

    const rows = clamp(rowCount || DEFAULT_ROWS, 1, 2000);
    const cols = clamp(colCount || DEFAULT_COLS, 1, 200);

    const inputCells = Array.isArray(tableData?.cells) ? tableData.cells : [];
    const cells = createCellGrid(rows, cols);

    for (let r = 0; r < rows; r += 1) {
        const sourceRow = Array.isArray(inputCells[r]) ? inputCells[r] : [];
        for (let c = 0; c < cols; c += 1) {
            cells[r][c] = toCellString(sourceRow[c]);
        }
    }

    return { rows, cols, cells };
};

const splitRow = (rowText, delimiter) => rowText.split(delimiter).map((part) => part.replace(/\r/g, ''));

const parseTextToTableData = (text) => {
    const normalized = `${text || ''}`.replaceAll('\r\n', '\n');
    if (!normalized.trim()) {
        return normalizeTableData({ rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: [] });
    }

    const lines = normalized.split('\n');
    const useTabs = lines.some((line) => line.includes('\t'));
    const delimiter = useTabs ? '\t' : ',';
    const rowsRaw = lines.map((line) => splitRow(line, delimiter));
    const cols = clamp(Math.max(...rowsRaw.map((row) => row.length), DEFAULT_COLS), 1, 200);
    const rows = clamp(Math.max(rowsRaw.length, DEFAULT_ROWS), 1, 2000);

    const cells = createCellGrid(rows, cols);
    for (let r = 0; r < rowsRaw.length && r < rows; r += 1) {
        for (let c = 0; c < rowsRaw[r].length && c < cols; c += 1) {
            cells[r][c] = toCellString(rowsRaw[r][c]);
        }
    }

    return { rows, cols, cells };
};

const serializeTableToTsv = (tableData) => {
    const normalized = normalizeTableData(tableData);
    const lines = [];

    for (let r = 0; r < normalized.rows; r += 1) {
        let lastNonEmpty = -1;
        for (let c = 0; c < normalized.cols; c += 1) {
            if ((normalized.cells[r][c] || '').length > 0) {
                lastNonEmpty = c;
            }
        }

        if (lastNonEmpty === -1) {
            lines.push('');
            continue;
        }

        const line = normalized.cells[r]
            .slice(0, lastNonEmpty + 1)
            .map((cell) => `${cell || ''}`.replaceAll('\n', ' '))
            .join('\t');
        lines.push(line);
    }

    while (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    return lines.join('\n');
};

const getColumnName = (index) => {
    let n = index + 1;
    let label = '';

    while (n > 0) {
        const remainder = (n - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        n = Math.floor((n - 1) / 26);
    }

    return label;
};

const escapeCellHtml = (value) => `${value || ''}`
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const getCellText = (cell) => (cell?.textContent || '').replace(/\u00a0/g, '');

export class TableModeController {
    constructor({
        shell,
        grid,
        addRowButton,
        addColumnButton,
        onTableChange,
        onStatusChange
    }) {
        this.shell = shell;
        this.grid = grid;
        this.addRowButton = addRowButton;
        this.addColumnButton = addColumnButton;
        this.onTableChange = onTableChange;
        this.onStatusChange = onStatusChange;
        this.state = normalizeTableData(null);
        this.activeCell = { row: 0, col: 0 };
        this.silent = false;

        this.bindEvents();
    }

    bindEvents() {
        this.addRowButton.addEventListener('click', () => {
            this.addRow();
        });

        this.addColumnButton.addEventListener('click', () => {
            this.addColumn();
        });

        this.grid.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;

            const cell = target.closest('.table-cell');
            if (!(cell instanceof HTMLElement)) return;
            this.activateCell(cell);
        });

        this.grid.addEventListener('focusin', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;

            const cell = target.closest('.table-cell');
            if (!(cell instanceof HTMLElement)) return;
            this.activateCell(cell);
        });

        this.grid.addEventListener('input', (event) => {
            if (this.silent) return;

            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const cell = target.closest('.table-cell');
            if (!(cell instanceof HTMLElement)) return;

            const row = Number(cell.dataset.row);
            const col = Number(cell.dataset.col);
            if (!Number.isInteger(row) || !Number.isInteger(col)) return;

            this.state.cells[row][col] = getCellText(cell);
            this.emitChange();
        });

        this.grid.addEventListener('keydown', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const cell = target.closest('.table-cell');
            if (!(cell instanceof HTMLElement)) return;

            const row = Number(cell.dataset.row);
            const col = Number(cell.dataset.col);
            if (!Number.isInteger(row) || !Number.isInteger(col)) return;

            if (event.key === 'Tab') {
                event.preventDefault();
                this.moveToCell(row, col + (event.shiftKey ? -1 : 1));
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                this.moveToCell(row + (event.shiftKey ? -1 : 1), col);
                return;
            }

            if (event.key === 'ArrowUp' && !event.shiftKey) {
                event.preventDefault();
                this.moveToCell(row - 1, col);
                return;
            }

            if (event.key === 'ArrowDown' && !event.shiftKey) {
                event.preventDefault();
                this.moveToCell(row + 1, col);
                return;
            }

            if (event.key === 'ArrowLeft' && !event.shiftKey) {
                const caret = window.getSelection();
                const atStart = !caret || caret.anchorOffset === 0;
                if (atStart) {
                    event.preventDefault();
                    this.moveToCell(row, col - 1);
                }
                return;
            }

            if (event.key === 'ArrowRight' && !event.shiftKey) {
                const caret = window.getSelection();
                const textLen = getCellText(cell).length;
                const atEnd = !caret || caret.anchorOffset >= textLen;
                if (atEnd) {
                    event.preventDefault();
                    this.moveToCell(row, col + 1);
                }
            }
        });

        this.grid.addEventListener('paste', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const cell = target.closest('.table-cell');
            if (!(cell instanceof HTMLElement)) return;

            const row = Number(cell.dataset.row);
            const col = Number(cell.dataset.col);
            if (!Number.isInteger(row) || !Number.isInteger(col)) return;

            const pastedText = event.clipboardData?.getData('text/plain') || '';
            if (!pastedText) return;

            event.preventDefault();

            const parsed = pastedText
                .replaceAll('\r\n', '\n')
                .split('\n')
                .map((line) => line.split('\t'));

            const neededRows = row + parsed.length;
            const neededCols = col + Math.max(...parsed.map((r) => r.length), 1);

            while (this.state.rows < neededRows) {
                this.state.cells.push(Array.from({ length: this.state.cols }, () => ''));
                this.state.rows += 1;
            }

            while (this.state.cols < neededCols) {
                for (let r = 0; r < this.state.rows; r += 1) {
                    this.state.cells[r].push('');
                }
                this.state.cols += 1;
            }

            for (let r = 0; r < parsed.length; r += 1) {
                const line = parsed[r];
                for (let c = 0; c < line.length; c += 1) {
                    this.state.cells[row + r][col + c] = toCellString(line[c]);
                }
            }

            this.renderGrid();
            this.moveToCell(row, col);
            this.emitChange();
        });
    }

    emitStatus() {
        if (typeof this.onStatusChange !== 'function') return;
        this.onStatusChange({
            row: this.activeCell.row + 1,
            col: this.activeCell.col + 1,
            rows: this.state.rows,
            cols: this.state.cols
        });
    }

    emitChange() {
        if (typeof this.onTableChange !== 'function') return;

        const tableData = normalizeTableData(this.state);
        const content = serializeTableToTsv(tableData);
        this.onTableChange({ tableData, content });
    }

    activateCell(cell) {
        const row = Number(cell.dataset.row);
        const col = Number(cell.dataset.col);
        if (!Number.isInteger(row) || !Number.isInteger(col)) return;
        this.activeCell = { row, col };
        this.emitStatus();
    }

    focusCell(row, col) {
        const selector = `.table-cell[data-row="${row}"][data-col="${col}"]`;
        const cell = this.grid.querySelector(selector);
        if (!(cell instanceof HTMLElement)) return;

        this.activeCell = { row, col };
        try {
            cell.focus({ preventScroll: false });
        } catch {
            cell.focus();
        }

        const selection = window.getSelection();
        if (selection) {
            const range = document.createRange();
            range.selectNodeContents(cell);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        this.emitStatus();
    }

    moveToCell(row, col) {
        const nextRow = clamp(row, 0, this.state.rows - 1);
        const nextCol = clamp(col, 0, this.state.cols - 1);
        this.focusCell(nextRow, nextCol);
    }

    addRow() {
        this.state.cells.push(Array.from({ length: this.state.cols }, () => ''));
        this.state.rows += 1;
        this.renderGrid();
        this.emitChange();
    }

    addColumn() {
        for (let r = 0; r < this.state.rows; r += 1) {
            this.state.cells[r].push('');
        }
        this.state.cols += 1;
        this.renderGrid();
        this.emitChange();
    }

    renderGrid() {
        const head = [];
        head.push('<tr><th class="table-corner"></th>');
        for (let c = 0; c < this.state.cols; c += 1) {
            head.push(`<th class="table-col-header">${getColumnName(c)}</th>`);
        }
        head.push('</tr>');

        const body = [];
        for (let r = 0; r < this.state.rows; r += 1) {
            body.push('<tr>');
            body.push(`<th class="table-row-header">${r + 1}</th>`);
            for (let c = 0; c < this.state.cols; c += 1) {
                const cell = escapeCellHtml(this.state.cells[r][c]);
                body.push(
                    `<td class="table-cell" contenteditable="true" spellcheck="false" data-row="${r}" data-col="${c}">${cell}</td>`
                );
            }
            body.push('</tr>');
        }

        this.silent = true;
        this.grid.innerHTML = `
            <table class="table-grid-sheet">
                <thead>${head.join('')}</thead>
                <tbody>${body.join('')}</tbody>
            </table>
        `;
        this.silent = false;
    }

    renderTab(tab) {
        const content = `${tab?.content || ''}`;
        const source = content.trim().length > 0
            ? parseTextToTableData(content)
            : (tab?.table ? normalizeTableData(tab.table) : normalizeTableData(null));

        this.state = source;
        this.renderGrid();

        const nextRow = clamp(this.activeCell.row, 0, this.state.rows - 1);
        const nextCol = clamp(this.activeCell.col, 0, this.state.cols - 1);
        this.activeCell = { row: nextRow, col: nextCol };
        this.emitStatus();
    }

    getExportText() {
        return serializeTableToTsv(this.state);
    }
}
