import { createElement, Fragment, type ReactNode } from "react";

/**
 * A small Markdown renderer for release notes, which are remote content: GitHub release bodies and the notes a web update
 * pinned. It builds React elements and never HTML strings, so markup in the notes is shown as text. Links open only
 * http: and https: addresses, in a new tab without a referrer or opener; relative links resolve against the release page
 * when one is known and are otherwise shown as text. Images are never loaded: each becomes a link to the image, or its
 * alt text. Covers what GitHub release notes use: headings, paragraphs, nested bullet and numbered lists, block quotes,
 * fenced code, horizontal rules, GitHub tables, bold, italic, strikethrough, inline code, links and bare URLs.
 * Every pattern is matched in linear time, so hostile notes cannot stall the page.
 */

export type NotesInline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "del"; children: NotesInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href?: string; children: NotesInline[] }
  | { type: "image"; href?: string; alt: string }
  | { type: "break" };
export type NotesAlign = "left" | "center" | "right" | undefined;
export type NotesBlock =
  | { type: "heading"; level: number; children: NotesInline[] }
  | { type: "paragraph"; children: NotesInline[] }
  | { type: "list"; ordered: boolean; start: number; loose: boolean; items: NotesBlock[][] }
  | { type: "quote"; children: NotesBlock[] }
  | { type: "code"; text: string; language: string }
  | { type: "rule" }
  | { type: "table"; align: NotesAlign[]; head: NotesInline[][]; rows: NotesInline[][][] };

/** Longer notes are cut here; update-release.ts already keeps 32,000 characters of a release body. */
export const releaseNotesMaxLength = 40_000;
/** Lists and quotes nested deeper than this, and emphasis or links nested deeper than this, stay text. */
const depthLimit = 12;
/** Tables wider than this are not tables, and rows past the cell budget are left as text. */
const tableColumnLimit = 32;
const tableCellLimit = 4_000;
/** How far a link label may run before its closing bracket. */
const linkLabelLimit = 1_000;

