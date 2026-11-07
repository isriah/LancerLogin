import { ColumnIcon, placeReportPopover, reportPopoverHost } from "./report-filter-popover";
import { createPortal } from "react-dom";
import "./mobile-roster-reports.css";
import { reportDisplayDataset } from "./member-report-types";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { RouteLink } from "./router";
import { countText } from "./report-view";
import { CalcTip, InfoTip } from "./info-tip";
import { attendanceFieldDefinition } from "../../../packages/shared/src/attendance-terms.ts";
import { isLabelSetField, labelPolicyText, labelRateTip, labelSetFieldLabels, labelSetFields, labelSetKeys, maxLabelSets, overallRateTip, statusTone, weightNote, weightsTip, type LabelPolicySummary } from "../../../packages/shared/src/attendance-label-sets.ts";
import { durationFilterUnit, durationUnitLabel, reportColumnId, reportColumnLabel, type ReportCatalog, type ReportColumn, type ReportDefinition, type ReportDurationUnit, type ReportQueryResult } from "./saved-reports";

type PopoverState = { kind: "column"; columnId: string; top: number; left: number } | { kind: "add"; top: number; left: number };
type CatalogItem = ReportCatalog["columns"][number];
/** Add column's drill-ins: a label's whole column set, the single policy columns, or one of those columns' labels. */
type AddView = { kind: "sets" } | { kind: "single" } | { kind: "labels"; key: string; fromSingle: boolean };

/** No value: a dash on screen, "No value" to screen readers, and an empty CSV cell. */
export function NoValue() { return <span className="report-no-value"><span aria-hidden="true">—</span><span className="visually-hidden">No value</span></span>; }

function ReportCell({ value }: { value?: ReportQueryResult["rows"][number]["cells"][string] }) {
  if (!value) return <>N/A</>;
  if (value.unavailable) return <span className="report-unavailable-value" tabIndex={0} role="note" aria-label={`Unavailable. ${value.explanation ?? "This report source is unavailable."}`} title={value.explanation} data-explanation={value.explanation ?? "This report source is unavailable."}>Unavailable</span>;
  if (value.status) return <span className="ui-status" data-tone={statusTone(value.status)}>{value.text}</span>;
  if (value.empty && !value.text) return <NoValue />;
  if (!value.dates || value.dates.length <= 3) return <>{value.text}</>;
  return <details className="date-list"><summary>{value.dates.slice(0, 3).join("; ")} <span>+{value.dates.length - 3} more</span></summary><span>{value.dates.join("; ")}</span></details>;
}

function placePopover(kind: PopoverState["kind"], button: HTMLButtonElement, columnId?: string): PopoverState {
  const { top, left } = placeReportPopover(button, kind === "add");
  return kind === "add" ? { kind, top, left } : { kind, columnId: columnId!, top, left };
}

