export class CellError {
    constructor(code) {
        this.code = code;
    }
}

const fail = (code) => {
    throw new CellError(code);
};

export const colName = (index) => {
    let n = index + 1;
    let label = '';
    while (n > 0) {
        const remainder = (n - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        n = Math.floor((n - 1) / 26);
    }
    return label;
};

const colIndex = (letters) => [...letters.toUpperCase()].reduce((n, ch) => (n * 26) + ch.charCodeAt(0) - 64, 0) - 1;

const REF = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;

const parseRef = (text) => {
    const m = REF.exec(text);
    return { absCol: !!m[1], col: colIndex(m[2]), absRow: !!m[3], row: Number(m[4]) - 1 };
};

const formatRef = ({ row, col, absRow, absCol }) => `${absCol ? '$' : ''}${colName(col)}${absRow ? '$' : ''}${row + 1}`;

export const formatValue = (value) => {
    if (value instanceof CellError) return value.code;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return `${Number.isInteger(value) ? value : +value.toPrecision(10)}`;
    return `${value ?? ''}`;
};

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export const parseLiteral = (raw) => {
    const text = `${raw ?? ''}`;
    return NUMBER.test(text.trim()) ? Number(text) : text;
};

// The ref alternative refuses a trailing "(" so names like LOG10( stay function names.
const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|"((?:[^"]|"")*)"|(\$?[A-Za-z]{1,3}\$?\d+)(?![A-Za-z0-9_(])|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|<>|[-+*/^&=<>(),:%]))/y;

const tokenize = (src) => {
    // References to deleted cells are written back as #REF! by transformRefs.
    if (src.includes('#REF!')) fail('#REF!');
    const tokens = [];
    TOKEN.lastIndex = 0;
    while (src.slice(TOKEN.lastIndex).trim()) {
        const m = TOKEN.exec(src);
        if (!m) fail('#ERROR!');
        if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
        else if (m[2] !== undefined) tokens.push({ t: 'str', v: m[2].replaceAll('""', '"') });
        else if (m[3] !== undefined) tokens.push({ t: 'ref', v: parseRef(m[3]) });
        else if (m[4] !== undefined) tokens.push({ t: 'id', v: m[4].toUpperCase() });
        else tokens.push({ t: 'op', v: m[5] });
    }
    return tokens;
};

const parse = (src) => {
    const tokens = tokenize(src);
    let i = 0;
    const isOp = (v) => tokens[i]?.t === 'op' && tokens[i].v === v;
    const expect = (v) => {
        if (!isOp(v)) fail('#ERROR!');
        i += 1;
    };
    const binary = (next, ops) => () => {
        let node = next();
        while (tokens[i]?.t === 'op' && ops.includes(tokens[i].v)) {
            const op = tokens[i].v;
            i += 1;
            node = { k: 'bin', op, a: node, b: next() };
        }
        return node;
    };

    const primary = () => {
        const tok = tokens[i];
        i += 1;
        if (!tok) fail('#ERROR!');
        if (tok.t === 'num' || tok.t === 'str') return { k: 'val', v: tok.v };
        if (tok.t === 'ref') {
            if (!isOp(':')) return { k: 'ref', a: tok.v };
            i += 1;
            const end = tokens[i];
            i += 1;
            if (end?.t !== 'ref') fail('#ERROR!');
            return { k: 'range', a: tok.v, b: end.v };
        }
        if (tok.t === 'id') {
            if (tok.v === 'TRUE' || tok.v === 'FALSE') return { k: 'val', v: tok.v === 'TRUE' };
            expect('(');
            const args = [];
            if (!isOp(')')) {
                args.push(comparison());
                while (isOp(',')) {
                    i += 1;
                    args.push(comparison());
                }
            }
            expect(')');
            return { k: 'fn', name: tok.v, args };
        }
        if (tok.v === '(') {
            const node = comparison();
            expect(')');
            return node;
        }
        if (tok.v === '-') return { k: 'neg', a: postfix() };
        if (tok.v === '+') return postfix();
        return fail('#ERROR!');
    };

    const postfix = () => {
        let node = primary();
        while (isOp('%')) {
            i += 1;
            node = { k: 'pct', a: node };
        }
        return node;
    };
    const power = binary(postfix, ['^']);
    const product = binary(power, ['*', '/']);
    const sum = binary(product, ['+', '-']);
    const concat = binary(sum, ['&']);
    const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);

    const root = comparison();
    if (i < tokens.length) fail('#ERROR!');
    return root;
};

const toNumber = (value) => {
    if (value instanceof CellError) throw value;
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return Number(value);
    if (value === '') return 0;
    return NUMBER.test(value.trim()) ? Number(value) : fail('#VALUE!');
};

const toText = (value) => {
    if (value instanceof CellError) throw value;
    return formatValue(value);
};

