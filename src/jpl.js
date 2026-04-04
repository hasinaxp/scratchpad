/* JPL v1.0 - ES Module
 * Single-file JavaScript library for querying JSON with a pipeline DSL.
 */

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isObject(v)) {
    const out = {};
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = deepClone(v[keys[i]]);
    return out;
  }
  return v;
}

function stableStringify(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isObject(v)) {
    const keys = Object.keys(v).sort();
    let s = '{';
    for (let i = 0; i < keys.length; i++) {
      if (i) s += ',';
      const k = keys[i];
      s += JSON.stringify(k) + ':' + stableStringify(v[k]);
    }
    s += '}';
    return s;
  }
  return 'null';
}

function makeError(stage, code, message, loc, details) {
  return {
    code,
    message,
    stage,
    line: loc && loc.line,
    column: loc && loc.column,
    offset: loc && loc.offset,
    stepIndex: loc && loc.stepIndex,
    details: details || undefined
  };
}

function makeWarning(code, message, loc, details) {
  return {
    code,
    message,
    line: loc && loc.line,
    column: loc && loc.column,
    offset: loc && loc.offset,
    stepIndex: loc && loc.stepIndex,
    details: details || undefined
  };
}

function resultOk(value, warnings) {
  return {
    ok: true,
    value,
    warnings: warnings && warnings.length ? warnings : undefined
  };
}

function resultFail(error, warnings) {
  return {
    ok: false,
    error,
    warnings: warnings && warnings.length ? warnings : undefined
  };
}

function truthy(v) {
  return !(v === false || v === null || v === 0 || v === '');
}

function compareValues(a, b) {
  if (a === null || b === null) return null;
  if (typeof a !== typeof b) return null;
  if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  return null;
}

function getPath(value, path) {
  let cur = value;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (cur === null || cur === undefined) return null;
    if (typeof p === 'number') {
      if (!Array.isArray(cur)) return null;
      cur = p >= 0 && p < cur.length ? cur[p] : null;
    } else {
      if (!isObject(cur)) return null;
      cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : null;
    }
  }
  return cur === undefined ? null : cur;
}

function setShallowField(obj, field, value) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = obj[k];
  out[field] = value;
  return out;
}

function setPathField(obj, path, value) {
  if (!isObject(obj) || !Array.isArray(path) || path.length === 0) return obj;

  const root = { ...obj };
  let curOut = root;
  let curIn = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof key !== 'string') return root;

    const nextIn = isObject(curIn) ? curIn[key] : null;
    const nextOut = isObject(nextIn) ? { ...nextIn } : {};
    curOut[key] = nextOut;
    curOut = nextOut;
    curIn = nextIn;
  }

  const leaf = path[path.length - 1];
  if (typeof leaf !== 'string') return root;
  curOut[leaf] = value;
  return root;
}

function materializeStream(stream) {
  return deepClone(stream);
}

function isCurrentFieldPathNode(node) {
  return !!node
    && node.type === 'Path'
    && node.kind === 'current'
    && node.parts.length >= 1
    && node.parts.every(p => typeof p === 'string');
}

const TT = {
  eof: 'eof',
  ident: 'ident',
  number: 'number',
  string: 'string',
  punct: 'punct',
  op: 'op',
  keyword: 'keyword'
};

const KEYWORDS = new Set(['true', 'false', 'null']);
const STEP_NAMES = new Set(['filter', 'map', 'limit', 'sort', 'flatten', 'distinct', 'count', 'at', 'skip', 'slice']);
const BUILTIN_FUNCTIONS = new Set(['length', 'contains', 'exists']);

