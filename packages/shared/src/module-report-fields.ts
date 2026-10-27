// Report field helpers shared by Core and module manifests. This module imports no installed manifests, so a plugin manifest
// can call these functions while the module registry is still loading it.
import type { ReportFieldDefinition, ReportFilterOperator } from "./module-platform.ts";

export function reportFilterOperators(valueType: "text" | "number" | "date"): readonly ReportFilterOperator[] {
  return valueType === "text" ? ["contains", "equals", "empty", "not_empty"] : valueType === "date" ? ["contains", "equals", "minimum", "maximum", "between", "empty", "not_empty"] : ["minimum", "equals", "maximum", "between", "empty", "not_empty"];
}

/**
 * Roster fields shared by every member-level dataset. Module datasets keyed by `core.member.identity` reuse them unchanged.
 */
export function coreMemberReportFieldDefinitions(): ReportFieldDefinition[] {
  return [
  { id: "core.member.identity", label: "Member record ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "core.member.name", label: "Member", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "core.member.id", label: "Member ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "core.member.email", label: "Email", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "core.member.discord-id", label: "Discord ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "core.member.status", label: "Roster status", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: reportFilterOperators("text") },
  { id: "core.member.labels", label: "Current labels", group: "Roster", kind: "dimension", valueType: "text", sortable: false, filterOperators: reportFilterOperators("text") },
];
}
