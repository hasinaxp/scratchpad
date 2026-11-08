// Canvas text view: one layout drives drawing, caret, selection and hit-testing, so nothing can drift.
// The wrapped <textarea> stays invisible: it owns value + selection and takes keys, IME and clipboard.

const TOKEN_KINDS = ['keyword', 'string', 'number', 'comment', 'title', 'link', 'code', 'meta', 'bracket'];
const SIMPLE_LINE = /^[\x20-\x7e]*$/; // printable ASCII without tabs: every char is one monospace cell
const ASCII = /^[\x00-\x7f]*$/;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const SINGLE_ROW = [0];
// Browsers cap element size (Firefox ~17.9M px); bigger documents scroll through a scaled spacer.
const MAX_SCROLL_SIZE = 8_000_000;
// Markdown image with an inline data URL; an optional |width at the end of the alt text sets its size.
const IMAGE_MENTION = /!\[([^\]\n]*)\]\((data:image\/[\w.+-]+;base64,)([A-Za-z0-9+/=]*)\)/g;
const IMAGE_GAP = 6;
const IMAGE_HANDLE = 14;
const IMAGE_MIN_WIDTH = 24;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Calls fn(start, end) per cluster of text[from, to): a code unit for ASCII, a grapheme otherwise.
// fn returning true stops the walk (and makes this return true).
const forEachCluster = (text, from, to, fn) => {
    const slice = text.slice(from, to);
    if (ASCII.test(slice)) {
        for (let i = from; i < to; i += 1) {
            if (fn(i, i + 1) === true) return true;
        }
        return false;
    }
    for (const { index, segment } of segmenter.segment(slice)) {
        if (fn(from + index, from + index + segment.length) === true) return true;
    }
    return false;
};

// forEachCluster, except each atom (a collapsed image payload, offsets relative to base) is one
// unit: fn(start, end, atom).
const forEachUnit = (text, from, to, atoms, base, fn) => {
    if (!atoms) return forEachCluster(text, from, to, fn);
    let pos = from;
    for (const atom of atoms) {
        const start = base + atom.start;
        const end = base + atom.end;
        if (end <= pos || start >= to) continue;
        if (start > pos && forEachCluster(text, pos, start, fn)) return true;
        if (fn(start, end, atom) === true) return true;
        pos = end;
    }
    return pos < to ? forEachCluster(text, pos, to, fn) : false;
};

// Index of the last element <= value in a sorted array.
const lastAtOrBelow = (sorted, value, length = sorted.length) => {
    let low = 0;
    let high = length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (sorted[mid] <= value) low = mid; else high = mid - 1;
    }
    return low;
};