function tokenize(input, sourceName) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;

  function loc() {
    return { offset: i, line, column, sourceName: sourceName || undefined };
  }

  function push(type, value, start) {
    tokens.push({ type, value, start, end: loc() });
  }

  function adv(ch) {
    i++;
    if (ch === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  function peek(n = 0) {
    return input[i + n] ?? '';
  }

  while (i < input.length) {
    const ch = peek();

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      adv(ch);
      continue;
    }

    if (ch === '/' && peek(1) === '/') {
      while (i < input.length && peek() !== '\n') adv(peek());
      continue;
    }

    if (ch === '/' && peek(1) === '*') {
      adv('/');
      adv('*');
      while (i < input.length && !(peek() === '*' && peek(1) === '/')) adv(peek());
      if (i >= input.length) throw makeError('parse', 'E_UNTERMINATED_COMMENT', 'Unterminated comment', loc());
      adv('*');
      adv('/');
      continue;
    }

    const start = loc();
    const two = ch + peek(1);

    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      adv(ch);
      adv(peek());
      push(TT.op, two, start);
      continue;
    }

    if (ch === '|' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ',' || ch === '.' || ch === ':' || ch === '@' || ch === '$') {
      adv(ch);
      push(TT.punct, ch, start);
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '!' || ch === '>' || ch === '<') {
      adv(ch);
      push(TT.op, ch, start);
      continue;
    }

    if (ch === '"') {
      adv(ch);
      let s = '';
      let closed = false;
      while (i < input.length) {
        const c = peek();
        if (c === '"') {
          adv(c);
          push(TT.string, s, start);
          closed = true;
          break;
        }
        if (c === '\\') {
          adv(c);
          const e = peek();
          if (e === 'n') { s += '\n'; adv(e); }
          else if (e === 'r') { s += '\r'; adv(e); }
          else if (e === 't') { s += '\t'; adv(e); }
          else if (e === '"') { s += '"'; adv(e); }
          else if (e === '\\') { s += '\\'; adv(e); }
          else if (e === 'u') {
            adv(e);
            let hex = '';
            for (let k = 0; k < 4; k++) {
              const h = peek();
              if (!/[0-9a-fA-F]/.test(h)) throw makeError('parse', 'E_BAD_STRING_ESCAPE', 'Invalid unicode escape', loc());
              hex += h;
              adv(h);
            }
            s += String.fromCharCode(parseInt(hex, 16));
          } else {
            throw makeError('parse', 'E_BAD_STRING_ESCAPE', 'Invalid string escape', loc());
          }
          continue;
        }
        if (c === '\n' || c === '\r') throw makeError('parse', 'E_UNTERMINATED_STRING', 'Unterminated string literal', loc());
        s += c;
        adv(c);
      }
      if (!closed) throw makeError('parse', 'E_UNTERMINATED_STRING', 'Unterminated string literal', start);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(peek(1)))) {
      let ns = '';
      if (ch === '-') { ns += ch; adv(ch); }
      while (/[0-9]/.test(peek())) {
        ns += peek();
        adv(peek());
      }
      if (peek() === '.') {
        ns += '.';
        adv('.');
        if (!/[0-9]/.test(peek())) throw makeError('parse', 'E_BAD_NUMBER', 'Invalid number literal', loc());
        while (/[0-9]/.test(peek())) {
          ns += peek();
          adv(peek());
        }
      }
      if (peek() === 'e' || peek() === 'E') {
        ns += peek();
        adv(peek());
        if (peek() === '+' || peek() === '-') {
          ns += peek();
          adv(peek());
        }
        if (!/[0-9]/.test(peek())) throw makeError('parse', 'E_BAD_NUMBER', 'Invalid number literal', loc());
        while (/[0-9]/.test(peek())) {
          ns += peek();
          adv(peek());
        }
      }
      push(TT.number, Number(ns), start);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let id = '';
      while (/[A-Za-z0-9_]/.test(peek())) {
        id += peek();
        adv(peek());
      }
      if (KEYWORDS.has(id)) push(TT.keyword, id, start);
      else push(TT.ident, id, start);
      continue;
    }

    throw makeError('parse', 'E_UNEXPECTED_CHAR', 'Unexpected character: ' + ch, loc());
  }

  tokens.push({ type: TT.eof, value: null, start: loc(), end: loc() });
  return tokens;
}

function Parser(tokens) {
  this.tokens = tokens;
  this.i = 0;
}

Parser.prototype.peek = function (n = 0) {
  return this.tokens[this.i + n] || this.tokens[this.tokens.length - 1];
};

Parser.prototype.match = function (type, value) {
  const t = this.peek();
  if (t.type === type && (value === undefined || t.value === value)) {
    this.i++;
    return t;
  }
  return null;
};

Parser.prototype.expect = function (type, value, msg, stage) {
  const t = this.peek();
  if (t.type === type && (value === undefined || t.value === value)) {
    this.i++;
    return t;
  }
  throw makeError(stage || 'parse', 'E_EXPECTED', msg || ('Expected ' + (value || type)), t.start);
};

