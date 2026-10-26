/* VNMY — вычислитель условий и подстановка переменных.
 *
 * Полностью безопасный: никакого eval/new Function. Только разбор своего
 * маленького языка выражений и обход дерева.
 *
 *   sympathy >= 2 && met_anya
 *   not ending_seen or (chapter == "два" and score < 10)
 *   !took_hand
 *
 * Операторы: == != > >= < <= && || ! ( )  и слова and / or / not.
 * Значения: числа, строки в кавычках, true/false, имена переменных.
 * Арифметики нет намеренно: условия должны оставаться читаемыми.
 */

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const NUMBER = /^[0-9]+(\.[0-9]+)?$/;

const WORD_OPERATORS = {
  and: '&&',
  or: '||',
  not: '!',
};

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const text = String(src ?? '');
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\' && j + 1 < text.length) { value += text[j + 1]; j += 2; continue; }
        value += text[j];
        j++;
      }
      if (j >= text.length) throw exprError('незакрытая кавычка', i);
      tokens.push({ type: 'string', value, pos: i });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      const raw = text.slice(i, j);
      if (!NUMBER.test(raw)) throw exprError(`не число: ${raw}`, i);
      tokens.push({ type: 'number', value: Number(raw), pos: i });
      i = j;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < text.length && IDENT_PART.test(text[j])) j++;
      const raw = text.slice(i, j);
      const lower = raw.toLowerCase();
      if (lower === 'true' || lower === 'false') {
        tokens.push({ type: 'bool', value: lower === 'true', pos: i });
      } else if (WORD_OPERATORS[lower]) {
        tokens.push({ type: 'op', value: WORD_OPERATORS[lower], pos: i });
      } else {
        tokens.push({ type: 'ident', value: raw, pos: i });
      }
      i = j;
      continue;
    }

    const two = text.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if ('><()!'.includes(ch)) {
      tokens.push({ type: ch === '(' || ch === ')' ? 'paren' : 'op', value: ch, pos: i });
      i++;
      continue;
    }
    throw exprError(`непонятный символ «${ch}»`, i);
  }
  return tokens;
}

function exprError(message, position = 0) {
  const err = new Error(message);
  err.position = position;
  err.isExprError = true;
  return err;
}

