#!/usr/bin/env node
// Measures, inside workerd (Miniflare), the CPU the attendance impact previews, the evaluator, a preview token and a
// member PIN check take for the reference team (150 members, 12 labels, 300 meetings; tests-ts/fixtures/attendance-team.ts).
// Workers Free allows about 10 ms of CPU per request. Run from the repository root:
//
//   node scripts/measure-attendance-preview-cpu.mjs
//
// Each figure is wall time of synchronous work in a local workerd, which is CPU time on this machine, not on Cloudflare:
// compare runs with each other and treat the absolute numbers as a guide. "first" is the first run in a new isolate, before
// anything is compiled, as after a deploy or an idle period; "warm" is the median of later runs. Synthetic data only.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const worker = `
import { evaluateAttendance, evaluateAttendanceOutline } from "./apps/api/src/attendance-policy.ts";
import { meetingChangeImpact, policyChangeImpact } from "./apps/api/src/attendance-impact.ts";
import { referenceNow as now, referenceTeam } from "./tests-ts/fixtures/attendance-team.ts";
let data;
const digest = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))[0];
const pin = async (iterations) => new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16).fill(7), iterations }, await crypto.subtle.importKey("raw", new TextEncoder().encode("482913"), "PBKDF2", false, ["deriveBits"]), 256))[0];
export default { async fetch(request) {
  const url = new URL(request.url), work = url.searchParams.get("work"), runs = Number(url.searchParams.get("runs"));
  data ??= referenceTeam();
  const rule = data.rules.find((item) => item.ruleType === "weighted_percentage");
  const rules = [...data.rules.filter((item) => item.id !== rule.id), { ...rule, thresholdPercent: 95 }];
  const closed = data.meetings.find((meeting) => meeting.audienceMode === "all" && Date.parse(meeting.attendanceClosesAt) < Date.parse(now));
  const all = {
    "policy preview: one label's rule": () => policyChangeImpact(data, rules, data.recentDays, now).length + " members affected",
    "policy preview: recent window": () => policyChangeImpact(data, data.rules, 14, now).length + " members affected",
    "meeting preview: made optional": () => meetingChangeImpact(data, { ...closed, required: !closed.required }, now).length + " members affected",
    "meeting preview: one label only": () => meetingChangeImpact(data, { ...closed, audienceMode: "labels", audienceLabelIds: [data.labels[0].id] }, now).length + " members affected",
    "evaluateAttendance (reports)": () => evaluateAttendance({ ...data, now }).length + " members",
    "evaluateAttendanceOutline": () => evaluateAttendanceOutline({ ...data, now }).length + " members",
    "state digest, once per loaded data": async () => { const text = JSON.stringify(data); return text.length + " bytes, " + await digest(text); },
    "PIN check, 100,000 iterations": () => pin(100_000),
    "PIN check, 2,000 iterations": () => pin(2_000),
  };
  if (!work) return Response.json(Object.keys(all));
  const started = performance.now(); let result;
  for (let run = 0; run < runs; run += 1) result = await all[work]();
  return Response.json({ ms: runs ? (performance.now() - started) / runs : 0, result: String(result) });
} };`;

const bundled = await build({ stdin: { contents: worker, resolveDir: process.cwd(), loader: "js" }, bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022" });
const isolate = async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-01" }));
  const call = async (work, runs) => (await runtime.dispatchFetch(`https://measure.test/?${new URLSearchParams(work ? { work, runs: String(runs) } : {})}`)).json();
  return { runtime, call, names: await call() };
};
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const { runtime: first, names } = await isolate(); await first.dispose();
console.log(`${"".padEnd(38)}${"first".padStart(10)}${"warm".padStart(10)}`);
for (const name of names) {
  // A new isolate for each measurement, so none is warmed by another; the listing above has already built the team.
  const { runtime, call } = await isolate();
  try {
    const cold = await call(name, 1);
    await call(name, 20);
    const warm = median(await Array.fromAsync({ length: 7 }, async () => (await call(name, 10)).ms));
    console.log(`${name.padEnd(38)}${(cold.ms.toFixed(1) + " ms").padStart(10)}${(warm.toFixed(2) + " ms").padStart(10)}   ${cold.result}`);
  } finally { await runtime.dispose(); }
}