const toBool = (value) => {
    if (typeof value === 'string' && value !== '' && !NUMBER.test(value.trim())) {
        const upper = value.toUpperCase();
        return upper === 'TRUE' ? true : (upper === 'FALSE' ? false : fail('#VALUE!'));
    }
    return toNumber(value) !== 0;
};

const compare = (a, b) => {
    if (a instanceof CellError) throw a;
    if (b instanceof CellError) throw b;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return toText(a).toLowerCase().localeCompare(toText(b).toLowerCase());
};

const evaluate = (node, get) => {
    const scalar = (arg) => {
        if (!arg) fail('#N/A');
        if (arg.k === 'range') fail('#VALUE!');
        return evaluate(arg, get);
    };
    const rangeValues = ({ a, b }) => {
        const out = [];
        for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r += 1) {
            for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c += 1) {
                out.push(get(r, c));
            }
        }
        return out;
    };
    const allValues = (args) => args.flatMap((arg) => (arg.k === 'range' ? rangeValues(arg) : [evaluate(arg, get)]));
    // Like spreadsheets: direct args are coerced, text and blanks inside ranges are skipped.
    const numbers = (args) => args.flatMap((arg) => {
        if (arg.k !== 'range') return [toNumber(evaluate(arg, get))];
        return rangeValues(arg).filter((v) => {
            if (v instanceof CellError) throw v;
            return typeof v === 'number';
        });
    });
    const total = (list) => list.reduce((acc, v) => acc + v, 0);

    switch (node.k) {
    case 'val': return node.v;
    case 'ref': return get(node.a.row, node.a.col);
    case 'range': return fail('#VALUE!');
    case 'neg': return -toNumber(scalar(node.a));
    case 'pct': return toNumber(scalar(node.a)) / 100;
    case 'bin': {
        const a = scalar(node.a);
        const b = scalar(node.b);
        switch (node.op) {
        case '+': return toNumber(a) + toNumber(b);
        case '-': return toNumber(a) - toNumber(b);
        case '*': return toNumber(a) * toNumber(b);
        case '/': return toNumber(b) === 0 ? fail('#DIV/0!') : toNumber(a) / toNumber(b);
        case '^': return toNumber(a) ** toNumber(b);
        case '&': return toText(a) + toText(b);
        case '=': return compare(a, b) === 0;
        case '<>': return compare(a, b) !== 0;
        case '<': return compare(a, b) < 0;
        case '>': return compare(a, b) > 0;
        case '<=': return compare(a, b) <= 0;
        default: return compare(a, b) >= 0;
        }
    }
    default: break;
    }

    const { args } = node;
    switch (node.name) {
    case 'SUM': return total(numbers(args));
    case 'AVERAGE': {
        const list = numbers(args);
        return list.length ? total(list) / list.length : fail('#DIV/0!');
    }
    case 'MIN':
    case 'MAX': {
        const list = numbers(args);
        if (!list.length) return 0;
        return list.reduce((acc, v) => (node.name === 'MIN' ? Math.min(acc, v) : Math.max(acc, v)));
    }
    case 'COUNT': return allValues(args).filter((v) => typeof v === 'number').length;
    case 'COUNTA': return allValues(args).filter((v) => v !== '').length;
    case 'ROUND': {
        const factor = 10 ** toNumber(args[1] ? scalar(args[1]) : 0);
        return Math.round(toNumber(scalar(args[0])) * factor) / factor;
    }
    case 'ABS': return Math.abs(toNumber(scalar(args[0])));
    case 'SQRT': {
        const value = toNumber(scalar(args[0]));
        return value < 0 ? fail('#NUM!') : Math.sqrt(value);
    }
    case 'POWER': return toNumber(scalar(args[0])) ** toNumber(scalar(args[1]));
    case 'MOD': {
        const divisor = toNumber(scalar(args[1]));
        const value = toNumber(scalar(args[0]));
        return divisor === 0 ? fail('#DIV/0!') : value - (divisor * Math.floor(value / divisor));
    }
    case 'IF': return toBool(scalar(args[0])) ? scalar(args[1]) : (args[2] ? scalar(args[2]) : false);
    case 'IFERROR':
        try {
            const value = scalar(args[0]);
            if (value instanceof CellError) throw value;
            return value;
        } catch (error) {
            if (!(error instanceof CellError)) throw error;
            return scalar(args[1]);
        }
    case 'AND': return allValues(args).every(toBool);
    case 'OR': return allValues(args).some(toBool);
    case 'NOT': return !toBool(scalar(args[0]));
    case 'CONCAT': return allValues(args).map(toText).join('');
    case 'LEN': return toText(scalar(args[0])).length;
    case 'UPPER': return toText(scalar(args[0])).toUpperCase();
    case 'LOWER': return toText(scalar(args[0])).toLowerCase();
    case 'TRIM': return toText(scalar(args[0])).trim().replace(/\s+/g, ' ');
    default: return fail('#NAME?');
    }
};