class Parser {
  constructor(tokens, src) {
    this.tokens = tokens;
    this.src = src;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  expect(value) {
    const token = this.peek();
    if (!token || token.value !== value) {
      throw exprError(`ожидалось «${value}»`, token?.pos ?? this.src.length);
    }
    return this.next();
  }

  matchOp(...values) {
    const token = this.peek();
    if (token && token.type === 'op' && values.includes(token.value)) {
      this.pos++;
      return token.value;
    }
    return null;
  }

  parseExpression() {
    const node = this.parseOr();
    const rest = this.peek();
    if (rest) throw exprError(`лишнее «${rest.value}»`, rest.pos);
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.matchOp('||')) left = { type: 'or', left, right: this.parseAnd() };
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.matchOp('&&')) left = { type: 'and', left, right: this.parseEquality() };
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    let op;
    while ((op = this.matchOp('==', '!='))) {
      left = { type: 'cmp', op, left, right: this.parseComparison() };
    }
    return left;
  }

  parseComparison() {
    let left = this.parseUnary();
    let op;
    while ((op = this.matchOp('>', '>=', '<', '<='))) {
      left = { type: 'cmp', op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    if (this.matchOp('!')) return { type: 'not', arg: this.parseUnary() };
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.next();
    if (!token) throw exprError('выражение не закончено', this.src.length);
    if (token.type === 'number') return { type: 'number', value: token.value };
    if (token.type === 'string') return { type: 'string', value: token.value };
    if (token.type === 'bool') return { type: 'bool', value: token.value };
    if (token.type === 'ident') return { type: 'var', name: token.value };
    if (token.value === '(') {
      const node = this.parseOr();
      this.expect(')');
      return node;
    }
    throw exprError(`неожиданное «${token.value}»`, token.pos);
  }
}

export function parse(src) {
  const text = String(src ?? '').trim();
  if (!text) throw exprError('пустое условие', 0);
  const parser = new Parser(tokenize(text), text);
  return parser.parseExpression();
}

export function collectVars(ast, acc = new Set()) {
  if (!ast) return acc;
  if (ast.type === 'var') acc.add(ast.name);
  if (ast.left) collectVars(ast.left, acc);
  if (ast.right) collectVars(ast.right, acc);
  if (ast.arg) collectVars(ast.arg, acc);
  return acc;
}

/** Компиляция с человекочитаемой ошибкой — для редактора. */
export function compile(src) {
  try {
    const ast = parse(src);
    return { ast, deps: [...collectVars(ast)], error: null };
  } catch (err) {
    return { ast: null, deps: [], error: err.isExprError ? err : new Error(String(err?.message || err)) };
  }
}

/** Приводит значение переменной к числу/строке/логическому для сравнений. */
export function coerce(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim();
  if (NUMBER.test(text)) return Number(text);
  if (text.toLowerCase() === 'true') return true;
  if (text.toLowerCase() === 'false') return false;
  return text;
}

export function truthy(value) {
  const v = coerce(value);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v.length > 0;
}

function compare(op, left, right) {
  let a = coerce(left);
  let b = coerce(right);
  // bool и число сравниваем как 1/0
  if (typeof a === 'boolean' && typeof b === 'number') a = a ? 1 : 0;
  if (typeof b === 'boolean' && typeof a === 'number') b = b ? 1 : 0;

  if (op === '==') return a === b || String(a) === String(b);
  if (op === '!=') return !(a === b || String(a) === String(b));

  if (typeof a === 'number' && typeof b === 'number') {
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
  }
  const sa = String(a);
  const sb = String(b);
  if (op === '>') return sa > sb;
  if (op === '>=') return sa >= sb;
  if (op === '<') return sa < sb;
  if (op === '<=') return sa <= sb;
  return false;
}

export function evaluate(ast, vars = {}) {
  if (!ast) return false;
  switch (ast.type) {
    case 'number': return ast.value;
    case 'string': return ast.value;
    case 'bool': return ast.value;
    case 'var': return vars[ast.name] ?? 0;
    case 'not': return !truthy(evaluate(ast.arg, vars));
    case 'and': return truthy(evaluate(ast.left, vars)) && truthy(evaluate(ast.right, vars));
    case 'or': return truthy(evaluate(ast.left, vars)) || truthy(evaluate(ast.right, vars));
    case 'cmp': return compare(ast.op, evaluate(ast.left, vars), evaluate(ast.right, vars));
    default: return false;
  }
}

/** Быстрая проверка условия по строке. Битое условие считается ложным. */
export function evalCondition(src, vars = {}) {
  if (!src || !String(src).trim()) return true; // пустое условие = всегда
  const { ast } = compile(src);
  if (!ast) return false;
  return truthy(evaluate(ast, vars));
}

export function formatValue(value) {
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  return String(value ?? '');
}

/** Подставляет {имя} в текст. Неизвестные переменные остаются как есть. */
export function interpolate(text, vars = {}) {
  if (!text) return '';
  return String(text).replace(/\{([\p{L}\p{N}_]+)\}/gu, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? formatValue(vars[name]) : whole
  ));
}

/** Имена переменных, встречающиеся в тексте как {имя} */
export function interpolatedVars(text) {
  const found = new Set();
  String(text || '').replace(/\{([\p{L}\p{N}_]+)\}/gu, (whole, name) => {
    found.add(name);
    return whole;
  });
  return [...found];
}

/** Новое значение переменной по операции из шага. */
export function applyOperation(current, op, rawValue, type = 'number') {
  const parse = (value) => {
    if (type === 'bool') return truthy(value);
    if (type === 'text') return String(value ?? '');
    const n = Number(String(value ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  if (op === 'set') return parse(rawValue);
  if (op === 'toggle') return !truthy(current);
  const value = type === 'text' ? String(rawValue ?? '') : (Number(String(rawValue ?? '').replace(',', '.')) || 0);
  if (op === 'add') return type === 'text' ? String(current ?? '') + value : (Number(current) || 0) + value;
  if (op === 'sub') return (Number(current) || 0) - Number(value);
  return current;
}