Parser.prototype.parseQuery = function () {
  const source = this.parseSource();
  const steps = [];
  while (this.match(TT.punct, '|')) {
    steps.push(this.parseStep());
  }
  this.expect(TT.eof, undefined, 'Unexpected trailing tokens', 'parse');
  return { type: 'Query', source, steps };
};

Parser.prototype.parseSource = function () {
  if (this.match(TT.punct, '$')) return { type: 'Source', kind: 'root', path: [] };
  return { type: 'Source', kind: 'path', path: this.parsePath() };
};

Parser.prototype.parsePath = function () {
  const parts = [];
  const first = this.expect(TT.ident, undefined, 'Expected identifier', 'parse');
  parts.push(first.value);
  while (this.match(TT.punct, '.')) {
    const id = this.expect(TT.ident, undefined, 'Expected identifier after dot', 'parse');
    parts.push(id.value);
  }
  return parts;
};

Parser.prototype.parseStep = function () {
  const t = this.expect(TT.ident, undefined, 'Expected step name', 'parse');
  if (!STEP_NAMES.has(t.value)) throw makeError('parse', 'E_UNKNOWN_STEP', 'Unknown step: ' + t.value, t.start);
  this.expect(TT.punct, '(', 'Expected ( after step name', 'parse');

  const name = t.value;
  let args = [];

  if (name === 'sort') {
    if (!this.match(TT.punct, ')')) {
      args.push(this.parseExpr());
      if (this.peek().type === TT.ident && (this.peek().value === 'asc' || this.peek().value === 'desc')) {
        args.push({ type: 'Literal', value: this.peek().value });
        this.i++;
      }
      this.expect(TT.punct, ')', 'Expected ) to close sort', 'parse');
    }
    return { type: 'Step', name, args, loc: t.start };
  }

  if (name === 'flatten' || name === 'distinct' || name === 'count') {
    if (!this.match(TT.punct, ')')) {
      args.push(this.parseExpr());
      this.expect(TT.punct, ')', 'Expected ) to close ' + name, 'parse');
    }
    return { type: 'Step', name, args, loc: t.start };
  }

  if (name === 'slice') {
    if (this.match(TT.punct, ')')) {
      throw makeError('parse', 'E_EXPECTED', 'slice expects 2 arguments', t.start);
    }

    args.push(this.parseExpr());
    this.expect(TT.punct, ',', 'Expected , in slice(start, count)', 'parse');
    args.push(this.parseExpr());
    this.expect(TT.punct, ')', 'Expected ) to close slice', 'parse');
    return { type: 'Step', name, args, loc: t.start };
  }

  args.push(this.parseExpr());
  this.expect(TT.punct, ')', 'Expected ) to close step', 'parse');
  return { type: 'Step', name, args, loc: t.start };
};

Parser.prototype.parseExpr = function () { return this.parseOr(); };

Parser.prototype.parseOr = function () {
  let node = this.parseAnd();
  while (this.match(TT.op, '||')) node = { type: 'Binary', op: '||', left: node, right: this.parseAnd() };
  return node;
};

Parser.prototype.parseAnd = function () {
  let node = this.parseEquality();
  while (this.match(TT.op, '&&')) node = { type: 'Binary', op: '&&', left: node, right: this.parseEquality() };
  return node;
};

Parser.prototype.parseEquality = function () {
  let node = this.parseComparison();
  while (true) {
    if (this.match(TT.op, '==')) node = { type: 'Binary', op: '==', left: node, right: this.parseComparison() };
    else if (this.match(TT.op, '!=')) node = { type: 'Binary', op: '!=', left: node, right: this.parseComparison() };
    else break;
  }
  return node;
};

Parser.prototype.parseComparison = function () {
  let node = this.parseTerm();
  while (true) {
    if (this.match(TT.op, '>')) node = { type: 'Binary', op: '>', left: node, right: this.parseTerm() };
    else if (this.match(TT.op, '<')) node = { type: 'Binary', op: '<', left: node, right: this.parseTerm() };
    else if (this.match(TT.op, '>=')) node = { type: 'Binary', op: '>=', left: node, right: this.parseTerm() };
    else if (this.match(TT.op, '<=')) node = { type: 'Binary', op: '<=', left: node, right: this.parseTerm() };
    else break;
  }
  return node;
};

