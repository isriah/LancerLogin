import { useState } from "react";
import type { ReportColumnFilter, ReportDataset } from "./saved-reports";

export const reportFilterLabels = { contains: "Contains", minimum: "Minimum", equals: "Equals", maximum: "Maximum", between: "Between", empty: "Is empty", not_empty: "Is not empty" };
export function ReportColumnFilterControl({ field, filter, unit, onChange }: { field: ReportDataset["fields"][number]; filter?: ReportColumnFilter; unit?: string; onChange: (operator: ReportColumnFilter["operator"], value: string, upperValue?: string) => void }) {
  const [operator, setOperator] = useState<ReportColumnFilter["operator"]>(filter?.operator ?? field.filterOperators[0] ?? "contains");
  const [lower, setLower] = useState(filter?.value ?? "");
  const [upper, setUpper] = useState(filter?.upperValue ?? "");
  const empty = operator === "empty" || operator === "not_empty";
  const inputType = field.valueType === "number" ? "number" : field.valueType === "date" && operator !== "contains" ? "date" : "search";
  const invalidRange = operator === "between" && (!lower || !upper || (field.valueType === "number" ? Number(lower) > Number(upper) : lower > upper));
  function selectOperator(next: ReportColumnFilter["operator"]) {
    setOperator(next);
    if (next === "empty" || next === "not_empty") return onChange(next, "");
    const value = field.valueType === "date" && next !== "contains" && !/^\d{4}-\d{2}-\d{2}$/.test(lower) ? "" : lower;
    if (value !== lower) setLower(value);
    if (next !== "between") onChange(next, value);
  }
  return <div className="report-column-filter-control">
    <label className="report-column-filter">Filter condition<select value={operator} onChange={(event) => selectOperator(event.target.value as typeof operator)}>{field.filterOperators.map((value) => <option key={value} value={value}>{reportFilterLabels[value]}</option>)}</select></label>
    {!empty && <label className="report-column-filter">{operator === "between" ? "From" : reportFilterLabels[operator]}{unit ? ` (${unit})` : ""}<input type={inputType} step={field.valueType === "number" ? "any" : undefined} value={lower} onChange={(event) => { setLower(event.target.value); if (operator !== "between") onChange(operator, event.target.value); }} /></label>}
    {operator === "between" && <><label className="report-column-filter">To{unit ? ` (${unit})` : ""}<input type={inputType} step={field.valueType === "number" ? "any" : undefined} value={upper} onChange={(event) => setUpper(event.target.value)} /></label><button className="ui-button" type="button" disabled={invalidRange} onClick={() => onChange(operator, lower, upper)}>Apply range</button><p>Includes both endpoints. Enter the lower value first.</p></>}
    {filter && <button className="ui-button" type="button" onClick={() => { setLower(""); setUpper(""); onChange("contains", ""); }}>Clear filter</button>}
  </div>;
}