const entityNames: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", times: "×", rarr: "→", larr: "←" };
/** Decodes HTML character references to plain characters. The result is only ever used as text or checked as a URL. */
export function decodeEntities(value: string) {
  return value.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, name: string) => {
    if (name[0] !== "#") return entityNames[name] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

/** An http: or https: address for a link, resolved against base when relative; otherwise undefined and shown as text. */
export function releaseNotesHref(raw: string, base?: string) {
  const value = decodeEntities(raw.trim());
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) return undefined;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

const escapable = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const isSpace = (value: string | undefined) => value === undefined || /\s/.test(value);
const isWordCharacter = (value: string | undefined) => value !== undefined && /[\p{L}\p{N}]/u.test(value);
const backtickRun = (text: string, index: number) => { let end = index; while (text[end] === "`") end += 1; return end - index; };

/** Links inside a link label, which HTML cannot nest, keep only their text. */
function unlink(nodes: NotesInline[]): NotesInline[] {
  return nodes.flatMap((node): NotesInline[] => node.type === "link" ? unlink(node.children) : node.type === "break" ? [{ type: "text", text: " " }] : "children" in node ? [{ ...node, children: unlink(node.children) }] : [node]);
}
function plainText(nodes: NotesInline[]): string {
  return nodes.map((node) => node.type === "text" || node.type === "code" ? node.text : node.type === "image" ? node.alt : node.type === "break" ? " " : "children" in node ? plainText(node.children) : "").join("");
}

class InlineParser {
  // Per text being parsed: a closer that is missing after some position is missing after every later one too.
  private missing = new Map<string, number>();
  private readonly base: string | undefined;
  constructor(base: string | undefined) { this.base = base; }

  parse(text: string, depth = 0): NotesInline[] {
    const outer = this.missing; this.missing = new Map();
    try { return this.run(text, depth); } finally { this.missing = outer; }
  }

  private run(text: string, depth: number): NotesInline[] {
    const output: NotesInline[] = [];
    let buffer = "";
    const flush = () => { if (buffer) { output.push({ type: "text", text: decodeEntities(buffer) }); buffer = ""; } };
    const push = (node: NotesInline) => { flush(); output.push(node); };
    let index = 0;
    while (index < text.length) {
      const character = text[index]!;
      if (character === "\\" && index + 1 < text.length) {
        const next = text[index + 1]!;
        if (next === "\n") { push({ type: "break" }); index += 2; continue; }
        if (escapable.test(next)) { flush(); output.push({ type: "text", text: next }); index += 2; continue; }
      }
      if (character === "\n") {
        // A line break inside a paragraph is kept, as GitHub shows it in release notes.
        buffer = buffer.trimEnd(); push({ type: "break" }); index += 1;
        while (text[index] === " ") index += 1;
        continue;
      }
      if (character === "`") {
        const length = backtickRun(text, index);
        const close = this.closingBackticks(text, index + length, length);
        if (close >= 0) {
          let code = text.slice(index + length, close).replace(/\n/g, " ");
          if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
          push({ type: "code", text: code }); index = close + length; continue;
        }
        buffer += "`".repeat(length); index += length; continue;
      }
      if ((character === "!" && text[index + 1] === "[") || character === "[") {
        const image = character === "!";
        const link = depth < depthLimit ? this.link(text, index + (image ? 1 : 0)) : undefined;
        if (link) {
          const label = this.parse(link.label, depth + 1);
          push(image ? { type: "image", href: link.href, alt: plainText(label) } : { type: "link", href: link.href, children: unlink(label) });
          index = link.end; continue;
        }
      }
      if (character === "<") {
        const autolink = /^<(https?:\/\/[^\s<>]+)>/i.exec(text.slice(index, index + 2048));
        if (autolink) {
          const href = releaseNotesHref(autolink[1]!, this.base);
          push(href ? { type: "link", href, children: [{ type: "text", text: autolink[1]! }] } : { type: "text", text: autolink[0] });
          index += autolink[0].length; continue;
        }
      }
      if ((character === "h" || character === "H") && !isWordCharacter(text[index - 1]) && /^https?:\/\//i.test(text.slice(index, index + 8))) {
        const bare = this.bareUrl(text, index);
        if (bare) { push({ type: "link", href: bare.href, children: [{ type: "text", text: bare.text }] }); index += bare.text.length; continue; }
      }
      if (character === "*" || character === "_" || character === "~") {
        const run = text[index + 1] === character ? character + character : character;
        if (character === "~" && run.length === 1) { buffer += character; index += 1; continue; }
        const close = depth < depthLimit ? this.emphasis(text, index, run) : undefined;
        if (close !== undefined) {
          push({ type: character === "~" ? "del" : run.length === 2 ? "strong" : "em", children: this.parse(text.slice(index + run.length, close), depth + 1) });
          index = close + run.length; continue;
        }
        buffer += run; index += run.length; continue;
      }
      buffer += character; index += 1;
    }
    flush();
    return output;
  }

  private closingBackticks(text: string, from: number, length: number) {
    const key = "`" + length;
    if ((this.missing.get(key) ?? Infinity) <= from) return -1;
    let position = from;
    while ((position = text.indexOf("`", position)) >= 0) {
      const run = backtickRun(text, position);
      if (run === length) return position;
      position += run;
    }
    this.missing.set(key, Math.min(this.missing.get(key) ?? Infinity, from));
    return -1;
  }

  /** Where emphasis opening at index closes, or undefined when it does not open or never closes. */
  private emphasis(text: string, index: number, run: string) {
    if (isSpace(text[index + run.length])) return undefined;
    // Underscores inside words, as in LANCERLOGIN_WEB_UPDATE_TOKEN, are not emphasis.
    if (run[0] === "_" && isWordCharacter(text[index - 1])) return undefined;
    if ((this.missing.get(run) ?? Infinity) <= index) return undefined;
    let position = index + run.length;
    while ((position = text.indexOf(run, position + 1)) >= 0) {
      // A single marker is never part of a longer run: *a **b** c* closes at the last *.
      if (run.length === 1 && (text[position + 1] === run || text[position - 1] === run)) { while (text[position + 1] === run) position += 1; continue; }
      if (text[position - 1] === "\\" || isSpace(text[position - 1])) continue;
      if (run[0] === "_" && isWordCharacter(text[position + run.length])) continue;
      return position;
    }
    this.missing.set(run, Math.min(this.missing.get(run) ?? Infinity, index));
    return undefined;
  }

  /** [label](destination "title") with its bracket at index, and where it ends. */
  private link(text: string, index: number) {
    let depth = 0; let position = index; const limit = Math.min(text.length, index + linkLabelLimit);
    for (; position < limit; position += 1) {
      const character = text[position];
      if (character === "\\") { position += 1; continue; }
      if (character === "`") { const length = backtickRun(text, position); const close = this.closingBackticks(text, position + length, length); position = (close >= 0 ? close : position) + length - 1; continue; }
      if (character === "[") depth += 1;
      else if (character === "]" && --depth === 0) break;
    }
    if (position >= limit || text[position + 1] !== "(") return undefined;
    const destination = linkDestination(text, position + 2);
    if (!destination) return undefined;
    return { label: text.slice(index + 1, position), href: releaseNotesHref(destination.raw.replace(/\\([!-/:-@[-`{-~])/g, "$1"), this.base), end: destination.end };
  }

  /** A bare http(s) address, without trailing punctuation or an unmatched closing parenthesis. */
  private bareUrl(text: string, index: number) {
    const match = /^https?:\/\/[^\s<>`]+/i.exec(text.slice(index, index + 2048))?.[0];
    if (!match) return undefined;
    let value: string = match;
    for (;;) {
      const trimmed: string = value.replace(/[.,:;!?'"*_~]+$/, "");
      const next: string = trimmed.endsWith(")") && (trimmed.split("(").length < trimmed.split(")").length) ? trimmed.slice(0, -1) : trimmed;
      if (next === value) break;
      value = next;
    }
    const href = releaseNotesHref(value, this.base);
    return href ? { href, text: value } : undefined;
  }
}

/** The destination and optional title after "](", read in one pass. */
function linkDestination(text: string, start: number) {
  let position = start;
  const skipSpaces = () => { while (position < text.length && /[ \n]/.test(text[position]!)) position += 1; };
  skipSpaces();
  let raw = "";
  if (text[position] === "<") {
    const close = text.indexOf(">", position);
    if (close < 0 || /[<\n]/.test(text.slice(position + 1, close))) return undefined;
    raw = text.slice(position + 1, close); position = close + 1;
  } else {
    let depth = 0; const begin = position;
    for (; position < text.length; position += 1) {
      const character = text[position]!;
      if (character === "\\") { position += 1; continue; }
      if (/\s/.test(character)) break;
      if (character === "(") { if (++depth > 32) return undefined; }
      else if (character === ")") { if (depth === 0) break; depth -= 1; }
    }
    raw = text.slice(begin, position);
  }
  const beforeTitle = position;
  skipSpaces();
  const opener = text[position];
  if ((opener === "\"" || opener === "'" || opener === "(") && position > beforeTitle) {
    const close = text.indexOf(opener === "(" ? ")" : opener, position + 1);
    if (close < 0) return undefined;
    position = close + 1; skipSpaces();
  }
  return text[position] === ")" ? { raw, end: position + 1 } : undefined;
}

const indentOf = (line: string) => { let count = 0; while (line[count] === " ") count += 1; return count; };
const blank = (line: string | undefined) => line === undefined || line.trim() === "";
const listItem = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const quote = /^ {0,3}> ?(.*)$/;
const rule = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const setext = /^ {0,3}(=+|-+)[ \t]*$/;

function fenceOpening(line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || match[1]![0] === "`" && match[2]!.includes("`")) return undefined;
  return { marker: match[1]!, indent: indentOf(line), language: match[2]!.trim().split(/\s+/)[0] ?? "" };
}
function isFenceClose(line: string, marker: string) {
  const trimmed = line.trimEnd(); const indent = indentOf(trimmed);
  if (indent > 3) return false;
  const rest = trimmed.slice(indent);
  return rest.length >= marker.length && [...rest].every((character) => character === marker[0]);
}
function headingOf(line: string) {
  const match = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
  if (!match) return undefined;
  let content = line.slice(match[0].length).trim();
  // A closing run of # is dropped when it stands apart: "## Notes ##".
  const end = content.length; let hashes = end; while (hashes > 0 && content[hashes - 1] === "#") hashes -= 1;
  if (hashes < end && (hashes === 0 || content[hashes - 1] === " " || content[hashes - 1] === "\t")) content = content.slice(0, hashes).trim();
  return { level: match[1]!.length, content };
}
function tableCells(line: string) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells: string[] = []; let current = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] === "|") { current += "|"; index += 1; }
    else if (value[index] === "|") { cells.push(current.trim()); current = ""; if (cells.length > tableColumnLimit) return cells; }
    else current += value[index];
  }
  cells.push(current.trim());
  return cells;
}
function tableAlignment(line: string) {
  if (!line.includes("-")) return undefined;
  const cells = tableCells(line);
  if (cells.length > tableColumnLimit || !cells.every((cell) => /^:?-+:?$/.test(cell))) return undefined;
  return cells.map((cell): NotesAlign => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined);
}
function tableStart(line: string, next: string | undefined) {
  if (!line.includes("|") || next === undefined) return undefined;
  const align = tableAlignment(next);
  return align && align.length === tableCells(line).length && (align.length > 1 || line.trim().startsWith("|") || next.trim().startsWith("|")) ? align : undefined;
}

class BlockParser {
  private readonly inline: InlineParser;
  constructor(inline: InlineParser) { this.inline = inline; }

  /** Whether line starts a block that ends a paragraph. A numbered list interrupts one only when it starts at 1. */
  private interrupts(line: string, next: string | undefined) {
    const item = listItem.exec(line);
    return Boolean(fenceOpening(line) || headingOf(line) || rule.test(line) || quote.test(line) || item && !blank(item[4]) && (!/\d/.test(item[2]!) || /^1[.)]$/.test(item[2]!)) || tableStart(line, next));
  }

  parse(lines: string[], depth = 0): NotesBlock[] {
    const blocks: NotesBlock[] = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      if (blank(line)) { index += 1; continue; }
      const fence = fenceOpening(line);
      if (fence) {
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !isFenceClose(lines[index]!, fence.marker)) { const current = lines[index]!; body.push(current.slice(Math.min(fence.indent, indentOf(current)))); index += 1; }
        index += 1;
        blocks.push({ type: "code", text: body.join("\n"), language: fence.language });
        continue;
      }
      const title = headingOf(line);
      if (title) { blocks.push({ type: "heading", level: title.level, children: this.inline.parse(title.content) }); index += 1; continue; }
      if (rule.test(line)) { blocks.push({ type: "rule" }); index += 1; continue; }
      if (quote.test(line) && depth < depthLimit) {
        const body: string[] = [];
        while (index < lines.length && !blank(lines[index])) {
          const match = quote.exec(lines[index]!);
          if (!match && this.interrupts(lines[index]!, lines[index + 1])) break;
          body.push(match ? match[1]! : lines[index]!); index += 1;
        }
        blocks.push({ type: "quote", children: this.parse(body, depth + 1) });
        continue;
      }
      const item = listItem.exec(line);
      if (item && depth < depthLimit && (!blank(item[4]) || !blank(lines[index + 1]) && indentOf(lines[index + 1]!) > indentOf(line))) { index = this.list(lines, index, depth, blocks); continue; }
      const align = tableStart(line, lines[index + 1]);
      if (align) {
        const head = tableCells(line).map((cell) => this.inline.parse(cell));
        const rows: NotesInline[][][] = [];
        index += 2;
        while (index < lines.length && !blank(lines[index]) && lines[index]!.includes("|") && (rows.length + 2) * align.length <= tableCellLimit) {
          const cells = tableCells(lines[index]!);
          rows.push(head.map((_, column) => this.inline.parse(cells[column] ?? "")));
          index += 1;
        }
        blocks.push({ type: "table", align, head, rows });
        continue;
      }
      const paragraph: string[] = [line.trim()];
      index += 1;
      while (index < lines.length && !blank(lines[index]) && !setext.test(lines[index]!) && !this.interrupts(lines[index]!, lines[index + 1])) { paragraph.push(lines[index]!.trim()); index += 1; }
      const underline = index < lines.length ? setext.exec(lines[index]!) : null;
      if (underline) { blocks.push({ type: "heading", level: underline[1]![0] === "=" ? 1 : 2, children: this.inline.parse(paragraph.join("\n")) }); index += 1; continue; }
      blocks.push({ type: "paragraph", children: this.inline.parse(paragraph.join("\n")) });
    }
    return blocks;
  }

  /** Reads one list from index into blocks and returns the index after it. Deeper-indented lines belong to an item. */
  private list(lines: string[], index: number, depth: number, blocks: NotesBlock[]) {
    const first = listItem.exec(lines[index]!)!;
    const ordered = /\d/.test(first[2]!);
    const kind = first[2]!.slice(-1);
    const baseIndent = first[1]!.length;
    const items: string[][] = [];
    let loose = false;
    while (index < lines.length) {
      const marker = listItem.exec(lines[index]!);
      if (!marker || marker[1]!.length > baseIndent + 1 || /\d/.test(marker[2]!) !== ordered || marker[2]!.slice(-1) !== kind) break;
      const spaces = marker[3]?.length ?? 1;
      const contentIndent = marker[1]!.length + marker[2]!.length + (spaces > 4 ? 1 : spaces);
      const content: string[] = [marker[4] ?? ""];
      index += 1;
      while (index < lines.length) {
        const current = lines[index]!;
        if (blank(current)) {
          // A blank line belongs to the item only when more of the item follows it.
          let ahead = index + 1; while (ahead < lines.length && blank(lines[ahead])) ahead += 1;
          if (ahead < lines.length && indentOf(lines[ahead]!) > baseIndent + 1) { for (; index < ahead; index += 1) content.push(""); loose = true; continue; }
          break;
        }
        const indent = indentOf(current);
        if (indent > baseIndent + 1) { content.push(current.slice(Math.min(indent, contentIndent))); index += 1; continue; }
        // A lazy continuation line carries on the item's paragraph.
        if (!blank(content[content.length - 1]) && !listItem.test(current) && !this.interrupts(current, lines[index + 1])) { content.push(current.trim()); index += 1; continue; }
        break;
      }
      items.push(content);
      if (index < lines.length && blank(lines[index])) {
        let ahead = index; while (ahead < lines.length && blank(lines[ahead])) ahead += 1;
        const next = ahead < lines.length ? listItem.exec(lines[ahead]!) : null;
        if (!next || next[1]!.length > baseIndent + 1 || /\d/.test(next[2]!) !== ordered || next[2]!.slice(-1) !== kind) break;
        loose = true; index = ahead;
      }
    }
    blocks.push({ type: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, loose, items: items.map((content) => this.parse(content, depth + 1)) });
    return index;
  }
}