Parser.prototype.parseTerm = function () {
  let node = this.parseFactor();
  while (true) {
    if (this.match(TT.op, '+')) node = { type: 'Binary', op: '+', left: node, right: this.parseFactor() };
    else if (this.match(TT.op, '-')) node = { type: 'Binary', op: '-', left: node, right: this.parseFactor() };
    else break;
  }
  return node;
};

Parser.prototype.parseFactor = function () {
  let node = this.parseUnary();
  while (true) {
    if (this.match(TT.op, '*')) node = { type: 'Binary', op: '*', left: node, right: this.parseUnary() };
    else if (this.match(TT.op, '/')) node = { type: 'Binary', op: '/', left: node, right: this.parseUnary() };
    else break;
  }
  return node;
};

Parser.prototype.parseUnary = function () {
  if (this.match(TT.op, '!')) return { type: 'Unary', op: '!', expr: this.parseUnary() };
  if (this.match(TT.op, '-')) return { type: 'Unary', op: '-', expr: this.parseUnary() };
  return this.parsePrimary();
};

Parser.prototype.parsePrimary = function () {
  const t = this.peek();

  if (this.match(TT.punct, '(')) {
    const e = this.parseExpr();
    this.expect(TT.punct, ')', 'Expected )', 'parse');
    return e;
  }

  if (t.type === TT.number) {
    this.i++;
    return { type: 'Literal', value: t.value };
  }

  if (t.type === TT.string) {
    this.i++;
    return { type: 'Literal', value: t.value };
  }

  if (t.type === TT.keyword) {
    this.i++;
    if (t.value === 'true') return { type: 'Literal', value: true };
    if (t.value === 'false') return { type: 'Literal', value: false };
    if (t.value === 'null') return { type: 'Literal', value: null };
  }

  if (this.match(TT.punct, '{')) {
    const fields = [];
    if (!this.match(TT.punct, '}')) {
      while (true) {
        const keyTok = this.expect(TT.ident, undefined, 'Expected object field name', 'parse');
        let valueExpr = { type: 'Path', kind: 'current', parts: [keyTok.value] };
        if (this.match(TT.punct, ':')) valueExpr = this.parseExpr();
        fields.push({ key: keyTok.value, value: valueExpr });
        if (this.match(TT.punct, ',')) continue;
        this.expect(TT.punct, '}', 'Expected }', 'parse');
        break;
      }
    }
    return { type: 'Object', fields };
  }

  if (t.type === TT.ident || (t.type === TT.punct && (t.value === '@' || t.value === '$'))) {
    return this.parsePathOrCall();
  }

  throw makeError('parse', 'E_UNEXPECTED_TOKEN', 'Unexpected token', t.start);
};

Parser.prototype.parsePathOrCall = function () {
  let base;
  const t = this.peek();

  if (this.match(TT.punct, '@')) base = { type: 'Path', kind: 'current', parts: [] };
  else if (this.match(TT.punct, '$')) base = { type: 'Path', kind: 'root', parts: [] };
  else {
    const id = this.expect(TT.ident, undefined, 'Expected identifier', 'parse');
    if (this.peek().type === TT.punct && this.peek().value === '(') {
      this.i++;
      const args = this.match(TT.punct, ')') ? [] : this.parseArgListClose(')');
      return { type: 'Call', name: id.value, args };
    }
    base = { type: 'Path', kind: 'current', parts: [id.value] };
  }

  while (true) {
    if (this.match(TT.punct, '.')) {
      base.parts.push(this.expect(TT.ident, undefined, 'Expected identifier after dot', 'parse').value);
      continue;
    }
    if (this.match(TT.punct, '[')) {
      const idxTok = this.expect(TT.number, undefined, 'Expected numeric index', 'parse');
      const idx = idxTok.value;
      if (!Number.isInteger(idx) || idx < 0) throw makeError('parse', 'E_BAD_INDEX', 'Array index must be a non-negative integer', idxTok.start);
      this.expect(TT.punct, ']', 'Expected ]', 'parse');
      base.parts.push(idx);
      continue;
    }
    break;
  }

  if (this.peek().type === TT.punct && this.peek().value === '(') {
    const name = base.parts.length === 1 ? base.parts[0] : null;
    if (!name) throw makeError('parse', 'E_BAD_CALL', 'Only bare function names can be called', t.start);
    this.i++;
    const args = this.match(TT.punct, ')') ? [] : this.parseArgListClose(')');
    return { type: 'Call', name, args };
  }

  return base;
};

