import assert from "node:assert/strict";

/** Style rule selector lists and keyframe names in a stylesheet, outside comments and nested at-rule preludes. */
export function stylesheetRules(css: string) {
  const rules: { selectors: string[]; keyframes?: string }[] = [];
  const stack: string[] = [];
  let start = 0;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "{") {
      const prelude = source.slice(start, index).trim();
      const kind = /^@(media|supports|layer|container)\b/.test(prelude) ? "group" : prelude.startsWith("@keyframes") ? "keyframes" : stack.at(-1) === "keyframes" ? "frame" : "rule";
      if (kind === "keyframes") rules.push({ selectors: [], keyframes: prelude.slice("@keyframes".length).trim() });
      if (kind === "rule") {
        const selectors: string[] = []; let depth = 0; let current = "";
        for (const item of prelude) { if ("([".includes(item)) depth++; if (")]".includes(item)) depth--; if (item === "," && depth === 0) { selectors.push(current.trim()); current = ""; } else current += item; }
        rules.push({ selectors: [...selectors, current.trim()] });
      }
      stack.push(kind); start = index + 1;
    } else if (character === "}") { stack.pop(); start = index + 1; }
    else if (character === ";") start = index + 1;
  }
  assert.equal(stack.length, 0, "stylesheet braces must balance");
  return rules;
}