/** Removes HTML comments, such as the ones GitHub's generated release notes carry, in one pass. */
function withoutComments(text: string) {
  let output = ""; let position = 0;
  for (;;) {
    const open = text.indexOf("<!--", position);
    if (open < 0) return output + text.slice(position);
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return output + text.slice(position);
    output += text.slice(position, open); position = close + 3;
  }
}

/** Parses release notes Markdown into blocks. base, the release page, resolves relative links such as compare links. */
export function parseReleaseNotes(source: string, base?: string): NotesBlock[] {
  const text = withoutComments(source.slice(0, releaseNotesMaxLength).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/\u0000/g, "�"));
  return new BlockParser(new InlineParser(base ? releaseNotesHref(base) : undefined)).parse(text.split("\n"));
}

const external = { target: "_blank", rel: "noopener noreferrer" } as const;
function inlineElements(nodes: NotesInline[]): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.type) {
      case "text": return node.text;
      case "break": return createElement("br", { key });
      case "code": return createElement("code", { key }, node.text);
      case "strong": case "em": case "del": return createElement(node.type, { key }, ...inlineElements(node.children));
      case "link": return node.href ? createElement("a", { key, href: node.href, ...external }, ...inlineElements(node.children)) : createElement(Fragment, { key }, ...inlineElements(node.children));
      case "image": {
        const label = `Image: ${node.alt.trim() || "untitled"}`;
        return node.href ? createElement("a", { key, href: node.href, className: "release-notes-image", ...external }, label) : createElement("span", { key, className: "release-notes-image" }, label);
      }
    }
  });
}