Parser.prototype.parseArgListClose = function (close) {
  const args = [];
  while (true) {
    args.push(this.parseExpr());
    if (this.match(TT.punct, ',')) continue;
    this.expect(TT.punct, close, 'Expected ' + close, 'parse');
    break;
  }
  return args;
};

function parse(query, options) {
  try {
    const tokens = tokenize(String(query), options && options.sourceName);
    const p = new Parser(tokens);
    const ast = p.parseQuery();
    return { ok: true, ast };
  } catch (err) {
    if (err && err.code && err.stage) return { ok: false, error: err };
    return { ok: false, error: makeError('parse', 'E_PARSE', String(err && err.message ? err.message : err), null) };
  }
}

function validateAst(ast) {
  const warnings = [];

  function walkExpr(node) {
    if (!node) return;
    switch (node.type) {
      case 'Literal':
      case 'Path':
        return;
      case 'Unary':
        walkExpr(node.expr);
        return;
      case 'Binary':
        walkExpr(node.left);
        walkExpr(node.right);
        return;
      case 'Call':
        if (!BUILTIN_FUNCTIONS.has(node.name)) warnings.push(makeWarning('W_UNKNOWN_FUNCTION', 'Unknown function: ' + node.name, null, { name: node.name }));
        for (let i = 0; i < node.args.length; i++) walkExpr(node.args[i]);
        return;
      case 'Object':
        for (let j = 0; j < node.fields.length; j++) walkExpr(node.fields[j].value);
        return;
    }
  }

  if (!ast || ast.type !== 'Query') {
    return { ok: false, error: makeError('validate', 'E_BAD_AST', 'Invalid AST', null), warnings };
  }

  let seenTerminal = false;
  for (let i = 0; i < ast.steps.length; i++) {
    const s = ast.steps[i];
    if (seenTerminal) return { ok: false, error: makeError('validate', 'E_AFTER_TERMINAL', 'No steps allowed after a terminal step', s.loc, { stepIndex: i }), warnings };

    if (s.name === 'filter' || s.name === 'map' || s.name === 'limit' || s.name === 'at' || s.name === 'skip') {
      if (s.args.length !== 1) return { ok: false, error: makeError('validate', 'E_ARG_COUNT', s.name + ' expects 1 argument', s.loc, { stepIndex: i }), warnings };
    }
    if (s.name === 'slice') {
      if (s.args.length !== 2) return { ok: false, error: makeError('validate', 'E_ARG_COUNT', 'slice expects 2 arguments', s.loc, { stepIndex: i }), warnings };
    }
    if (s.name === 'count') {
      if (s.args.length > 1) return { ok: false, error: makeError('validate', 'E_ARG_COUNT', 'count expects 0 or 1 arguments', s.loc, { stepIndex: i }), warnings };
    }
    if (s.name === 'sort') {
      if (s.args.length !== 1 && s.args.length !== 2) return { ok: false, error: makeError('validate', 'E_ARG_COUNT', 'sort expects 1 or 2 arguments', s.loc, { stepIndex: i }), warnings };
      if (!isCurrentFieldPathNode(s.args[0])) return { ok: false, error: makeError('validate', 'E_BAD_SORT_FIELD', 'sort field must be a current path field (e.g. profile.country)', s.loc, { stepIndex: i }), warnings };
      if (s.args[1] && !(s.args[1].type === 'Literal' && (s.args[1].value === 'asc' || s.args[1].value === 'desc'))) return { ok: false, error: makeError('validate', 'E_BAD_SORT_ORDER', 'sort order must be asc or desc', s.loc, { stepIndex: i }), warnings };
    }
    if (s.name === 'flatten' || s.name === 'distinct') {
      if (s.args.length > 1) return { ok: false, error: makeError('validate', 'E_ARG_COUNT', s.name + ' expects 0 or 1 arguments', s.loc, { stepIndex: i }), warnings };
      if (s.args.length === 1 && !isCurrentFieldPathNode(s.args[0])) return { ok: false, error: makeError('validate', 'E_BAD_FIELD', s.name + ' field must be a current path field (e.g. profile.country)', s.loc, { stepIndex: i }), warnings };
    }
    if (s.name === 'count') seenTerminal = true;
    for (let j = 0; j < s.args.length; j++) walkExpr(s.args[j]);
  }

  return { ok: true, ast, warnings: warnings.length ? warnings : undefined };
}

