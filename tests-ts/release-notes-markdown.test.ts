import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseReleaseNotes, ReleaseNotes, releaseNotesHref } from "../apps/dashboard/src/release-notes-markdown.ts";

const render = (markdown: string, base?: string, headingLevel?: number) => renderToStaticMarkup(createElement(ReleaseNotes, { markdown, base, headingLevel }));
const releasePage = "https://github.com/isriah/LancerLogin/releases/tag/v2.1.0-beta.10";

test("a published release body renders its headings, nested lists, bold, code and links", () => {
  const notes = [
    "# LancerLogin v2.1.0-beta.10",
    "",
    "This beta makes waiting kiosk PIN requests hard to miss, with a **PIN requests** count in the top bar.",
    "",
    "## Updating to this release",
    "",
    "- **Update your deployment repository's workflow file.** The `latest beta` choice lives in your copy, as described in [Keep your repository's workflow files current](https://isriah.github.io/LancerLogin/updates.html#repository-files-by-hand).",
    "- **Discord kiosk codes.** A member can sign in with a code:",
    "  - A code works once and expires after 2 minutes.",
    "  - Codes need a network connection.",
    "",
    "## Features removed",
    "",
    "None.",
  ].join("\n");
  assert.equal(render(notes),
    "<div class=\"release-notes\">"
    + "<h4 class=\"release-notes-heading release-notes-heading-1\">LancerLogin v2.1.0-beta.10</h4>"
    + "<p>This beta makes waiting kiosk PIN requests hard to miss, with a <strong>PIN requests</strong> count in the top bar.</p>"
    + "<h5 class=\"release-notes-heading release-notes-heading-2\">Updating to this release</h5>"
    + "<ul><li><strong>Update your deployment repository&#x27;s workflow file.</strong> The <code>latest beta</code> choice lives in your copy, as described in <a href=\"https://isriah.github.io/LancerLogin/updates.html#repository-files-by-hand\" target=\"_blank\" rel=\"noopener noreferrer\">Keep your repository&#x27;s workflow files current</a>.</li>"
    + "<li><strong>Discord kiosk codes.</strong> A member can sign in with a code:<ul><li>A code works once and expires after 2 minutes.</li><li>Codes need a network connection.</li></ul></li></ul>"
    + "<h5 class=\"release-notes-heading release-notes-heading-2\">Features removed</h5>"
    + "<p>None.</p></div>");
});

test("every construct GitHub release notes use renders as its element", () => {
  const html = render([
    "Setext title", "============", "",
    "Plain *italic*, _also italic_, ***both*** and ~~struck~~ text with LANCERLOGIN_WEB_UPDATE_TOKEN left alone.", "",
    "1. First", "2. Second", "   1. Nested numbered", "   2. Again", "3. Third", "",
    "5) Starts at five", "",
    "> A quoted note", "> on two lines", "",
    "```bash", "npm ci", "<b>not bold</b>", "```", "",
    "---", "",
    "| Area | Change |", "| :--- | ---: |", "| Kiosk | **Faster** |", "| Docs \\| guides | `code` |", "",
    "Full changelog: https://github.com/isriah/LancerLogin/compare/v2.1.0-beta.9...v2.1.0-beta.10.",
  ].join("\n"));
  assert.match(html, /<h4 class="release-notes-heading release-notes-heading-1">Setext title<\/h4>/);
  assert.match(html, /<em>italic<\/em>, <em>also italic<\/em>/);
  assert.match(html, /<del>struck<\/del>/);
  assert.match(html, /LANCERLOGIN_WEB_UPDATE_TOKEN left alone/);
  assert.match(html, /<ol><li>First<\/li><li>Second<ol><li>Nested numbered<\/li><li>Again<\/li><\/ol><\/li><li>Third<\/li><\/ol>/);
  assert.match(html, /<ol start="5"><li>Starts at five<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>A quoted note<br\/>on two lines<\/p><\/blockquote>/);
  assert.match(html, /<pre tabindex="0"><code>npm ci\n&lt;b&gt;not bold&lt;\/b&gt;<\/code><\/pre>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<th scope="col" style="text-align:left">Area<\/th><th scope="col" style="text-align:right">Change<\/th>/);
  assert.match(html, /<td style="text-align:left">Kiosk<\/td><td style="text-align:right"><strong>Faster<\/strong><\/td>/);
  assert.match(html, /<td style="text-align:left">Docs \| guides<\/td>/);
  assert.match(html, /<a href="https:\/\/github.com\/isriah\/LancerLogin\/compare\/v2.1.0-beta.9...v2.1.0-beta.10" target="_blank" rel="noopener noreferrer">https:\/\/github.com\/isriah\/LancerLogin\/compare\/v2.1.0-beta.9...v2.1.0-beta.10<\/a>\.<\/p>/);
});