// Returns a grid of evaluated values: numbers, strings, booleans or CellError.
export const evaluateSheet = (cells) => {
    const rows = cells.length;
    const cols = cells[0]?.length || 0;
    const cache = new Map();
    const visiting = new Set();

    const get = (r, c) => {
        if (r < 0 || c < 0 || r >= rows || c >= cols) fail('#REF!');
        const raw = cells[r][c] ?? '';
        if (raw[0] !== '=') return parseLiteral(raw);

        const key = (r * cols) + c;
        if (cache.has(key)) return cache.get(key);
        if (visiting.has(key)) fail('#CIRC!');

        visiting.add(key);
        let value;
        try {
            value = evaluate(parse(raw.slice(1)), get);
        } catch (error) {
            if (!(error instanceof CellError)) throw error;
            value = error;
        }
        visiting.delete(key);
        cache.set(key, value);
        return value;
    };

    return cells.map((row, r) => row.map((_, c) => get(r, c)));
};

// Rewrites every cell reference in a formula; fn returns the new ref or null for #REF!.
export const transformRefs = (formula, fn) => {
    if (!`${formula}`.startsWith('=')) return formula;
    return formula.replace(/"(?:[^"]|"")*"|(\$?[A-Za-z]{1,3}\$?\d+)(?![A-Za-z0-9_(])/g, (match, ref, offset, whole) => {
        if (!ref || /[A-Za-z0-9_$.]/.test(whole[offset - 1] || '')) return match;
        const next = fn(parseRef(ref));
        return next ? formatRef(next) : '#REF!';
    });
};

// Parses a plain cell name like "B12" (case-insensitive, optional $); null if invalid.
export const parseCellName = (text) => {
    const trimmed = `${text || ''}`.trim();
    return REF.test(trimmed) ? parseRef(trimmed) : null;
};

const SERIES_LISTS = [
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEXT_NUMBER = /^(.*?)(\d+)$/;
const DAY_MS = 86400000;

const mod = (n, m) => ((n % m) + m) % m;
const clean = (value) => +value.toPrecision(12);

// Least-squares line through (0, ys[0]) .. (n-1, ys[n-1]), like a spreadsheet's linear fill.
const linearFit = (ys, singleStep) => {
    const n = ys.length;
    if (n === 1) return { a: ys[0], b: singleStep };
    const meanX = (n - 1) / 2;
    const meanY = ys.reduce((acc, y) => acc + y, 0) / n;
    let num = 0;
    let den = 0;
    ys.forEach((y, x) => {
        num += (x - meanX) * (y - meanY);
        den += (x - meanX) ** 2;
    });
    const b = num / den;
    return { a: meanY - (b * meanX), b };
};

// Returns k => raw value for fill position k (0..n-1 is the source; negative k fills backwards).
// shift(raw, delta) moves a formula's relative refs by delta steps along the fill direction.
export const fillSeries = (source, shift) => {
    const n = source.length;
    const copy = (k) => {
        const i = mod(k, n);
        return shift(source[i], k - i);
    };
    if (source.some((raw) => raw.startsWith('='))) return copy;

    if (source.every((raw) => raw.trim() !== '' && NUMBER.test(raw.trim()))) {
        if (n === 1) return copy;
        const { a, b } = linearFit(source.map(Number), 0);
        return (k) => `${clean(a + (b * k))}`;
    }

    const dates = source.map((raw) => ISO_DATE.exec(raw.trim()));
    if (dates.every(Boolean)) {
        const days = dates.map(([, y, m, d]) => Date.UTC(+y, +m - 1, +d) / DAY_MS);
        const step = n === 1 ? 1 : days[1] - days[0];
        return (k) => new Date((days[0] + (step * k)) * DAY_MS).toISOString().slice(0, 10);
    }

    const list = SERIES_LISTS.find((items) => source.every((raw) => items.some((item) => item.toLowerCase() === raw.trim().toLowerCase())));
    if (list) {
        const indexes = source.map((raw) => list.findIndex((item) => item.toLowerCase() === raw.trim().toLowerCase()));
        const step = n === 1 ? 1 : mod(indexes[1] - indexes[0], list.length);
        const first = source[0].trim();
        const style = first === first.toUpperCase() ? 'upper' : (first === first.toLowerCase() ? 'lower' : '');
        return (k) => {
            const item = list[mod(indexes[0] + (step * k), list.length)];
            return style === 'upper' ? item.toUpperCase() : (style === 'lower' ? item.toLowerCase() : item);
        };
    }

    const parts = source.map((raw) => TEXT_NUMBER.exec(raw));
    if (parts.every((m) => m && m[1] === parts[0][1] && m[1] !== '')) {
        const { a, b } = linearFit(parts.map((m) => Number(m[2])), 1);
        const width = parts[0][2].startsWith('0') ? parts[0][2].length : 1;
        return (k) => `${parts[0][1]}${String(Math.abs(Math.round(a + (b * k)))).padStart(width, '0')}`;
    }

    return copy;
};