function validate(query, options) {
  const p = parse(query, options);
  if (!p.ok) return { ok: false, error: p.error };
  return validateAst(p.ast);
}

function compile(query, options) {
  const p = parse(query, options);
  if (!p.ok) return p;
  const v = validateAst(p.ast);
  if (!v.ok) return { ok: false, error: v.error, warnings: v.warnings };
  return {
    ok: true,
    compiled: {
      ast: p.ast,
      source: String(query),
      steps: p.ast.steps.slice(),
      readonly: true
    },
    warnings: v.warnings
  };
}

function evalExpr(node, ctx) {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Path':
      return getPath(node.kind === 'root' ? ctx.root : ctx.current, node.parts);
    case 'Unary': {
      const v = evalExpr(node.expr, ctx);
      if (node.op === '!') return !truthy(v);
      if (node.op === '-') return typeof v === 'number' ? -v : null;
      return null;
    }
    case 'Binary': {
      const a = evalExpr(node.left, ctx);
      const b = evalExpr(node.right, ctx);
      if (node.op === '&&') return truthy(a) && truthy(b);
      if (node.op === '||') return truthy(a) || truthy(b);
      if (a === null || b === null) {
        if (node.op === '!=') return a !== b;
        if (node.op === '==') return false;
        return null;
      }
      switch (node.op) {
        case '==': return a === b;
        case '!=': return a !== b;
        case '>': { const c = compareValues(a, b); return c === null ? false : c > 0; }
        case '<': { const c = compareValues(a, b); return c === null ? false : c < 0; }
        case '>=': { const c = compareValues(a, b); return c === null ? false : c >= 0; }
        case '<=': { const c = compareValues(a, b); return c === null ? false : c <= 0; }
        case '+':
          return (typeof a === 'number' && typeof b === 'number') ? a + b : (typeof a === 'string' && typeof b === 'string') ? a + b : null;
        case '-': return (typeof a === 'number' && typeof b === 'number') ? a - b : null;
        case '*': return (typeof a === 'number' && typeof b === 'number') ? a * b : null;
        case '/': return (typeof a === 'number' && typeof b === 'number' && b !== 0) ? a / b : null;
        default: return null;
      }
    }
    case 'Call': {
      const args = node.args.map(arg => evalExpr(arg, ctx));
      return callFunction(node.name, args, ctx);
    }
    case 'Object': {
      const out = {};
      for (let i = 0; i < node.fields.length; i++) out[node.fields[i].key] = evalExpr(node.fields[i].value, ctx);
      return out;
    }
    default:
      return null;
  }
}

function callFunction(name, args, ctx) {
  if (name === 'length') {
    if (args.length !== 1) return null;
    const a = args[0];
    if (typeof a === 'string' || Array.isArray(a)) return a.length;
    return null;
  }
  if (name === 'contains') {
    if (args.length !== 2) return null;
    const a = args[0], b = args[1];
    if (typeof a === 'string' && typeof b === 'string') return a.indexOf(b) !== -1;
    return null;
  }
  if (name === 'exists') {
    if (args.length !== 1) return null;
    return args[0] !== null;
  }
  const fn = ctx && ctx.functions && ctx.functions[name];
  if (typeof fn === 'function') return fn(args, ctx);
  return null;
}