test("raw HTML and script tags are shown as text, never as markup", () => {
  const html = render("<script>alert('x')</script>\n\n<img src=x onerror=alert(1)>\n\n<a href=\"javascript:alert(1)\">click</a> <details><summary>open</summary></details>\n\n**<iframe src=//evil.test>**");
  assert.doesNotMatch(html, /<script|<img|<iframe|<details|<summary|<a /);
  assert.match(html, /&lt;script&gt;alert\(&#x27;x&#x27;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>&lt;iframe src=\/\/evil.test&gt;<\/strong>/);
});

test("only http and https links become links, opened in a new tab without opener or referrer", () => {
  const hostile = [
    "[js](javascript:alert(1))", "[js2](JAVASCRIPT:alert(1))", "[tab](java\tscript:alert(1))", "[entity](javascript&#58;alert(1))",
    "[data](data:text/html,<script>alert(1)</script>)", "[vb](vbscript:msgbox)", "[file](file:///etc/passwd)", "[mail](mailto:a@example.test)",
    "<javascript:alert(1)>", "[creds](https://user:pass@example.test/)",
  ];
  for (const markdown of hostile) {
    const html = render(markdown);
    assert.doesNotMatch(html, /<a /, markdown);
    assert.doesNotMatch(html, /href=/, markdown);
  }
  assert.equal(render("[safe](https://example.test/a?b=1&c=2 \"Title\")"), "<div class=\"release-notes\"><p><a href=\"https://example.test/a?b=1&amp;c=2\" target=\"_blank\" rel=\"noopener noreferrer\">safe</a></p></div>");
  assert.match(render("[plain http](http://example.test/)"), /<a href="http:\/\/example.test\/" target="_blank" rel="noopener noreferrer">plain http<\/a>/);
  assert.equal(releaseNotesHref("javascript:alert(1)"), undefined);
  assert.equal(releaseNotesHref(" https://example.test/ "), "https://example.test/");
});

test("relative links resolve against the release page, or stay text without one", () => {
  assert.equal(render("[compare](../compare/v1...v2)"), "<div class=\"release-notes\"><p>compare</p></div>");
  assert.match(render("[compare](../../compare/v1...v2)", releasePage), /<a href="https:\/\/github.com\/isriah\/LancerLogin\/compare\/v1...v2" target="_blank" rel="noopener noreferrer">compare<\/a>/);
  // A base that is not an http(s) page is ignored rather than trusted.
  assert.equal(render("[x](/path)", "javascript:alert(1)//"), "<div class=\"release-notes\"><p>x</p></div>");
});

test("images are never loaded: they become a link to the image or their alt text", () => {
  const html = render("![Screenshot of **Settings**](https://example.test/shot.png) ![](javascript:alert(1)) ![no src]()");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a href="https:\/\/example.test\/shot.png" class="release-notes-image" target="_blank" rel="noopener noreferrer">Image: Screenshot of Settings<\/a>/);
  assert.match(html, /<span class="release-notes-image">Image: untitled<\/span>/);
  assert.match(html, /<span class="release-notes-image">Image: no src<\/span>/);
});

test("HTML entities decode to text without becoming markup", () => {
  assert.equal(render("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#60;b&#62; &#x3C;i&#x3E; &copy; &unknown; &#0; &#xD800; &#99999999;"),
    "<div class=\"release-notes\"><p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt; &lt;i&gt; © &amp;unknown; � � &amp;#99999999;</p></div>");
  assert.equal(render("`&lt;kept&gt;`"), "<div class=\"release-notes\"><p><code>&amp;lt;kept&amp;gt;</code></p></div>");
});

test("unclosed markers stay literal text", () => {
  assert.equal(render("**bold never closes and *italic neither and `code too and [label](not closed and ~~strike"),
    "<div class=\"release-notes\"><p>**bold never closes and *italic neither and `code too and [label](not closed and ~~strike</p></div>");
  // The address of an unclosed link is still a bare URL, which GitHub links too.
  assert.equal(render("[label](https://example.test and more"),
    "<div class=\"release-notes\"><p>[label](<a href=\"https://example.test/\" target=\"_blank\" rel=\"noopener noreferrer\">https://example.test</a> and more</p></div>");
  assert.equal(render("```js\nconst open = true;\n<script>"), "<div class=\"release-notes\"><pre tabindex=\"0\"><code>const open = true;\n&lt;script&gt;</code></pre></div>");
  assert.equal(render("2 * 3 * 4 and a_b_c and snake_case_name"), "<div class=\"release-notes\"><p>2 * 3 * 4 and a_b_c and snake_case_name</p></div>");
  assert.equal(render("\\*not italic\\* and \\[not a link\\](x)"), "<div class=\"release-notes\"><p>*not italic* and [not a link](x)</p></div>");
});

test("HTML comments are hidden and an unclosed one stays text", () => {
  assert.equal(render("<!-- Release notes generated using configuration -->\nVisible"), "<div class=\"release-notes\"><p>Visible</p></div>");
  assert.equal(render("Before <!-- never closed"), "<div class=\"release-notes\"><p>Before &lt;!-- never closed</p></div>");
});

test("very long and deeply nested hostile input renders quickly and within limits", () => {
  const cases = [
    "a".repeat(200_000),
    "*a ".repeat(20_000),
    "**a ".repeat(20_000),
    "_a".repeat(20_000),
    "[".repeat(20_000) + "x",
    "[a](".repeat(10_000),
    "`".repeat(5_000) + "a" + "``".repeat(5_000),
    "<!--".repeat(10_000),
    "> ".repeat(5_000) + "deep quote",
    Array.from({ length: 2_000 }, (_, depth) => " ".repeat(depth * 2) + "- item").join("\n"),
    "|".repeat(5_000) + "\n" + "|-".repeat(5_000) + "\n" + "a|\n".repeat(5_000),
    "| a | b |\n|---|---|\n" + "| x | y |\n".repeat(5_000),
    "#".repeat(10) + " " + " ".repeat(30_000) + "x",
    "```" + " ".repeat(30_000) + "`",
    "https://example.test/" + "(".repeat(10_000),
    "*".repeat(30_000),
    "a\n".repeat(30_000),
  ];
  for (const markdown of cases) {
    const started = performance.now();
    const html = render(markdown);
    assert.ok(performance.now() - started < 1_500, `took too long for ${JSON.stringify(markdown.slice(0, 24))}`);
    assert.ok(html.length < 2_000_000);
  }
  const nested = parseReleaseNotes(Array.from({ length: 100 }, (_, depth) => " ".repeat(depth * 2) + "- level " + depth).join("\n"));
  let depth = 0; let list = nested[0];
  while (list?.type === "list") { depth += 1; list = list.items[0]!.find((block) => block.type === "list"); }
  assert.ok(depth <= 13, `nesting stops at the limit, reached ${depth}`);
  const table = parseReleaseNotes("| a | b |\n|---|---|\n" + "| x | y |\n".repeat(5_000))[0];
  assert.ok(table?.type === "table" && table.rows.length * 2 <= 4_000);
  // Characters past the length limit are not rendered.
  assert.doesNotMatch(render("a".repeat(40_000) + "TAIL"), /TAIL/);
});

test("the current published release body parses without leftover Markdown markers", () => {
  const notes = readFileSync(new URL("./fixtures/release-notes-v2.1.0-beta.10.md", import.meta.url), "utf8");
  const html = render(notes, releasePage);
  assert.doesNotMatch(html.replace(/<code>.*?<\/code>/g, ""), /\*\*|\]\(|^#|\n- /m);
  assert.equal((html.match(/<h5 /g) ?? []).length, 4);
  assert.ok((html.match(/<li>/g) ?? []).length >= 30);
});
