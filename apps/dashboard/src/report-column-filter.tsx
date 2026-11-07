import { useState } from "react";
import { hoursMinutesAsMinutes, minutesAsHoursMinutes } from "./report-view";
import { ReportFilterActions, ReportPopoverHeading } from "./report-filter-popover";
import type { ReportColumnFilter, ReportDataset, ReportDurationUnit } from "./saved-reports";

export const reportFilterLabels = { contains: "Contains", minimum: "Minimum", equals: "Equals", maximum: "Maximum", between: "Between", empty: "Is empty", not_empty: "Is not empty" };
const operatorHelp: Record<ReportColumnFilter["operator"], string> = { contains: "Matches part of the text, ignoring case.", minimum: "Includes the value you enter.", equals: "Matches the value exactly.", maximum: "Includes the value you enter.", between: "Includes both endpoints. Enter the lower value first.", empty: "Rows with no value.", not_empty: "Rows with any value." };

/**
 * One field's filter: a condition and its value. Nothing changes until Apply; Clear removes the filter. H:MM columns take
 * values like 2:00 and store their minutes, the unit H:MM filters have always used.
 */
export function ReportColumnFilterControl({ title, status, field, filter, unit, onBack, onApply, onClear }: { title: string; status: string; field: ReportDataset["fields"][number]; filter?: ReportColumnFilter; unit?: ReportDurationUnit; onBack?: () => void; onApply: (operator: ReportColumnFilter["operator"], value: string, upperValue?: string) => void; onClear: () => void }) {
  const hoursMinutes = unit === "hours_minutes";
  const shown = (value = "") => hoursMinutes ? minutesAsHoursMinutes(value) : value;
  const [operator, setOperator] = useState<ReportColumnFilter["operator"]>(filter?.operator ?? field.filterOperators[0] ?? "contains");
  const [lower, setLower] = useState(shown(filter?.value));
  const [upper, setUpper] = useState(shown(filter?.upperValue));
  const empty = operator === "empty" || operator === "not_empty";
  const dateInput = field.valueType === "date" && operator !== "contains";
  const inputType = hoursMinutes ? "text" : field.valueType === "number" ? "number" : dateInput ? "date" : "search";
  const parse = (value: string) => {
    const text = value.trim();
    if (!text) return undefined;
    if (hoursMinutes) return hoursMinutesAsMinutes(text);
    if (field.valueType === "number") return Number.isFinite(Number(text)) ? text : undefined;
    if (dateInput) return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
    return text;
  };
  const lowerValue = parse(lower), upperValue = parse(upper);
  const invalidRange = operator === "between" && lowerValue !== undefined && upperValue !== undefined && (field.valueType === "number" ? Number(lowerValue) > Number(upperValue) : lowerValue > upperValue);
  const canApply = empty || lowerValue !== undefined && (operator !== "between" || upperValue !== undefined && !invalidRange);
  const unitText = hoursMinutes ? " (H:MM)" : unit === "hours" ? " (hours)" : unit ? " (minutes)" : "";
  const invalidEntry = hoursMinutes && (lower.trim() && lowerValue === undefined || upper.trim() && upperValue === undefined);
  function selectOperator(next: ReportColumnFilter["operator"]) {
    setOperator(next);
    if (field.valueType === "date" && next !== "contains" && !/^\d{4}-\d{2}-\d{2}$/.test(lower)) setLower("");
  }
  const input = (label: string, value: string, set: (value: string) => void) => <label className="report-column-filter">{label}{unitText}<input type={inputType} inputMode={hoursMinutes ? "numeric" : undefined} placeholder={hoursMinutes ? "0:00" : undefined} step={inputType === "number" ? "any" : undefined} aria-invalid={hoursMinutes && value.trim() && parse(value) === undefined ? true : undefined} value={value} onChange={(event) => set(event.target.value)} /></label>;
  return <form className="report-filter-form report-column-filter-control" onSubmit={(event) => { event.preventDefault(); if (!canApply) return; if (empty) onApply(operator, ""); else onApply(operator, lowerValue!, operator === "between" ? upperValue : undefined); }}>
    <ReportPopoverHeading title={title} status={status} onBack={onBack} />
    <label className="report-column-filter">Filter condition<select value={operator} onChange={(event) => selectOperator(event.target.value as typeof operator)}>{field.filterOperators.map((value) => <option key={value} value={value}>{reportFilterLabels[value]}</option>)}</select></label>
    {!empty && input(operator === "between" ? "From" : reportFilterLabels[operator], lower, setLower)}
    {operator === "between" && input("To", upper, setUpper)}
    <p className="report-filter-popover-help">{hoursMinutes ? "Hours and minutes, like 1:30. " : ""}{operatorHelp[operator]}</p>
    {(invalidEntry || invalidRange) && <p className="ui-status" data-tone="error" role="alert">{invalidEntry ? "Enter hours and minutes, like 1:30." : "The first value must not be greater than the second."}</p>}
    <ReportFilterActions canApply={canApply} onClear={onClear} />
  </form>;
}