function runCompiled(compiled, input, options) {
  const warnings = [];
  const maxSteps = options && typeof options.maxSteps === 'number' ? options.maxSteps : Infinity;
  const maxOutputItems = options && typeof options.maxOutputItems === 'number' ? options.maxOutputItems : Infinity;
  const ctxBase = options && options.context ? options.context : {};
  const root = input;

  const source = compiled && compiled.ast && compiled.ast.source ? compiled.ast.source : { kind: 'root', path: [] };
  const resolveSource = () => {
    if (source.kind === 'root') return root;
    return getPath(root, source.path || []);
  };

  const sourceValue = resolveSource();
  let stream = [];
  if (sourceValue === null || sourceValue === undefined) {
    stream = [];
  } else if (Array.isArray(sourceValue)) {
    stream = sourceValue.slice();
  } else {
    stream = [sourceValue];
  }
  let stepCount = 0;

  const steps = compiled.steps;
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    stepCount++;
    if (stepCount > maxSteps) return resultFail(makeError('execute', 'E_MAX_STEPS', 'Maximum step count exceeded', step.loc, { stepIndex: si }), warnings);

    const ctx = {
      root,
      current: null,
      variables: ctxBase.variables || undefined,
      functions: ctxBase.functions || undefined
    };

    if (step.name === 'filter') {
      const out = [];
      for (let i = 0; i < stream.length; i++) {
        ctx.current = stream[i];
        const v = evalExpr(step.args[0], ctx);
        if (truthy(v)) out.push(stream[i]);
        if (out.length > maxOutputItems) return resultFail(makeError('execute', 'E_MAX_OUTPUT', 'Maximum output items exceeded', step.loc, { stepIndex: si }), warnings);
      }
      stream = out;
      continue;
    }

    if (step.name === 'map') {
      const out = [];
      for (let i = 0; i < stream.length; i++) {
        ctx.current = stream[i];
        out.push(evalExpr(step.args[0], ctx));
        if (out.length > maxOutputItems) return resultFail(makeError('execute', 'E_MAX_OUTPUT', 'Maximum output items exceeded', step.loc, { stepIndex: si }), warnings);
      }
      stream = out;
      continue;
    }

    if (step.name === 'limit') {
      const n = evalExpr(step.args[0], { root, current: null, variables: ctxBase.variables || undefined, functions: ctxBase.functions || undefined });
      const lim = typeof n === 'number' && n >= 0 ? Math.floor(n) : 0;
      stream = stream.slice(0, lim);
      continue;
    }

    if (step.name === 'skip') {
      const n = evalExpr(step.args[0], { root, current: null, variables: ctxBase.variables || undefined, functions: ctxBase.functions || undefined });
      const count = typeof n === 'number' && n >= 0 ? Math.floor(n) : 0;
      stream = stream.slice(count);
      continue;
    }

    if (step.name === 'at') {
      const n = evalExpr(step.args[0], { root, current: null, variables: ctxBase.variables || undefined, functions: ctxBase.functions || undefined });
      const idx = typeof n === 'number' && n >= 0 ? Math.floor(n) : -1;
      stream = idx >= 0 && idx < stream.length ? [stream[idx]] : [];
      continue;
    }

    if (step.name === 'slice') {
      const startRaw = evalExpr(step.args[0], { root, current: null, variables: ctxBase.variables || undefined, functions: ctxBase.functions || undefined });
      const countRaw = evalExpr(step.args[1], { root, current: null, variables: ctxBase.variables || undefined, functions: ctxBase.functions || undefined });
      const start = typeof startRaw === 'number' && startRaw >= 0 ? Math.floor(startRaw) : 0;
      const count = typeof countRaw === 'number' && countRaw >= 0 ? Math.floor(countRaw) : 0;
      stream = stream.slice(start, start + count);
      continue;
    }

    if (step.name === 'sort') {
      const fieldExpr = step.args[0];
      const order = step.args[1] ? (step.args[1].type === 'Literal' ? String(step.args[1].value) : 'asc') : 'asc';
      const mapped = stream.map((item, idx) => {
        ctx.current = item;
        const key = evalExpr(fieldExpr, ctx);
        return { item, key, idx };
      });
      mapped.sort((a, b) => {
        const ak = a.key;
        const bk = b.key;
        const aNull = ak === null || ak === undefined;
        const bNull = bk === null || bk === undefined;
        if (aNull && bNull) return a.idx - b.idx;
        if (aNull) return 1;
        if (bNull) return -1;
        const c = compareValues(ak, bk);
        const r = c === null ? 0 : c;
        return order === 'desc' ? -r : r;
      });
      stream = mapped.map(x => x.item);
      continue;
    }

    if (step.name === 'flatten') {
      const out = [];
      if (step.args.length === 0) {
        for (let i = 0; i < stream.length; i++) {
          if (Array.isArray(stream[i])) {
            for (let j = 0; j < stream[i].length; j++) out.push(stream[i][j]);
          } else {
            out.push(stream[i]);
          }
        }
      } else {
        const pathParts = step.args[0].parts.slice();
        for (let i = 0; i < stream.length; i++) {
          ctx.current = stream[i];
          const arr = evalExpr(step.args[0], ctx);
          if (!Array.isArray(arr)) continue;
          for (let j = 0; j < arr.length; j++) {
            if (isObject(stream[i])) out.push(setPathField(stream[i], pathParts, arr[j]));
            else out.push(arr[j]);
          }
        }
      }
      stream = out;
      continue;
    }

    if (step.name === 'distinct') {
      const seen = new Set();
      const uniq = [];
      const hasArg = step.args.length === 1;
      for (let i = 0; i < stream.length; i++) {
        const item = stream[i];
        let key;
        if (hasArg) {
          ctx.current = item;
          key = stableStringify(evalExpr(step.args[0], ctx));
        } else {
          key = stableStringify(item);
        }
        if (!seen.has(key)) {
          seen.add(key);
          uniq.push(item);
        }
      }
      stream = uniq;
      continue;
    }

    if (step.name === 'count') {
      if (step.args.length === 0) return resultOk(stream.length, warnings);
      let c = 0;
      for (let i = 0; i < stream.length; i++) {
        ctx.current = stream[i];
        if (truthy(evalExpr(step.args[0], ctx))) c++;
      }
      return resultOk(c, warnings);
    }

    return resultFail(makeError('execute', 'E_UNKNOWN_STEP', 'Unknown step: ' + step.name, step.loc, { stepIndex: si }), warnings);
  }

  return resultOk(materializeStream(stream), warnings.length ? warnings : undefined);
}

