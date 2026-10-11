#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMappingStore } from "../src/mapping-store.mjs";

const usage = `Usage:
  node apps/kiosk/scripts/prepare-legacy-fingerprint-import.mjs --roster old-roster.csv --mappings old-mappings.json --out-dir ./legacy-import

The tool reads exported files only. It does not connect to the old installation, query Cloudflare, or extract templates from the R503 sensor.`;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase().replace(/[^a-z0-9]/g, ""));
  return lines.slice(1).map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
}

function csvCell(value = "") {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function memberId(row) {
  return row.memberid || row.member || row.externalid || row.studentid || row.id || "";
}

function splitName(row) {
  const firstName = row.firstname || row.first || row.givenname || "";
  const lastName = row.lastname || row.last || row.familyname || "";
  if (firstName || lastName) return { firstName, lastName };
  const name = row.name || row.fullname || "";
  const parts = name.split(/\s+/).filter(Boolean);
  return { firstName: parts.slice(0, -1).join(" ") || parts[0] || "", lastName: parts.length > 1 ? parts.at(-1) : "" };
}

function normalizeRoster(rows) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const id = memberId(row).trim();
    const { firstName, lastName } = splitName(row);
    if (!id || !firstName.trim() || !lastName.trim() || seen.has(id)) continue;
    seen.add(id);
    output.push({ memberId: id, firstName: firstName.trim(), lastName: lastName.trim(), email: row.email || "", discordUserId: row.discorduserid || "" });
  }
  return output;
}

function mappingRecords(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value).map(([slot, record]) => typeof record === "string" ? { slot, memberId: record } : { slot, ...record });
  }
  throw new Error("Mappings must be a JSON object or array");
}

function normalizeMappings(value) {
  const output = {};
  for (const record of mappingRecords(value)) {
    const slot = String(record.slot ?? record.sensorSlot ?? record.position ?? "").trim();
    const id = String(record.memberId ?? record.memberID ?? record.externalId ?? record.member ?? record.userId ?? "").trim();
    const finger = String(record.finger ?? record.fingerLabel ?? record.label ?? "unspecified").trim().toLowerCase() || "unspecified";
    if (!/^\d{1,3}$/.test(slot) || Number(slot) > 199 || !id) throw new Error(`Invalid legacy mapping for slot ${slot || "(missing)"}`);
    output[slot] = { memberId: id, finger };
  }
  return output;
}

export async function prepareLegacyFingerprintImport({ rosterPath, mappingsPath, outDir }) {
  if (!rosterPath || !mappingsPath || !outDir) throw new Error(usage);
  const roster = normalizeRoster(parseCsv(await readFile(rosterPath, "utf8")));
  const mappings = normalizeMappings(JSON.parse(await readFile(mappingsPath, "utf8")));
  const rosterIds = new Set(roster.map((member) => member.memberId));
  const unmapped = Object.entries(mappings).filter(([, mapping]) => !rosterIds.has(mapping.memberId)).map(([slot, mapping]) => ({ slot, memberId: mapping.memberId }));
  await mkdir(outDir, { recursive: true });
  const rosterCsv = ["memberId,firstName,lastName,email,discordUserId", ...roster.map((member) => [member.memberId, member.firstName, member.lastName, member.email, member.discordUserId].map(csvCell).join(","))].join("\n") + "\n";
  const rosterOut = join(outDir, "lancerlogin-roster-import.csv");
  const mappingsOut = join(outDir, "slot-mappings.json");
  await writeFile(rosterOut, rosterCsv, { mode: 0o600 });
  await createMappingStore(mappingsOut).replace(mappings);
  const reportOut = join(outDir, "import-report.json");
  await writeFile(reportOut, `${JSON.stringify({ rosterCount: roster.length, mappingCount: Object.keys(mappings).length, unmapped }, null, 2)}\n`, { mode: 0o600 });
  return { rosterOut, mappingsOut, reportOut, rosterCount: roster.length, mappingCount: Object.keys(mappings).length, unmapped };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("prepare-legacy-fingerprint-import.mjs")) {
  try {
    const result = await prepareLegacyFingerprintImport({ rosterPath: arg("roster"), mappingsPath: arg("mappings"), outDir: arg("out-dir") });
    console.log(`Prepared ${result.rosterCount} roster rows and ${result.mappingCount} slot mappings.`);
    if (result.unmapped.length) console.log(`${result.unmapped.length} mappings refer to member IDs not found in the roster import. Review import-report.json before copying mappings to the Pi.`);
    console.log(`Roster CSV: ${result.rosterOut}`);
    console.log(`Slot mappings: ${result.mappingsOut}`);
    console.log(`Report: ${result.reportOut}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