function listItemElements(item: NotesBlock[], loose: boolean, headingOffset: number): ReactNode[] {
  // A tight list shows each item's text without paragraph spacing, as GitHub does.
  return loose ? blockElements(item, headingOffset) : item.map((child, key) => child.type === "paragraph" ? createElement(Fragment, { key }, ...inlineElements(child.children)) : blockElements([child], headingOffset, key)[0]);
}

function blockElements(blocks: NotesBlock[], headingOffset: number, firstKey = 0): ReactNode[] {
  return blocks.map((block, position) => {
    const key = firstKey + position;
    switch (block.type) {
      case "heading": return createElement(`h${Math.min(6, block.level + headingOffset)}`, { key, className: `release-notes-heading release-notes-heading-${Math.min(block.level, 3)}` }, ...inlineElements(block.children));
      case "paragraph": return createElement("p", { key }, ...inlineElements(block.children));
      case "rule": return createElement("hr", { key });
      case "code": return createElement("pre", { key, tabIndex: 0 }, createElement("code", null, block.text));
      case "quote": return createElement("blockquote", { key }, ...blockElements(block.children, headingOffset));
      case "list": return createElement(block.ordered ? "ol" : "ul", { key, ...(block.ordered && block.start !== 1 ? { start: block.start } : {}) }, ...block.items.map((item, itemKey) => createElement("li", { key: itemKey }, ...listItemElements(item, block.loose, headingOffset))));
      case "table": {
        const style = (column: number) => block.align[column] ? { textAlign: block.align[column] } : undefined;
        return createElement("div", { key, className: "release-notes-table", tabIndex: 0, role: "region", "aria-label": "Release notes table" }, createElement("table", null,
          createElement("thead", null, createElement("tr", null, ...block.head.map((cell, column) => createElement("th", { key: column, scope: "col", style: style(column) }, ...inlineElements(cell))))),
          block.rows.length ? createElement("tbody", null, ...block.rows.map((row, rowKey) => createElement("tr", { key: rowKey }, ...row.map((cell, column) => createElement("td", { key: column, style: style(column) }, ...inlineElements(cell)))))) : null));
      }
    }
  });
}

/**
 * Release notes as React elements. headingLevel is the level of the heading the notes sit under: a # heading in the notes
 * is one level below it, so the page outline stays in order.
 */
export function ReleaseNotes({ markdown, base, headingLevel = 3 }: { markdown: string; base?: string; headingLevel?: number }) {
  return createElement("div", { className: "release-notes" }, ...blockElements(parseReleaseNotes(markdown, base), headingLevel));
}