function execute(query, input, options) {
  const c = compile(query, options);
  if (!c.ok) return { ok: false, error: c.error, warnings: c.warnings };
  return runCompiled(c.compiled, input, options || {});
}

function run(compiled, input, options) {
  if (!compiled || !compiled.ast || !compiled.steps) {
    return resultFail(makeError('execute', 'E_BAD_COMPILED', 'Invalid compiled query', null));
  }
  return runCompiled(compiled, input, options || {});
}

function format(query, options) {
  const p = parse(query, options);
  if (!p.ok) throw new Error(p.error.message);
  const ast = p.ast;

  function fmtExpr(n) {
    switch (n.type) {
      case 'Literal':
        if (n.value === null) return 'null';
        if (typeof n.value === 'string') return JSON.stringify(n.value);
        return String(n.value);
      case 'Path': {
        const base = n.kind === 'root' ? '$' : '@';
        if (!n.parts.length) return base;
        let s = base;
        for (const p2 of n.parts) {
          if (typeof p2 === 'number') s += '[' + p2 + ']';
          else s += '.' + p2;
        }
        return s;
      }
      case 'Unary':
        return n.op + fmtExpr(n.expr);
      case 'Binary':
        return fmtExpr(n.left) + ' ' + n.op + ' ' + fmtExpr(n.right);
      case 'Call':
        return n.name + '(' + n.args.map(fmtExpr).join(', ') + ')';
      case 'Object':
        return '{ ' + n.fields.map(f => (f.value.type === 'Path' && f.value.kind === 'current' && f.value.parts.length === 1 && f.value.parts[0] === f.key) ? f.key : (f.key + ': ' + fmtExpr(f.value))).join(', ') + ' }';
      default:
        return '';
    }
  }

  let out = ast.source.kind === 'root' ? '$' : ast.source.path.join('.');
  for (const s of ast.steps) {
    out += ' | ' + s.name + '(';
    if (s.name === 'sort') {
      out += s.args.length ? fmtExpr(s.args[0]) + (s.args[1] ? ' ' + s.args[1].value : '') : '';
    } else if (s.name === 'flatten' || s.name === 'distinct' || s.name === 'count') {
      out += s.args.length ? fmtExpr(s.args[0]) : '';
    } else {
      out += s.args.map(fmtExpr).join(', ');
    }
    out += ')';
  }
  return options && options.compact ? out.replace(/\s+/g, ' ').trim() : out;
}

const JPL = {
  parse,
  validate,
  compile,
  execute,
  run,
  format,
  _internals: {
    tokenize,
    validateAst,
    evalExpr,
    deepClone,
    stableStringify,
    setShallowField,
    setPathField,
    materializeStream
  }
};

export {
  parse,
  validate,
  compile,
  execute,
  run,
  format,
  tokenize,
  validateAst,
  evalExpr,
  deepClone,
  stableStringify,
  setShallowField,
  setPathField,
  materializeStream
};

export default JPL;