export function EditableReportTable({ catalog, definition, result, loading, editable, filterable = true, openFilterId, onFilterColumn, onMenuOpen, onChange, onNavigate, onNotice, toolbar }: {
  toolbar?: ReactNode;
  /** The column whose filter popover is open, for its funnel button's expanded state. */
  openFilterId?: string;
  /** Opens a column's filter popover from its header funnel button. */
  onFilterColumn?: (column: ReportColumn, trigger: HTMLButtonElement) => void;
  /** Called when the column menu or Add column opens, so the report can close its own popovers. */
  onMenuOpen?: () => void;
  catalog: ReportCatalog;
  definition: ReportDefinition;
  result?: ReportQueryResult;
  loading: boolean;
  editable: boolean;
  filterable?: boolean;
  onChange: (mutator: (next: ReportDefinition) => void) => void;
  onNavigate: (path: string) => void;
  onNotice: (message: string) => void;
}) {
  const [popover, setPopover] = useState<PopoverState>();
  const [columnSearch, setColumnSearch] = useState("");
  const [labelSearch, setLabelSearch] = useState("");
  const [addView, setAddView] = useState<AddView>();
  const [draggingId, setDraggingId] = useState<string>();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const labelNames = useMemo(() => new Map(catalog.labels.map((label) => [label.id, label.name])), [catalog.labels]);
  const dataset = reportDisplayDataset(catalog, definition.dataset);
  const selectedIds = useMemo(() => new Set(definition.columns.map(reportColumnId)), [definition.columns]);
  const policies = useMemo(() => new Map((catalog.labelPolicies ?? []).map((policy) => [policy.labelId, policy])), [catalog.labelPolicies]);
  // Single policy columns (one field for one label) sit under "Single policy column"; a search lists matching ones directly.
  const labelFields = useMemo(() => catalog.columns.filter((item) => item.requiresLabel && item.datasets.includes(dataset.id)), [catalog.columns, dataset.id]);
  const setsAvailable = labelFields.some((item) => item.key === labelSetFields.rate) && dataset.fields.find((field) => field.id === labelSetFields.rate)?.available !== false;
  const columnGroups = useMemo(() => {
    const query = columnSearch.trim().toLowerCase();
    const labelMatch = catalog.labels.some((label) => label.name.toLowerCase().includes(query));
    const groups = new Map<string, CatalogItem[]>();
    for (const item of catalog.columns) {
      if (!item.datasets.includes(dataset.id) || item.key === dataset.defaultColumns[0]) continue;
      if (item.requiresLabel && !query) continue;
      if (query && !item.label.toLowerCase().includes(query) && !item.group.toLowerCase().includes(query) && !(item.requiresLabel && labelMatch)) continue;
      const items = groups.get(item.group) ?? [];
      items.push(item);
      groups.set(item.group, items);
    }
    // The label drill-ins open the per-label group, which a search for a label name also shows.
    const policyGroup = labelFields[0]?.group;
    if (policyGroup && !query && !groups.has(policyGroup)) groups.set(policyGroup, []);
    return [...groups.entries()];
  }, [catalog.columns, catalog.labels, columnSearch, dataset.defaultColumns, dataset.id, labelFields]);
  const labelCategory = addView?.kind === "labels" ? labelFields.find((item) => item.key === addView.key) : undefined;
  const visibleLabels = useMemo(() => catalog.labels.filter((label) => label.name.toLowerCase().includes(labelSearch.toLowerCase())), [catalog.labels, labelSearch]);

  function columnName(column: ReportColumn) {
    const item = catalog.columns.find((candidate) => candidate.key === column.key);
    const base = item?.durationUnits ? reportColumnLabel(column, item.label) : item?.label ?? column.key;
    return column.labelId ? `${labelNames.get(column.labelId) ?? "Unavailable label"} - ${base}` : base;
  }
  // A label's column set: consecutive set fields for the same label, grouped under one heading row with short names.
  const setLabel = (column: ReportColumn, index: number) => index > 0 && column.labelId && isLabelSetField(column.key) ? column.labelId : undefined;
  const runs = useMemo(() => {
    const result: { labelId?: string; start: number; count: number }[] = [];
    definition.columns.forEach((column, index) => { const labelId = setLabel(column, index); const last = result.at(-1); if (labelId && last?.labelId === labelId) last.count++; else result.push({ labelId, start: index, count: 1 }); });
    return result;
  }, [definition.columns]);
  const hasSets = runs.some((run) => run.labelId);
  const setStarts = new Set(runs.filter((run) => run.labelId).map((run) => run.start));
  const headerName = (column: ReportColumn, index: number) => hasSets && setLabel(column, index) ? labelSetFieldLabels[column.key] ?? columnName(column) : columnName(column);
  const weightedSets = [...new Set(runs.flatMap((run) => run.labelId && policies.get(run.labelId)?.weighted ? [labelNames.get(run.labelId) ?? "Unavailable label"] : []))];
  /** The worked-example tip for a rate column, or the plain definition other attendance columns carry. */
  function columnTip(column: ReportColumn) {
    if (column.key === "attendance.member.regular-rate") return <CalcTip label="About Overall rate" tip={overallRateTip()} />;
    if (column.key === labelSetFields.rate && column.labelId) { const name = labelNames.get(column.labelId) ?? "Unavailable label"; return <CalcTip label={`About ${name} attendance rate`} tip={labelRateTip(name, policies.get(column.labelId))} />; }
    const definitionTip = attendanceFieldDefinition(column.key, catalog.recentDays);
    return definitionTip ? <InfoTip label={`About ${columnName(column)}`}>{definitionTip}</InfoTip> : null;
  }
  // Ticking a label in "Attendance by label" adds its whole set at the end; unticking removes the set, wherever its columns are.
  const setColumns = (labelId: string): ReportColumn[] => labelSetKeys(policies.get(labelId)?.ruleType).map((key) => ({ key, labelId }));
  const labelSetCount = (labelId: string) => definition.columns.filter((column) => column.labelId === labelId && isLabelSetField(column.key)).length;
  const chosenSets = new Set(definition.columns.flatMap((column) => column.labelId && isLabelSetField(column.key) ? [column.labelId] : []));
  function toggleLabelSet(labelId: string, enabled: boolean) {
    if (enabled) {
      const missing = setColumns(labelId).filter((column) => !selectedIds.has(reportColumnId(column)));
      if (chosenSets.size >= maxLabelSets && !chosenSets.has(labelId)) { onNotice(`A report can show at most ${maxLabelSets} label column sets.`); return; }
      if (definition.columns.length + missing.length > 32) { onNotice("A report can contain at most 32 columns. Remove some columns to add this label's set."); return; }
      onChange((next) => { next.columns.push(...missing); if (!next.labelIds.includes(labelId) && next.labelIds.length < 25) next.labelIds.push(labelId); });
      return;
    }
    onChange((next) => {
      next.columns = next.columns.filter((column) => !(column.labelId === labelId && isLabelSetField(column.key)));
      if (!next.columns.some((item) => reportColumnId(item) === reportColumnId(next.sort.column))) next.sort = { column: { key: dataset.defaultSort.field }, direction: dataset.defaultSort.direction };
    });
  }
  function columnAvailability(column: ReportColumn) {
    const id = reportColumnId(column); const responseColumn = result?.columns.find((item) => item.id === id); const field = dataset.fields.find((item) => item.id === column.key);
    return { available: responseColumn?.available ?? field?.available ?? dataset.available, explanation: responseColumn?.explanation ?? field?.explanation };
  }
  function closePopover(returnFocus = false) {
    setPopover(undefined);
    setColumnSearch("");
    setLabelSearch("");
    setAddView(undefined);
    if (returnFocus) window.requestAnimationFrame(() => (trigger.current?.isConnected ? trigger.current : addButton.current)?.focus());
  }
  function openPopover(next: PopoverState["kind"], button: HTMLButtonElement, columnId?: string) {
    if (!editable) return;
    if (popover?.kind === next && (next === "add" || popover.kind === "column" && popover.columnId === columnId)) return closePopover();
    trigger.current = button;
    onMenuOpen?.();
    setPopover(placePopover(next, button, columnId));
  }
  const popoverKey = popover ? `${popover.kind}:${popover.kind === "column" ? popover.columnId : "add"}` : "";
  useEffect(() => {
    if (!popoverKey) return;
    window.requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus());
    const outside = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node) || trigger.current?.contains(event.target as Node)) return;
      closePopover();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") closePopover(true); };
    const reposition = (event?: Event) => {
      if (event?.type === "scroll" && event.target instanceof Node && menu.current?.contains(event.target)) return;
      const button = trigger.current;
      if (!button?.isConnected) return closePopover();
      setPopover((current) => current ? placePopover(current.kind, button, current.kind === "column" ? current.columnId : undefined) : current);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [popoverKey]);
  useEffect(() => { if (!editable) closePopover(); }, [editable]);

  function toggleColumn(column: ReportColumn, enabled: boolean) {
    if (enabled && definition.columns.length >= 32) { onNotice("A report can contain at most 32 columns."); return; }
    const id = reportColumnId(column);
    onChange((next) => {
      if (enabled) next.columns.push(column);
      else {
        // A removed column's filter stays, as a "Not shown" chip, until it is removed itself.
        next.columns = next.columns.filter((item) => reportColumnId(item) !== id);
      }
      if (!next.columns.some((item) => reportColumnId(item) === reportColumnId(next.sort.column))) next.sort = { column: { key: dataset.defaultSort.field }, direction: dataset.defaultSort.direction };
    });
  }
  function moveColumn(columnId: string, direction: -1 | 1) {
    const index = definition.columns.findIndex((column) => reportColumnId(column) === columnId);
    const target = index + direction;
    if (index < 1 || target < 1 || target >= definition.columns.length) return;
    onChange((next) => { [next.columns[index], next.columns[target]] = [next.columns[target], next.columns[index]]; });
  }
  function moveColumnTo(columnId: string, targetId: string) {
    const from = definition.columns.findIndex((column) => reportColumnId(column) === columnId);
    const target = definition.columns.findIndex((column) => reportColumnId(column) === targetId);
    if (from < 1 || target < 1 || from === target) return;
    onChange((next) => {
      const [column] = next.columns.splice(from, 1);
      next.columns.splice(target, 0, column);
    });
  }
  function setSort(column: ReportColumn, direction: "asc" | "desc") {
    onChange((next) => { next.sort = { column, direction }; });
  }
  function setDurationUnit(column: ReportColumn, unit: ReportDurationUnit) {
    const id = reportColumnId(column); const priorUnit = durationFilterUnit(column.unit), nextUnit = durationFilterUnit(unit);
    onChange((next) => {
      const update = (item: ReportColumn): ReportColumn => reportColumnId(item) === id ? { ...item, unit } : item;
      next.columns = next.columns.map(update);
      next.sort.column = update(next.sort.column);
      next.columnFilters = (next.columnFilters ?? []).map((filter) => {
        if (reportColumnId(filter.column) !== id) return filter;
        const convert = (value: string) => value && Number.isFinite(Number(value)) && priorUnit !== nextUnit ? String(Math.round((nextUnit === "hours" ? Number(value) / 60 : Number(value) * 60) * 100) / 100) : value;
        return { ...filter, column: update(filter.column), value: convert(filter.value), ...(filter.upperValue !== undefined ? { upperValue: convert(filter.upperValue) } : {}) };
      });
    });
  }

  const activeColumn = popover?.kind === "column" ? definition.columns.find((column) => reportColumnId(column) === popover.columnId) : undefined;
  const activeIndex = activeColumn ? definition.columns.findIndex((column) => reportColumnId(column) === reportColumnId(activeColumn)) : -1;
  const activeCatalog = activeColumn ? catalog.columns.find((item) => item.key === activeColumn.key) : undefined;
  const activeFilter = activeColumn ? (definition.columnFilters ?? []).find((filter) => reportColumnId(filter.column) === reportColumnId(activeColumn)) : undefined;
  const popoverStyle = popover ? { "--report-popover-top": `${popover.top}px`, "--report-popover-left": `${popover.left}px` } as CSSProperties : undefined;
  function labelFieldButton(item: CatalogItem, fromSingle: boolean) {
    const field = dataset.fields.find((candidate) => candidate.id === item.key); const unavailable = field?.available === false;
    return <button className="report-column-category" type="button" key={item.key} disabled={unavailable} aria-label={unavailable ? `${item.label} unavailable. ${field?.explanation ?? "This report source is unavailable."}` : `Choose labels for ${item.label}`} title={field?.explanation} onClick={() => { setAddView({ kind: "labels", key: item.key, fromSingle }); setLabelSearch(""); }}><span><strong>{item.label}</strong><small>{unavailable ? "Unavailable" : "Choose labels"}</small></span><span>{definition.columns.filter((column) => column.key === item.key && column.labelId).length || ""}<ColumnIcon name="right" /></span></button>;
  }

  return <>
    <div className="report-results-toolbar">{toolbar}<button ref={addButton} className="ui-button report-add-column-button" type="button" disabled={!editable} aria-haspopup="dialog" aria-expanded={popover?.kind === "add"} onClick={(event) => openPopover("add", event.currentTarget)}><ColumnIcon name="add" /><span>Add column</span></button></div>
    <p className="report-table-help">{filterable ? "Use a column's filter button, or + Filter for any field. Open a column header to sort or change it." : "Choose your columns, then save the report to filter results."} Scroll the table to see more columns; the first column stays visible.</p>
    <div className="report-table-scroll" tabIndex={0} role="region" aria-label="Scrollable report results">
      <table className={`report-table-data editable-report-table${editable ? " is-editable" : " is-read-only"}${hasSets ? " report-label-sets" : ""}`}>
        <caption className="visually-hidden">{editable ? "Report results. Drag column headers to reorder them, or open a column header for sorting and column actions." : "Report results."}</caption>
        {hasSets && runs.map((run) => <colgroup key={`group-${run.start}`} span={run.count} />)}
        <thead>{hasSets && <tr className="report-label-group-row">{runs.map((run) => {
          if (!run.labelId) return <th scope="colgroup" key={`group-${run.start}`} className="report-set-blank"><span className="visually-hidden">{columnName(definition.columns[run.start]!)}</span></th>;
          const name = labelNames.get(run.labelId) ?? "Unavailable label"; const policy: LabelPolicySummary | undefined = policies.get(run.labelId);
          return <th scope="colgroup" colSpan={run.count} key={`group-${run.start}`} className="report-set-start" data-label-set={run.labelId}><div className="report-set-heading"><span><strong>{name}</strong><small>{policy ? labelPolicyText(policy) : "No policy"}</small></span>{policy?.weighted && <span className="report-set-weighted"><span className="ui-status" data-tone="neutral">Weighted</span><CalcTip label={`About meeting weights in ${name}`} tip={weightsTip(name)} /></span>}</div></th>;
        })}</tr>}<tr>{definition.columns.map((column, index) => {
          const id = reportColumnId(column); const sorted = reportColumnId(definition.sort.column) === id; const filtered = (definition.columnFilters ?? []).some((filter) => reportColumnId(filter.column) === id); const availability = columnAvailability(column); const unavailableLabel = availability.available ? undefined : `${columnName(column)} is unavailable. ${availability.explanation ?? "This report source is unavailable."}`; const shown = headerName(column, index);
          return <th scope="col" key={id} aria-sort={sorted ? definition.sort.direction === "asc" ? "ascending" : "descending" : undefined} data-column-id={id} data-value-kind={catalog.columns.find((item) => item.key === column.key)?.filterKind ?? "text"} draggable={editable && index > 0}
            className={`${draggingId === id ? "is-dragging" : ""}${editable && index > 0 ? " is-draggable" : ""}${setStarts.has(index) ? " report-set-start" : ""}`}
            onDragStart={(event) => { if (!editable || index === 0) { event.preventDefault(); return; } setDraggingId(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); closePopover(); }}
            onDragEnd={() => setDraggingId(undefined)}
            onDragOver={(event) => { if (editable && index > 0 && draggingId && draggingId !== id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
            onDrop={(event) => { if (!editable) return; event.preventDefault(); const source = event.dataTransfer.getData("text/plain") || draggingId; if (source) moveColumnTo(source, id); setDraggingId(undefined); }}>
            <div className="report-column-header">{editable ? <><span className="report-column-drag" aria-hidden="true"><ColumnIcon name="drag" /></span><button className="report-column-trigger" type="button" aria-label={unavailableLabel ? `${unavailableLabel} Column options.` : `${columnName(column)} column options`} title={availability.explanation} aria-haspopup="dialog" aria-expanded={popover?.kind === "column" && popover.columnId === id} onClick={(event) => openPopover("column", event.currentTarget, id)}><span className={availability.available ? undefined : "report-unavailable-marker"} data-explanation={availability.explanation}>{shown}{!availability.available && <small>Unavailable</small>}</span>{filtered && <span className="report-column-filtered-mark"><ColumnIcon name="filter" /></span>}{sorted && <ColumnIcon name={definition.sort.direction === "asc" ? "sort-asc" : "sort-desc"} />}<ColumnIcon name="down" /></button>{filterable && onFilterColumn && dataset.fields.find((field) => field.id === column.key)?.filterOperators.length ? <button className={`report-column-filter-button${filtered ? " is-active" : ""}`} type="button" aria-label={`Filter ${columnName(column)}`} title={`Filter ${columnName(column)}`} aria-haspopup="dialog" aria-expanded={openFilterId === id} onClick={(event) => { closePopover(); onFilterColumn(column, event.currentTarget); }}><ColumnIcon name="filter" /></button> : null}</> : <span className={`report-column-label${availability.available ? "" : " report-unavailable-marker"}`} tabIndex={availability.available ? undefined : 0} role={availability.available ? undefined : "note"} aria-label={unavailableLabel} title={availability.explanation} data-explanation={availability.explanation}><span>{shown}{!availability.available && <small>Unavailable</small>}</span>{sorted && <ColumnIcon name={definition.sort.direction === "asc" ? "sort-asc" : "sort-desc"} />}</span>}{columnTip(column)}</div>
          </th>;
        })}</tr></thead>
        <tbody>{result?.rows.map((row) => <tr key={row.id}>{definition.columns.map((column, index) => { const id = reportColumnId(column); return <td key={id} className={setStarts.has(index) ? "report-set-start" : undefined} data-value-kind={catalog.columns.find((item) => item.key === column.key)?.filterKind ?? "text"}>{index === 0 && row.href ? <RouteLink href={row.href} currentPath="" navigate={onNavigate}>{row.cells[id]?.text ?? row.label}</RouteLink> : <ReportCell value={row.cells[id]} />}</td>; })}</tr>)}</tbody>
      </table>
      {!loading && result?.state !== "paused" && !result?.rows.length && <p className="empty-state">No {dataset.label.toLocaleLowerCase()} match this report.</p>}
    </div>
    {weightedSets.length > 0 && <p className="report-table-help report-weight-note"><span className="ui-status" data-tone="neutral">Weighted</span><span>{weightNote(weightedSets)}</span></p>}

    {popover && editable && createPortal(<div ref={menu} className="report-column-popover" style={popoverStyle} role="dialog" aria-label={popover.kind === "add" ? "Add report column" : `${activeColumn ? columnName(activeColumn) : "Column"} options`}>
      {popover.kind === "add" ? addView?.kind === "sets" ? <>
        <div className="report-column-popover-heading report-column-category-heading"><button className="ui-button report-column-back" type="button" onClick={() => { setAddView(undefined); setLabelSearch(""); }}><ColumnIcon name="left" />Back</button><strong>Attendance by label</strong></div>
        <label className="report-column-search">Search labels<input type="search" value={labelSearch} onChange={(event) => setLabelSearch(event.target.value)} autoFocus /></label>
        <div className="report-column-options">{visibleLabels.map((label) => {
          const policy = policies.get(label.id); const count = labelSetCount(label.id); const checked = count > 0; const full = !checked && chosenSets.size >= maxLabelSets;
          const note = checked ? `In report · ${countText(count, "column")}` : !policy ? "No policy" : full ? `Up to ${maxLabelSets} labels` : `Adds 6 columns${policy.ruleType === "weekly_count" ? ` · ${countText(policy.target, "meeting")} per week` : policy.weighted ? " · weighted" : ""}`;
          return <label key={label.id} className={`report-column-option${!checked && (!policy || full) ? " is-unavailable" : ""}`}><input type="checkbox" checked={checked} disabled={!checked && (!policy || full)} onChange={(event) => toggleLabelSet(label.id, event.target.checked)} /><span>{label.name}<small>{note}{!label.active ? " · Retired" : ""}</small></span></label>;
        })}{!visibleLabels.length && <p className="empty-state">No labels match.</p>}</div>
        <p className="report-filter-popover-help">Each label adds Attendance rate, Target, Status, Meetings attended, Meetings counted (Weeks met for a weekly policy) and Excused, and is added to the Labels filter. Remove single columns from their header menu. Unticking a label removes its whole set.</p>
      </> : addView?.kind === "single" ? <>
        <div className="report-column-popover-heading report-column-category-heading"><button className="ui-button report-column-back" type="button" onClick={() => setAddView(undefined)}><ColumnIcon name="left" />Back</button><strong>Single policy column</strong></div>
        <div className="report-column-options">{labelFields.map((item) => labelFieldButton(item, true))}</div>
      </> : labelCategory ? <>
        <div className="report-column-popover-heading report-column-category-heading"><button className="ui-button report-column-back" type="button" onClick={() => { setAddView(addView?.kind === "labels" && addView.fromSingle ? { kind: "single" } : undefined); setLabelSearch(""); }}><ColumnIcon name="left" />Back</button><strong>{labelCategory.label}</strong></div>
        <label className="report-column-search">Search labels<input type="search" value={labelSearch} onChange={(event) => setLabelSearch(event.target.value)} autoFocus /></label>
        <div className="report-column-options">{visibleLabels.map((label) => { const column = { key: labelCategory.key, labelId: label.id }; const id = reportColumnId(column); return <label key={id} className="report-column-option"><input type="checkbox" checked={selectedIds.has(id)} onChange={(event) => toggleColumn(column, event.target.checked)} /><span>{label.name}{!label.active && <small>Retired</small>}</span></label>; })}{!visibleLabels.length && <p className="empty-state">No labels match.</p>}</div>
      </> : <>
        <div className="report-column-popover-heading"><strong>Add a column</strong><span>{definition.columns.length} selected</span></div>
        <label className="report-column-search">Search columns<input type="search" value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} autoFocus /></label>
        <div className="report-column-groups">{columnGroups.map(([group, items]) => <section className="report-column-group" key={group} aria-labelledby={`report-column-group-${group.replaceAll(" ", "-")}`}><h3 id={`report-column-group-${group.replaceAll(" ", "-")}`}>{group}</h3><div className="report-column-options">{!columnSearch.trim() && group === labelFields[0]?.group && <>
          <button className="report-column-category report-column-category--set" type="button" disabled={!setsAvailable} aria-label={setsAvailable ? "Choose labels for Attendance by label" : "Attendance by label unavailable"} onClick={() => { setAddView({ kind: "sets" }); setLabelSearch(""); }}><span><strong>Attendance by label</strong><small>{setsAvailable ? "Adds all 6 columns for each label you choose" : "Unavailable"}</small></span><span>{chosenSets.size || ""}<ColumnIcon name="right" /></span></button>
          <button className="report-column-category" type="button" aria-label="Choose a single policy column" onClick={() => setAddView({ kind: "single" })}><span><strong>Single policy column</strong><small>Choose one column and label</small></span><span>{definition.columns.filter((column) => column.labelId && !isLabelSetField(column.key)).length || ""}<ColumnIcon name="right" /></span></button>
        </>}{items.map((item) => { const field = dataset.fields.find((candidate) => candidate.id === item.key); const unavailable = field?.available === false; return item.requiresLabel ? labelFieldButton(item, false) : (() => { const column: ReportColumn = item.defaultDurationUnit ? { key: item.key, unit: item.defaultDurationUnit } : { key: item.key }; const id = reportColumnId(column); const selected = selectedIds.has(id); return <label key={id} className={`report-column-option${unavailable ? " is-unavailable" : ""}`} title={field?.explanation}><input type="checkbox" checked={selected} disabled={unavailable && !selected} onChange={(event) => toggleColumn(column, event.target.checked)} /><span>{reportColumnLabel(column, item.label)}{unavailable && <small>Unavailable - {field?.explanation}</small>}</span></label>; })(); })}</div></section>)}{!columnGroups.length && <p className="empty-state">No columns match.</p>}</div>
      </> : activeColumn && <>
        <div className="report-column-popover-heading"><strong>{columnName(activeColumn)}</strong>{activeFilter && <span>Filtered</span>}</div>{!columnAvailability(activeColumn).available && <p className="ui-status" data-tone="warning">{columnAvailability(activeColumn).explanation} Remove this column or its controls to change the preserved definition.</p>}
        {activeCatalog?.sortable && <fieldset className="report-column-sort"><legend className="visually-hidden">Sort column</legend><button className={`ui-button${definition.sort.direction === "asc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn) ? " is-selected" : ""}`} type="button" aria-pressed={definition.sort.direction === "asc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn)} onClick={() => { setSort(activeColumn, "asc"); closePopover(true); }}><ColumnIcon name="sort-asc" />Ascending</button><button className={`ui-button${definition.sort.direction === "desc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn) ? " is-selected" : ""}`} type="button" aria-pressed={definition.sort.direction === "desc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn)} onClick={() => { setSort(activeColumn, "desc"); closePopover(true); }}><ColumnIcon name="sort-desc" />Descending</button></fieldset>}

        {activeCatalog?.durationUnits && <label className="report-column-filter">Units<select value={activeColumn.unit ?? "minutes"} onChange={(event) => setDurationUnit(activeColumn, event.target.value as ReportDurationUnit)}>{activeCatalog.durationUnits.map((unit) => <option key={unit} value={unit}>{durationUnitLabel(unit)}</option>)}</select></label>}
        {activeIndex > 0 && <div className="report-column-actions"><button className="ui-button" type="button" disabled={activeIndex <= 1} onClick={() => { moveColumn(reportColumnId(activeColumn), -1); closePopover(true); }}><ColumnIcon name="left" />Move left</button><button className="ui-button report-remove-column" type="button" onClick={() => { toggleColumn(activeColumn, false); closePopover(true); }}><ColumnIcon name="trash" />Remove column</button><button className="ui-button" type="button" disabled={activeIndex >= definition.columns.length - 1} onClick={() => { moveColumn(reportColumnId(activeColumn), 1); closePopover(true); }}>Move right<ColumnIcon name="right" /></button></div>}
      </>}
    </div>, reportPopoverHost(addButton.current))}
  </>;
}