// Chunked compares run natively, so a keystroke in a 10MB document costs a few memcmps, not a JS loop.
export const commonPrefixLength = (a, b) => {
    const max = Math.min(a.length, b.length);
    let i = 0;
    let step = 256;
    while (i < max) {
        const n = Math.min(step, max - i);
        if (a.slice(i, i + n) === b.slice(i, i + n)) {
            i += n;
            step *= 2;
        } else if (n <= 16) {
            while (a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
            return i;
        } else {
            step = n >> 1;
        }
    }
    return i;
};

export const commonSuffixLength = (a, b, max) => {
    let i = 0;
    let step = 256;
    while (i < max) {
        const n = Math.min(step, max - i);
        if (a.slice(a.length - i - n, a.length - i) === b.slice(b.length - i - n, b.length - i)) {
            i += n;
            step *= 2;
        } else if (n <= 16) {
            while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
            return i;
        } else {
            step = n >> 1;
        }
    }
    return i;
};

// Row start columns of one line, wrapping like CSS pre-wrap: break after the last space that fits,
// else mid-word; spaces hang past the edge instead of starting a row.
// cellWidth > 0 means the line is printable ASCII in a monospace font, so rows are found arithmetically.
// atoms (line-relative) are never split.
export const wrapLine = (line, maxWidth, advance, cellWidth = 0, atoms = null) => {
    const rows = [0];

    if (cellWidth > 0) {
        const cols = Math.max(1, Math.floor(maxWidth / cellWidth));
        let rowStart = 0;
        while (line.length - rowStart > cols) {
            const space = line.lastIndexOf(' ', rowStart + cols);
            let breakAt = space >= rowStart ? space + 1 : rowStart + cols;
            while (line.charCodeAt(breakAt) === 32) breakAt += 1;
            if (breakAt >= line.length) break;
            rows.push(breakAt);
            rowStart = breakAt;
        }
        return rows;
    }

    let x = 0;
    let rowStart = 0;
    let lastBreak = -1;
    forEachUnit(line, 0, line.length, atoms, 0, (start, end, atom) => {
        const code = line.charCodeAt(start);
        const blank = !atom && (code === 32 || code === 9);
        if (!blank && start > rowStart && x + advance(line, start, end, x, atom) > maxWidth) {
            rowStart = lastBreak > rowStart ? lastBreak : start;
            rows.push(rowStart);
            lastBreak = -1;
            x = 0;
            forEachUnit(line, rowStart, start, atoms, 0, (s, e, a) => { x += advance(line, s, e, x, a); });
        }
        x += advance(line, start, end, x, atom);
        if (blank) lastBreak = end;
    });
    return rows;
};

export class CanvasTextView {
    constructor(root, { wrap = true } = {}) {
        this.root = root;
        this.input = root.querySelector('textarea');
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'text-view-canvas';
        this.canvas.setAttribute('aria-hidden', 'true');
        this.scroller = document.createElement('div');
        this.scroller.className = 'text-view-scroller';
        this.spacer = document.createElement('div');
        this.spacer.className = 'text-view-spacer';
        this.scroller.append(this.spacer);
        root.prepend(this.canvas, this.scroller);
        this.ctx = this.canvas.getContext('2d');

        this.wrap = wrap;
        this.text = '';
        this.lineStarts = [0];
        this.lineRows = [SINGLE_ROW];
        this.lineWidths = [0];
        this.lineSimple = [true];
        this.lineExtras = [null]; // { atoms, images, imageRows } for lines with inline images
        this.rowPrefix = new Int32Array([0, 1]);
        this.maxLineWidth = 0;
        this.layoutWidth = -1; // wrap width the layout was built for; -1 forces a full layout
        this.dirty = true;

        this.tokenStarts = [];
        this.tokens = [];
        this.goalX = null;
        this.pendingReveal = null;
        this.drawRaf = 0;
        this.caretOn = true;
        this.blinkTimer = 0;
        this.ctrlHeld = false;
        this.images = false;
        this.imageCache = new Map();
        this.hoverImage = null;
        this.resizing = null;
        this.lastCaret = 0;
        this.onLayoutChange = null; // rows changed without a text edit (resize, image load)

        this.advance = this.advance.bind(this);
        this.readStyle();
        this.bindEvents();
    }

    readStyle() {
        const css = window.getComputedStyle(this.root);
        const px = (value) => Number.parseFloat(value) || 0;
        const read = (name) => css.getPropertyValue(name).trim();
        const font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        const lineHeight = px(css.lineHeight) || px(css.fontSize) * 1.35;
        if (font !== this.font || lineHeight !== this.lineHeight) this.layoutWidth = -1;

        this.font = font;
        // Markdown headers and **/* emphasis draw heavier (headers also a bit taller), squeezed back to
        // the normal monospace advance so layout and caret positions don't change.
        this.titleFont = `${css.fontStyle} 700 ${px(css.fontSize) * 1.12}px ${css.fontFamily}`;
        this.boldFont = `${css.fontStyle} 700 ${css.fontSize} ${css.fontFamily}`;
        this.lineHeight = lineHeight;
        this.pad = { top: px(css.paddingTop), right: px(css.paddingRight), bottom: px(css.paddingBottom), left: px(css.paddingLeft) };
        this.tabSize = Number.parseInt(css.tabSize, 10) || 4;
        this.colors = {
            text: css.color,
            caret: css.caretColor && css.caretColor !== 'auto' ? css.caretColor : css.color,
            selection: read('--selection-bg') || 'rgba(72, 112, 168, 0.45)',
            placeholder: read('--placeholder-col') || '#7f7f7f'
        };
        this.tokenColors = new Map(TOKEN_KINDS.map((kind) => [kind, read(`--tok-${kind}`) || css.color]));

        this.ctx.font = font;
        this.widthCache = new Map();
        this.asciiWidths = new Float64Array(128);
        for (let code = 32; code < 127; code += 1) {
            this.asciiWidths[code] = this.ctx.measureText(String.fromCharCode(code)).width;
        }
        this.spaceWidth = this.asciiWidths[32];
        this.tabWidth = this.spaceWidth * this.tabSize;
        const isMonospace = this.asciiWidths.slice(32, 127).every((width) => Math.abs(width - this.spaceWidth) < 0.01);
        this.cellWidth = isMonospace ? this.spaceWidth : 0;
    }

    // Width of the cluster text[start, end) when it begins at x (x matters for tab stops).
    advance(text, start, end, x, atom) {
        if (atom) return atom.width;
        const code = text.charCodeAt(start);
        if (code === 9) return this.tabWidth - (x % this.tabWidth);
        if (end - start === 1 && code < 128) return this.asciiWidths[code];
        const cluster = text.slice(start, end);
        let width = this.widthCache.get(cluster);
        if (width === undefined) {
            width = this.ctx.measureText(cluster).width;
            this.widthCache.set(cluster, width);
        }
        return width;
    }

    // ---- layout ----

    invalidate() {
        this.dirty = true;
        this.scheduleDraw();
    }

    setWrap(enabled) {
        const next = Boolean(enabled);
        if (next === this.wrap) return;
        this.wrap = next;
        this.layoutWidth = -1;
        this.scheduleDraw();
    }

    // Markdown mode: draw inline data-URL images under their mention and collapse the payload.
    setImages(enabled) {
        const next = Boolean(enabled);
        if (next === this.images) return;
        this.images = next;
        this.layoutWidth = -1;
        this.scheduleDraw();
    }

    imageFor(src) {
        const key = `${src.length}:${src.slice(0, 160)}:${src.slice(-160)}`;
        let image = this.imageCache.get(key);
        if (!image) {
            image = new Image();
            image.onload = () => {
                this.layoutWidth = -1;
                this.scheduleDraw();
                this.onLayoutChange?.();
            };
            image.src = src;
            this.imageCache.set(key, image);
        }
        return image;
    }

    parseImages(line) {
        const atoms = [];
        const images = [];
        const maxWidth = Math.max(IMAGE_MIN_WIDTH, this.scroller.clientWidth - this.pad.left - this.pad.right - IMAGE_GAP);
        let height = 0;
        for (const match of line.matchAll(IMAGE_MENTION)) {
            const altStart = match.index + 2;
            const altEnd = altStart + match[1].length;
            const payloadStart = altEnd + 2 + match[2].length;
            const label = `…${Math.max(1, Math.round((match[3].length * 0.75) / 1024))} KB`;
            atoms.push({ start: payloadStart, end: payloadStart + match[3].length, label, width: this.ctx.measureText(label).width });

            const src = match[2] + match[3];
            const element = this.imageFor(src);
            const sizeMatch = /\|\s*(\d+)\s*$/.exec(match[1]);
            const resized = this.resizing?.src === src ? this.resizing.width : 0;
            const wanted = resized || (sizeMatch ? Number(sizeMatch[1]) : element.naturalWidth);
            const width = element.naturalWidth ? Math.max(IMAGE_MIN_WIDTH, Math.min(wanted, maxWidth)) : 0;
            const imageHeight = width ? element.naturalHeight * (width / element.naturalWidth) : 0;
            images.push({ src, element, start: match.index, end: match.index + match[0].length, altStart, altEnd, width, height: imageHeight });
            if (imageHeight) height += imageHeight + IMAGE_GAP;
        }
        if (images.length === 0) return null;
        return { atoms, images, imageRows: height ? Math.ceil((height + IMAGE_GAP) / this.lineHeight) : 0 };
    }

    ensureLayout() {
        const width = this.scroller.clientWidth;
        if (width === 0) return; // hidden: keep the last layout until it is shown again

        const wrapWidth = this.wrap ? Math.max(this.spaceWidth, width - this.pad.left - this.pad.right) : Infinity;
        const full = wrapWidth !== this.layoutWidth;
        if (!full && !this.dirty) return;

        this.layoutWidth = wrapWidth;
        this.dirty = false;
        this.relayout(this.input.value, full);
    }

    measureLine(line) {
        const extra = this.images && line.includes('data:image/') ? this.parseImages(line) : null;
        const atoms = extra?.atoms || null;
        const simple = !extra && this.cellWidth > 0 && SIMPLE_LINE.test(line);
        let width = simple ? line.length * this.cellWidth : 0;
        if (!simple && !this.wrap) {
            forEachUnit(line, 0, line.length, atoms, 0, (start, end, atom) => { width += this.advance(line, start, end, width, atom); });
            for (const image of extra?.images || []) width = Math.max(width, image.width);
        }
        const needsWrap = this.wrap && (!simple || width > this.layoutWidth);
        const rows = needsWrap ? wrapLine(line, this.layoutWidth, this.advance, simple ? this.cellWidth : 0, atoms) : SINGLE_ROW;
        return { simple, width, extra, rows: rows.length === 1 ? SINGLE_ROW : rows };
    }

    // Image rows follow the line's text rows; they belong to the line but carry no line number.
    rowCountOf(line) {
        return this.lineRows[line].length + (this.lineExtras[line]?.imageRows || 0);
    }

    rebuildRows() {
        const count = this.lineStarts.length;
        this.rowPrefix = new Int32Array(count + 1);
        let maxWidth = 0;
        for (let i = 0; i < count; i += 1) {
            this.rowPrefix[i + 1] = this.rowPrefix[i] + this.rowCountOf(i);
            if (this.lineWidths[i] > maxWidth) maxWidth = this.lineWidths[i];
        }
        this.maxLineWidth = maxWidth;
        this.updateSpacer();
    }

    // Re-measures one line in place (live image resize) without touching the rest of the layout.
    remeasureLine(line) {
        const info = this.measureLine(this.text.slice(this.lineStarts[line], this.lineEnd(line)));
        this.lineRows[line] = info.rows;
        this.lineWidths[line] = info.width;
        this.lineSimple[line] = info.simple;
        this.lineExtras[line] = info.extra;
        this.rebuildRows();
        this.scheduleDraw();
        this.onLayoutChange?.();
    }

    // Re-measures only the lines an edit touched; lines after it just shift their start offsets.
    relayout(next, full) {
        const prev = this.text;
        if (!full && next === prev) return;

        let firstLine = 0;
        let lastLine = this.lineStarts.length - 1;
        let to = next.length;
        if (!full) {
            const head = commonPrefixLength(prev, next);
            const tail = commonSuffixLength(prev, next, Math.min(prev.length, next.length) - head);
            firstLine = lastAtOrBelow(this.lineStarts, head);
            lastLine = lastAtOrBelow(this.lineStarts, prev.length - tail);
            const oldEnd = lastLine + 1 < this.lineStarts.length ? this.lineStarts[lastLine + 1] - 1 : prev.length;
            to = oldEnd + (next.length - prev.length);
        }

        const starts = [];
        const rows = [];
        const widths = [];
        const simple = [];
        const extras = [];
        let start = full ? 0 : this.lineStarts[firstLine];
        for (;;) {
            const newline = next.indexOf('\n', start);
            const end = newline === -1 || newline >= to ? to : newline;
            const info = this.measureLine(next.slice(start, end));
            starts.push(start);
            rows.push(info.rows);
            widths.push(info.width);
            simple.push(info.simple);
            extras.push(info.extra);
            if (end >= to) break;
            start = end + 1;
        }

        const removed = lastLine - firstLine + 1;
        const splice = (list, items) => list.slice(0, firstLine).concat(items, list.slice(firstLine + removed));
        const delta = next.length - prev.length;
        this.lineStarts = splice(this.lineStarts, starts);
        for (let i = firstLine + starts.length; i < this.lineStarts.length; i += 1) this.lineStarts[i] += delta;
        this.lineRows = splice(this.lineRows, rows);
        this.lineWidths = splice(this.lineWidths, widths);
        this.lineSimple = splice(this.lineSimple, simple);
        this.lineExtras = splice(this.lineExtras, extras);
        this.text = next;
        this.rebuildRows();
    }

    get totalRows() {
        return this.rowPrefix[this.rowPrefix.length - 1];
    }

    contentSize() {
        return {
            width: this.wrap ? 0 : this.pad.left + this.maxLineWidth + this.spaceWidth + this.pad.right,
            height: this.pad.top + (this.totalRows * this.lineHeight) + this.pad.bottom
        };
    }

    updateSpacer() {
        const { width, height } = this.contentSize();
        this.spacer.style.width = `${Math.min(width, MAX_SCROLL_SIZE)}px`;
        this.spacer.style.height = `${Math.min(height, MAX_SCROLL_SIZE)}px`;
    }

    // Content pixels per scroller pixel along one axis; 1 unless the spacer had to be capped.
    scrollRatio(content, viewport) {
        return content > MAX_SCROLL_SIZE ? (content - viewport) / (MAX_SCROLL_SIZE - viewport) : 1;
    }

    getScrollY() {
        return this.scroller.scrollTop * this.scrollRatio(this.contentSize().height, this.scroller.clientHeight);
    }

    getScrollX() {
        return this.scroller.scrollLeft * this.scrollRatio(this.contentSize().width, this.scroller.clientWidth);
    }

    scrollTo(y, x = this.getScrollX()) {
        this.ensureLayout();
        const { width, height } = this.contentSize();
        this.scroller.scrollTop = y / this.scrollRatio(height, this.scroller.clientHeight);
        this.scroller.scrollLeft = x / this.scrollRatio(width, this.scroller.clientWidth);
        this.scheduleDraw();
    }

    lineEnd(line) {
        return line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] - 1 : this.text.length;
    }

    // Text bounds of a row; image rows map to the line's last text row.
    rowBounds(line, index) {
        const lineStart = this.lineStarts[line];
        const rows = this.lineRows[line];
        const row = Math.min(index, rows.length - 1);
        const to = row + 1 < rows.length ? lineStart + rows[row + 1] : this.lineEnd(line);
        return [lineStart + rows[row], to];
    }

    // Walks text[from, to) of a line unit by unit (see forEachUnit).
    walk(line, from, to, fn) {
        return forEachUnit(this.text, from, to, this.lineExtras[line]?.atoms || null, this.lineStarts[line], fn);
    }

    atomAt(offset) {
        const line = lastAtOrBelow(this.lineStarts, offset);
        const local = offset - this.lineStarts[line];
        const atom = this.lineExtras[line]?.atoms.find((candidate) => candidate.start < local && local < candidate.end);
        return atom ? { start: this.lineStarts[line] + atom.start, end: this.lineStarts[line] + atom.end } : null;
    }

    // Content-space rectangles of a line's images, top to bottom under its text rows.
    imageRects(line) {
        const extra = this.lineExtras[line];
        if (!extra) return [];
        let y = this.pad.top + ((this.rowPrefix[line] + this.lineRows[line].length) * this.lineHeight) + IMAGE_GAP;
        const rects = [];
        for (const image of extra.images) {
            if (!image.height) continue;
            rects.push({ image, line, x: this.pad.left, y, w: image.width, h: image.height });
            y += image.height + IMAGE_GAP;
        }
        return rects;
    }

    lineOfRow(row) {
        return lastAtOrBelow(this.rowPrefix, row, this.rowPrefix.length - 1);
    }

    // x of offset within the row that starts at rowFrom, relative to the text's left edge.
    xAt(line, rowFrom, offset) {
        if (this.lineSimple[line]) return (offset - rowFrom) * this.cellWidth;
        let x = 0;
        this.walk(line, rowFrom, offset, (start, end, atom) => { x += this.advance(this.text, start, end, x, atom); });
        return x;
    }

    // { row, x, y } of a caret at offset, in content pixels without padding.
    caretPoint(offset) {
        const line = lastAtOrBelow(this.lineStarts, offset);
        const lineStart = this.lineStarts[line];
        const index = lastAtOrBelow(this.lineRows[line], offset - lineStart);
        const row = this.rowPrefix[line] + index;
        return { row, x: this.xAt(line, lineStart + this.lineRows[line][index], offset), y: row * this.lineHeight };
    }

    offsetAtRow(row, x) {
        const line = this.lineOfRow(row);
        const index = Math.min(row - this.rowPrefix[line], this.lineRows[line].length - 1);
        const [from, to] = this.rowBounds(line, index);
        const isLast = index === this.lineRows[line].length - 1;

        // A click past the end of a wrapped row lands before its last char, not on the next row.
        if (this.lineSimple[line]) {
            const offset = Math.min(to, from + Math.round(Math.max(0, x) / this.cellWidth));
            return !isLast && offset === to && to > from ? to - 1 : offset;
        }

        let cx = 0;
        let lastStart = from;
        let hit = -1;
        this.walk(line, from, to, (start, end, atom) => {
            const width = this.advance(this.text, start, end, cx, atom);
            if (x < cx + (width / 2)) {
                hit = start;
                return true;
            }
            cx += width;
            lastStart = start;
            return false;
        });
        if (hit >= 0) return hit;
        return isLast ? to : lastStart;
    }

    hitTest(clientX, clientY) {
        this.ensureLayout();
        const rect = this.scroller.getBoundingClientRect();
        const x = clientX - rect.left + this.getScrollX() - this.pad.left;
        const y = clientY - rect.top + this.getScrollY() - this.pad.top;
        const row = Math.min(this.totalRows - 1, Math.max(0, Math.floor(y / this.lineHeight)));
        return this.offsetAtRow(row, x);
    }

    // For the line-number gutter: the same rows the canvas draws.
    getMetrics() {
        this.ensureLayout();
        return {
            rowPrefix: this.rowPrefix,
            lineHeight: this.lineHeight,
            padTop: this.pad.top,
            scrollY: this.getScrollY(),
            viewportHeight: this.scroller.clientHeight
        };
    }

    getVisibleRange() {
        this.ensureLayout();
        const top = this.getScrollY() - this.pad.top;
        const firstRow = Math.min(this.totalRows - 1, Math.max(0, Math.floor(top / this.lineHeight)));
        const lastRow = Math.min(this.totalRows - 1, Math.floor((top + this.scroller.clientHeight) / this.lineHeight));
        const firstLine = this.lineOfRow(firstRow);
        const lastLine = this.lineOfRow(lastRow);
        return [this.rowBounds(firstLine, firstRow - this.rowPrefix[firstLine])[0], this.rowBounds(lastLine, lastRow - this.rowPrefix[lastLine])[1]];
    }

    // ---- tokens ----

    // tokens from highlightTokens(); base is the offset of the first token (windowed highlighting).
    setTokens(tokens, base = 0) {
        const starts = [];
        const list = [];
        let offset = base;
        for (const token of tokens) {
            if (token.kind || token.url || token.bold) {
                starts.push(offset);
                list.push({ start: offset, end: offset + token.text.length, kind: token.kind, url: token.url, bold: token.bold });
            }
            offset += token.text.length;
        }
        this.tokenStarts = starts;
        this.tokens = list;
        this.tokenRange = [base, offset];
        this.scheduleDraw();
    }

    tokenAt(offset) {
        if (this.tokens.length === 0) return null;
        const token = this.tokens[lastAtOrBelow(this.tokenStarts, offset)];
        return token.start <= offset && offset < token.end ? token : null;
    }

    colorOf(token) {
        return (token?.kind && this.tokenColors.get(token.kind)) || this.colors.text;
    }

    // ---- drawing ----

    scheduleDraw() {
        if (this.drawRaf) return;
        this.drawRaf = window.requestAnimationFrame(() => this.draw());
    }

    revealOffset(offset, center = false) {
        this.pendingReveal = { offset, center };
        this.scheduleDraw();
    }

    caretOffset() {
        const { selectionStart, selectionEnd, selectionDirection } = this.input;
        return selectionDirection === 'backward' ? selectionStart : selectionEnd;
    }

    applyReveal(width, height) {
        const { offset, center } = this.pendingReveal;
        this.pendingReveal = null;
        const point = this.caretPoint(Math.min(offset, this.text.length));
        const y = this.pad.top + point.y;
        const x = this.pad.left + point.x;
        let top = this.getScrollY();
        let left = this.getScrollX();

        if (center) {
            top = y - (height * 0.35);
        } else if (y - this.pad.top < top) {
            top = y - this.pad.top;
        } else if (y + this.lineHeight + this.pad.bottom > top + height) {
            top = y + this.lineHeight + this.pad.bottom - height;
        }

        if (!this.wrap) {
            const margin = this.spaceWidth * 4;
            if (x - margin < left) left = Math.max(0, x - margin - this.pad.left);
            else if (x + margin > left + width) left = x + margin - width;
        }
        this.scrollTo(Math.max(0, top), left);
    }

    draw() {
        this.drawRaf = 0;
        const { canvas, scroller, ctx } = this;
        const width = scroller.clientWidth;
        const height = scroller.clientHeight;
        if (!width || !height) return;

        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = this.font;
        ctx.textBaseline = 'middle';

        this.ensureLayout();
        if (this.pendingReveal) this.applyReveal(width, height);
        ctx.clearRect(0, 0, width, height);

        const lh = this.lineHeight;
        const top = this.getScrollY();
        const left = this.getScrollX();
        const originX = this.pad.left - left;
        const { selectionStart, selectionEnd } = this.input;

        if (!this.text && this.input.placeholder) {
            ctx.fillStyle = this.colors.placeholder;
            ctx.fillText(this.input.placeholder, originX, this.pad.top - top + (lh / 2));
        }

        const firstRow = Math.max(0, Math.floor((top - this.pad.top) / lh));
        const lastRow = Math.min(this.totalRows - 1, Math.floor((top + height - this.pad.top) / lh));
        let line = this.lineOfRow(Math.min(firstRow, this.totalRows - 1));
        let imageLine = -1;
        for (let row = firstRow; row <= lastRow; row += 1) {
            while (this.rowPrefix[line + 1] <= row) line += 1;
            const index = row - this.rowPrefix[line];
            if (this.lineExtras[line] && imageLine !== line) {
                imageLine = line;
                this.drawImages(line, left, top);
            }
            if (index >= this.lineRows[line].length) continue;
            const [from, to] = this.rowBounds(line, index);
            const isLast = index === this.lineRows[line].length - 1;
            const y = this.pad.top + (row * lh) - top;
            this.drawSelection(line, from, to, isLast, originX, y, selectionStart, selectionEnd);
            this.drawRowText(line, from, to, originX, y, left - this.pad.left, width);
        }

        // The hidden textarea follows the caret so IME candidate windows open in the right place.
        const caret = this.caretPoint(Math.min(this.caretOffset(), this.text.length));
        const caretX = originX + caret.x;
        const caretY = this.pad.top + caret.y - top;
        this.input.style.transform = `translate(${Math.min(Math.max(0, caretX), width - 1)}px, ${Math.min(Math.max(0, caretY), height - lh)}px)`;
        if (document.activeElement === this.input && this.caretOn && selectionStart === selectionEnd) {
            ctx.fillStyle = this.colors.caret;
            ctx.fillRect(Math.round(caretX), caretY, 1.5, lh);
        }
    }

    drawSelection(line, from, to, isLast, originX, y, selStart, selEnd) {
        const rowEnd = isLast ? to + 1 : to; // the newline belongs to the last row
        if (selStart === selEnd || selEnd <= from || selStart >= rowEnd) return;
        const a = Math.max(selStart, from);
        const b = Math.min(selEnd, to);
        const xa = this.xAt(line, from, a);
        let xb = this.xAt(line, from, b);
        if (isLast && selEnd > to) xb += this.spaceWidth;
        this.ctx.fillStyle = this.colors.selection;
        this.ctx.fillRect(originX + xa, y, xb - xa, this.lineHeight);
    }

    drawImages(line, left, top) {
        const { ctx } = this;
        ctx.imageSmoothingQuality = 'high';
        for (const rect of this.imageRects(line)) {
            const x = rect.x - left;
            const y = rect.y - top;
            ctx.drawImage(rect.image.element, x, y, rect.w, rect.h);
            if (this.hoverImage !== rect.image.src && this.resizing?.src !== rect.image.src) continue;
            ctx.strokeStyle = this.tokenColors.get('bracket');
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, rect.w - 1, rect.h - 1);
            ctx.fillStyle = this.tokenColors.get('bracket');
            ctx.fillRect(x + rect.w - (IMAGE_HANDLE / 2), y + rect.h - (IMAGE_HANDLE / 2), IMAGE_HANDLE / 2, IMAGE_HANDLE / 2);
        }
    }

    // Draws text[from, to) as runs of same-coloured ASCII; other clusters are drawn one by one at
    // their measured x so glyphs and caret positions agree. Only the horizontally visible part is walked.
    drawRowText(line, from, to, originX, y, visibleLeft, visibleWidth) {
        const { ctx, text } = this;
        const midY = y + (this.lineHeight / 2);
        const rightLimit = visibleLeft + visibleWidth;
        let start = from;
        let x = 0;
        if (this.lineSimple[line]) {
            const skip = Math.max(0, Math.floor(visibleLeft / this.cellWidth) - 1);
            start = Math.min(to, from + skip);
            x = (start - from) * this.cellWidth;
        }

        let runStart = start;
        let runX = x;
        let runToken = null;
        let last = start;
        const flush = (end, endX) => {
            if (end <= runStart || endX < visibleLeft) return;
            ctx.fillStyle = this.colorOf(runToken);
            const styledFont = runToken?.kind === 'title' ? this.titleFont : (runToken?.bold ? this.boldFont : null);
            if (styledFont) {
                ctx.font = styledFont;
                ctx.fillText(text.slice(runStart, end), originX + runX, midY, endX - runX);
                ctx.font = this.font;
            } else {
                ctx.fillText(text.slice(runStart, end), originX + runX, midY);
            }
            if (runToken?.url && this.ctrlHeld) {
                ctx.fillRect(originX + runX, y + this.lineHeight - 3, endX - runX, 1);
            }
        };

        this.walk(line, start, to, (s, e, atom) => {
            if (x > rightLimit) return true;
            if (atom) {
                flush(s, x);
                ctx.fillStyle = this.colors.placeholder;
                ctx.fillText(atom.label, originX + x, midY);
                x += atom.width;
                runStart = e;
                runX = x;
                last = e;
                return false;
            }
            const token = this.tokenAt(s);
            const code = text.charCodeAt(s);
            const plain = e - s === 1 && code >= 32 && code < 127;
            if (!plain || token !== runToken) {
                flush(s, x);
                runStart = s;
                runX = x;
                runToken = token;
            }
            x += this.advance(text, s, e, x);
            if (!plain) {
                if (code !== 9) flush(e, x);
                runStart = e;
                runX = x;
            }
            last = e;
            return false;
        });
        flush(last, x);
    }

    restartBlink() {
        this.caretOn = true;
        window.clearInterval(this.blinkTimer);
        this.blinkTimer = window.setInterval(() => {
            if (document.activeElement !== this.input) return;
            this.caretOn = !this.caretOn;
            this.scheduleDraw();
        }, 530);
        this.scheduleDraw();
    }

    // ---- input ----

    select(anchor, focus) {
        this.input.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? 'backward' : 'forward');
        this.restartBlink();
    }

    moveVertically(rows, extend) {
        this.ensureLayout();
        const { selectionStart, selectionEnd } = this.input;
        const focus = this.caretOffset();
        const anchor = focus === selectionStart ? selectionEnd : selectionStart;
        const point = this.caretPoint(focus);
        const x = this.goalX ?? point.x;
        let target = point.row + rows;
        if (target >= 0 && target < this.totalRows) {
            // Image rows hold no text: step over them to the next line, or back onto the mention line.
            const line = this.lineOfRow(target);
            const textRows = this.lineRows[line].length;
            if (target - this.rowPrefix[line] >= textRows) {
                target = rows > 0 ? this.rowPrefix[line + 1] : this.rowPrefix[line] + textRows - 1;
            }
        }

        let offset = 0;
        if (target >= this.totalRows) offset = this.text.length;
        else if (target >= 0) offset = this.offsetAtRow(target, x);

        this.select(extend ? anchor : offset, offset);
        this.goalX = x;
        this.revealOffset(offset);
    }

    onKeyDown(event) {
        const page = Math.max(1, Math.floor(this.scroller.clientHeight / this.lineHeight) - 1);
        const rows = { ArrowUp: -1, ArrowDown: 1, PageUp: -page, PageDown: page }[event.key];
        if (rows && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            this.moveVertically(rows, event.shiftKey);
            return;
        }

        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
        if (this.guardKey(event)) return;
        this.goalX = null;
        const before = `${this.input.selectionStart}:${this.input.selectionEnd}`;
        window.requestAnimationFrame(() => {
            if (`${this.input.selectionStart}:${this.input.selectionEnd}` !== before) this.revealOffset(this.caretOffset());
        });
    }

    wordAt(offset) {
        const { text } = this;
        let start = offset;
        let end = offset;
        while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
        while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
        return start === end ? [offset, Math.min(text.length, offset + 1)] : [start, end];
    }

    lineRangeAt(offset) {
        const start = this.text.lastIndexOf('\n', offset - 1) + 1;
        const newline = this.text.indexOf('\n', offset);
        return [start, newline === -1 ? this.text.length : newline + 1];
    }

    openLinkAt(offset) {
        const token = this.tokenAt(offset);
        if (!token?.url) return false;
        window.open(this.text.slice(token.start, token.end), '_blank', 'noopener,noreferrer');
        return true;
    }

    // The image rect under the pointer (content space), with handle=true on its resize corner.
    imageAt(clientX, clientY) {
        if (!this.images) return null;
        this.ensureLayout();
        const rect = this.scroller.getBoundingClientRect();
        const x = clientX - rect.left + this.getScrollX();
        const y = clientY - rect.top + this.getScrollY();
        const row = Math.floor((y - this.pad.top) / this.lineHeight);
        if (row < 0 || row >= this.totalRows) return null;
        const hit = this.imageRects(this.lineOfRow(row)).find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
        if (!hit) return null;
        return { ...hit, handle: x >= hit.x + hit.w - IMAGE_HANDLE && y >= hit.y + hit.h - IMAGE_HANDLE };
    }

    // Live-resizes from the corner, then writes the width into the alt text as |N (one undo step).
    startImageResize(hit, event) {
        const startX = event.clientX;
        const onMove = (moveEvent) => {
            const width = Math.max(IMAGE_MIN_WIDTH, Math.round(hit.w + moveEvent.clientX - startX));
            this.resizing = { src: hit.image.src, width };
            this.remeasureLine(hit.line);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const width = this.resizing?.width;
            this.resizing = null;
            if (!width) return;
            const base = this.lineStarts[hit.line];
            const alt = this.text.slice(base + hit.image.altStart, base + hit.image.altEnd);
            const nextAlt = `${alt.replace(/\s*\|\s*\d+\s*$/, '')}|${width}`;
            this.input.setRangeText(nextAlt, base + hit.image.altStart, base + hit.image.altEnd, 'preserve');
            this.input.dispatchEvent(new Event('input', { bubbles: true }));
            this.pendingReveal = null; // a resize shouldn't scroll back to the caret
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    // An image mention is one object: only its alt text is editable. Everything else (`![`, `](data:…)`)
    // can be deleted only as a whole. For an edit of [from, to) (from === to: an insertion) returns
    // null when it's free, 'blocked' for an insertion into the structure, or the range widened to
    // cover every mention whose structure it touches.
    guardEdit(from, to) {
        if (!this.images) return null;
        this.ensureLayout();
        let [low, high] = [from, to];
        const last = lastAtOrBelow(this.lineStarts, Math.max(from, to - 1));
        for (let line = lastAtOrBelow(this.lineStarts, from); line <= last; line += 1) {
            const base = this.lineStarts[line];
            for (const image of this.lineExtras[line]?.images || []) {
                const [start, altStart, altEnd, end] = [image.start, image.altStart, image.altEnd, image.end].map((at) => base + at);
                if (from === to) {
                    if ((start < from && from < altStart) || (altEnd < from && from < end)) return 'blocked';
                } else if ((from < altStart && to > start) || (from < end && to > altEnd)) {
                    low = Math.min(low, start);
                    high = Math.max(high, end);
                }
            }
        }
        return low === from && high === to ? null : [low, high];
    }

    // Keys run before the editor controller's own handlers (auto-indent, pairs), so guard them here:
    // widen the selection over whole mentions and let the key proceed, or swallow it.
    guardKey(event) {
        const { key } = event;
        const deleting = key === 'Backspace' || key === 'Delete';
        if (!deleting && key !== 'Enter' && key !== 'Tab' && (key.length !== 1 || event.ctrlKey || event.metaKey)) return false;
        const { selectionStart, selectionEnd } = this.input;
        let [from, to] = [selectionStart, selectionEnd];
        if (from === to && deleting) [from, to] = key === 'Backspace' ? [from - 1, from] : [from, from + 1];
        if (from < 0 || (key === 'Tab' && from !== to)) return false; // Tab on a selection indents lines
        const guard = this.guardEdit(from, to);
        if (!guard) return false;
        if (guard === 'blocked') {
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
        }
        this.select(guard[0], guard[1]);
        return false;
    }

    // The caret never rests inside a collapsed image payload: it jumps to the side it was heading.
    snapOutOfAtoms() {
        const caret = this.caretOffset();
        const atom = this.atomAt(caret);
        if (atom) {
            const target = caret > this.lastCaret ? atom.end : atom.start;
            const { selectionStart, selectionEnd } = this.input;
            if (selectionStart === selectionEnd) this.select(target, target);
            else this.select(caret === selectionStart ? selectionEnd : selectionStart, target);
            return;
        }
        this.lastCaret = caret;
    }

    onMouseDown(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        this.input.focus({ preventScroll: true });
        this.goalX = null;

        const image = this.input.readOnly ? null : this.imageAt(event.clientX, event.clientY);
        if (image?.handle) {
            this.startImageResize(image, event);
            return;
        }
        // Clicking an image selects its whole mention, so Backspace/Delete/typing replace it as one object.
        if (image && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            const base = this.lineStarts[image.line];
            this.select(base + image.image.start, base + image.image.end);
            return;
        }

        const offset = this.hitTest(event.clientX, event.clientY);
        if ((event.ctrlKey || event.metaKey) && this.openLinkAt(offset)) return;

        // Word/line clicks keep their whole unit while dragging; plain clicks drag from a fixed anchor.
        let [low, high] = [offset, offset];
        if (event.detail === 2) [low, high] = this.wordAt(offset);
        else if (event.detail >= 3) [low, high] = this.lineRangeAt(offset);
        else if (event.shiftKey) {
            const { selectionStart, selectionEnd } = this.input;
            low = this.caretOffset() === selectionStart ? selectionEnd : selectionStart;
            high = low;
        }
        this.select(low, event.detail >= 2 ? high : offset);

        let pointer = event;
        const update = () => {
            const at = this.hitTest(pointer.clientX, pointer.clientY);
            if (at < low) this.select(high, at);
            else this.select(low, Math.max(high, at));
            this.revealOffset(at);
        };
        // Keeps extending the selection while the pointer is held outside the view.
        let frame = 0;
        const tick = () => {
            const rect = this.scroller.getBoundingClientRect();
            const outside = pointer.clientY < rect.top || pointer.clientY > rect.bottom
                || pointer.clientX < rect.left || pointer.clientX > rect.right;
            if (outside) update();
            frame = window.requestAnimationFrame(tick);
        };
        const onMove = (moveEvent) => {
            pointer = moveEvent;
            update();
        };
        const onUp = () => {
            window.cancelAnimationFrame(frame);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.input.dispatchEvent(new Event('select'));
        };
        frame = window.requestAnimationFrame(tick);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    setCtrlHeld(held) {
        if (held === this.ctrlHeld) return;
        this.ctrlHeld = held;
        if (!held) this.scroller.style.cursor = '';
        if (this.tokens.some((token) => token.url)) this.scheduleDraw();
    }

    bindEvents() {
        const { input, scroller } = this;
        input.addEventListener('input', () => {
            this.invalidate();
            this.revealOffset(this.caretOffset());
        });
        input.addEventListener('keydown', (event) => this.onKeyDown(event));
        // Paste, cut, drop and IME edits that keydown can't see: same guard, applied by hand.
        input.addEventListener('beforeinput', (event) => {
            let { selectionStart: from, selectionEnd: to } = input;
            if (from === to && event.inputType.startsWith('deleteContentBackward')) from -= 1;
            else if (from === to && event.inputType.startsWith('delete')) to += 1;
            const guard = from < 0 ? null : this.guardEdit(from, to);
            if (!guard) return;
            event.preventDefault();
            if (guard === 'blocked') return;
            const data = event.inputType.startsWith('delete') ? '' : (event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
            input.setRangeText(data, guard[0], guard[1], 'end');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        input.addEventListener('focus', () => this.restartBlink());
        input.addEventListener('blur', () => {
            window.clearInterval(this.blinkTimer);
            this.scheduleDraw();
        });
        document.addEventListener('selectionchange', () => {
            if (document.activeElement === input && !this.dirty) this.snapOutOfAtoms();
            this.scheduleDraw();
        });

        scroller.addEventListener('mousedown', (event) => this.onMouseDown(event));
        scroller.addEventListener('mousemove', (event) => {
            if (event.buttons) return;
            const image = this.imageAt(event.clientX, event.clientY);
            if ((image?.image.src || null) !== this.hoverImage) {
                this.hoverImage = image?.image.src || null;
                this.scheduleDraw();
            }
            const token = this.ctrlHeld ? this.tokenAt(this.hitTest(event.clientX, event.clientY)) : null;
            scroller.style.cursor = image?.handle ? 'nwse-resize' : (token?.url ? 'pointer' : '');
        });
        scroller.addEventListener('mouseleave', () => {
            if (!this.hoverImage) return;
            this.hoverImage = null;
            this.scheduleDraw();
        });
        scroller.addEventListener('scroll', () => this.scheduleDraw());

        new ResizeObserver(() => {
            this.readStyle();
            this.scheduleDraw();
            this.onLayoutChange?.();
        }).observe(scroller);

        window.addEventListener('keydown', (event) => this.setCtrlHeld(event.ctrlKey || event.metaKey));
        window.addEventListener('keyup', (event) => this.setCtrlHeld(event.ctrlKey || event.metaKey));
        window.addEventListener('blur', () => this.setCtrlHeld(false));
    }
}
