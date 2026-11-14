/**
 * Minimal HCL reader: splits the body of a block into its top-level arguments and nested blocks,
 * keeping each item's original text. It understands strings with ${} interpolation, heredocs,
 * comments and nested brackets well enough to find where each item ends; it does not evaluate.
 */

export interface HclItem {
  key: string;
  kind: 'attribute' | 'block';
  /** The item as written, from its key to its end, re-indented to start at column 0. */
  text: string;
  /** Attributes only: the expression after `=`, trimmed. */
  value?: string;
}

const OPENERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const HEREDOC = /^<<-?([A-Za-z_]\w*)[ \t]*\r?\n/;

function skipLine(s: string, i: number): number {
  const nl = s.indexOf('\n', i);
  return nl === -1 ? s.length : nl;
}

function skipBlockComment(s: string, i: number): number {
  const end = s.indexOf('*/', i + 2);
  return end === -1 ? s.length : end + 2;
}

function skipHeredoc(s: string, i: number): number {
  const m = HEREDOC.exec(s.slice(i));
  if (!m) return i + 2;
  let j = i + m[0].length;
  while (j < s.length) {
    const end = skipLine(s, j);
    if (s.slice(j, end).trim() === m[1]) return end;
    j = end + 1;
  }
  return s.length;
}

/** s[i] is `"`; returns the index just after the closing quote. */
function skipString(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === '"') return j + 1;
    else if ((c === '$' || c === '%') && s[j + 1] === '{') j = skipBalanced(s, j + 1);
    else j++;
  }
  return s.length;
}

/** s[i] is an opening bracket; returns the index just after its match. */
function skipBalanced(s: string, i: number): number {
  const closers: string[] = [];
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') j = skipString(s, j);
    else if (c === '<' && s[j + 1] === '<' && HEREDOC.test(s.slice(j))) j = skipHeredoc(s, j);
    else if (c === '#' || (c === '/' && s[j + 1] === '/')) j = skipLine(s, j);
    else if (c === '/' && s[j + 1] === '*') j = skipBlockComment(s, j);
    else if (OPENERS[c]) {
      closers.push(OPENERS[c]);
      j++;
    } else if (c === closers[closers.length - 1]) {
      closers.pop();
      j++;
      if (closers.length === 0) return j;
    } else j++;
  }
  return s.length;
}

/** From the start of an expression, the index where it ends: a newline (or comment) outside any bracket. */
function skipExpression(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '\n' || c === '#' || (c === '/' && (s[j + 1] === '/' || s[j + 1] === '*'))) return j;
    if (c === '"') j = skipString(s, j);
    else if (c === '<' && s[j + 1] === '<' && HEREDOC.test(s.slice(j))) j = skipHeredoc(s, j);
    else if (OPENERS[c]) j = skipBalanced(s, j);
    else j++;
  }
  return s.length;
}

/** Removes the item's own indentation from its continuation lines. */
function dedent(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split('\n')
    .map((line, idx) => (idx > 0 && line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

export function splitHclBody(body: string): HclItem[] {
  const items: HclItem[] = [];
  let i = 0;

  while (i < body.length) {
    const c = body[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#' || (c === '/' && body[i + 1] === '/')) {
      i = skipLine(body, i);
      continue;
    }
    if (c === '/' && body[i + 1] === '*') {
      i = skipBlockComment(body, i);
      continue;
    }

    const keyMatch = /^[A-Za-z_][\w-]*/.exec(body.slice(i));
    if (!keyMatch) {
      // Not something we understand: skip the line rather than guess
      i = skipLine(body, i);
      continue;
    }
    const start = i;
    const key = keyMatch[0];
    const lineStart = body.lastIndexOf('\n', start - 1) + 1;
    const indent = /^[ \t]*/.exec(body.slice(lineStart, start))?.[0] ?? '';
    let j = start + key.length;
    while (body[j] === ' ' || body[j] === '\t') j++;

    if (body[j] === '=' && body[j + 1] !== '=') {
      const valueStart = j + 1;
      const end = skipExpression(body, valueStart);
      items.push({
        key,
        kind: 'attribute',
        text: dedent(body.slice(start, end).trimEnd(), indent),
        value: body.slice(valueStart, end).trim(),
      });
      i = end;
      continue;
    }

    // Block: optional labels, then a brace-delimited body
    while (j < body.length && body[j] !== '{' && body[j] !== '\n') {
      j = body[j] === '"' ? skipString(body, j) : j + 1;
    }
    if (body[j] !== '{') {
      i = skipLine(body, start);
      continue;
    }
    const end = skipBalanced(body, j);
    items.push({ key, kind: 'block', text: dedent(body.slice(start, end), indent) });
    i = end;
  }

  return items;
}

/** A literal value, or undefined for anything that needs evaluating (references, functions, interpolation). */
export function parseHclLiteral(value: string): string | number | boolean | undefined {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^"([^"\\]|\\.)*"$/.test(v) && !/[$%]\{/.test(v)) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** `{ Key = "value", ... }` with only literal string values, or undefined. */
export function parseHclStringMap(value: string): Record<string, string> | undefined {
  const v = value.trim();
  if (!v.startsWith('{') || !v.endsWith('}')) return undefined;
  const result: Record<string, string> = {};
  // Quoted keys ("Name" = ...) read like bare ones; keys that aren't identifiers make the map unreadable
  const inner = v.slice(1, -1).replace(/"([A-Za-z_][\w-]*)"(\s*=)/g, '$1$2');
  for (const item of splitHclBody(inner)) {
    const literal = item.kind === 'attribute' ? parseHclLiteral((item.value || '').replace(/,$/, '')) : undefined;
    if (literal === undefined) return undefined;
    result[item.key] = String(literal);
  }
  return result;
}
