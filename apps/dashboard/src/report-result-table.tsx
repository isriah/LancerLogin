import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { RouteLink } from "./router";
import { reportColumnId, type ReportCatalog, type ReportColumn, type ReportDefinition, type ReportQueryResult } from "./saved-reports";

type PopoverState = { kind: "column"; columnId: string; top: number; left: number } | { kind: "add"; top: number; left: number };
type CatalogItem = ReportCatalog["columns"][number];

function ColumnIcon({ name }: { name: "add" | "drag" | "down" | "filter" | "left" | "right" | "sort-asc" | "sort-desc" | "trash" }) {
  const paths = {
    add: <path d="M12 5v14M5 12h14" />,
    drag: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
    down: <path d="m7 10 5 5 5-5" />,
    filter: <path d="M4 5h16l-6 7v5l-4 2v-7z" />,
    left: <path d="m15 18-6-6 6-6" />,
    right: <path d="m9 18 6-6-6-6" />,
    "sort-asc": <path d="M12 19V5m0 0L7 10m5-5 5 5" />,
    "sort-desc": <path d="M12 5v14m0 0 5-5m-5 5-5-5" />,
    trash: <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" />,
  };
  return <svg className="report-column-icon" aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function ReportCell({ value }: { value?: ReportQueryResult["rows"][number]["cells"][string] }) {
  if (!value) return <>N/A</>;
  if (!value.dates || value.dates.length <= 3) return <>{value.text}</>;
  return <details className="date-list"><summary>{value.dates.slice(0, 3).join("; ")} <span>+{value.dates.length - 3} more</span></summary><span>{value.dates.join("; ")}</span></details>;
}

function placePopover(kind: PopoverState["kind"], button: HTMLButtonElement, columnId?: string): PopoverState {
  const rect = button.getBoundingClientRect();
  const width = Math.min(336, Math.max(280, window.innerWidth - 32));
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
  const desiredHeight = Math.min(kind === "add" ? 480 : 320, window.innerHeight - 32);
  const spaceBelow = window.innerHeight - rect.bottom - 16;
  const top = spaceBelow >= Math.min(desiredHeight, 220) ? rect.bottom + 8 : Math.max(16, rect.top - desiredHeight - 8);
  return kind === "add" ? { kind, top, left } : { kind, columnId: columnId!, top, left };
}

export function EditableReportTable({ catalog, definition, result, loading, editable, onChange, onNavigate, onNotice }: {
  catalog: ReportCatalog;
  definition: ReportDefinition;
  result?: ReportQueryResult;
  loading: boolean;
  editable: boolean;
  onChange: (mutator: (next: ReportDefinition) => void) => void;
  onNavigate: (path: string) => void;
  onNotice: (message: string) => void;
}) {
  const [popover, setPopover] = useState<PopoverState>();
  const [columnSearch, setColumnSearch] = useState("");
  const [labelSearch, setLabelSearch] = useState("");
  const [labelCategoryKey, setLabelCategoryKey] = useState<string>();
  const [draggingId, setDraggingId] = useState<string>();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const labelNames = useMemo(() => new Map(catalog.labels.map((label) => [label.id, label.name])), [catalog.labels]);
  const selectedIds = useMemo(() => new Set(definition.columns.map(reportColumnId)), [definition.columns]);
  const columnGroups = useMemo(() => {
    const query = columnSearch.trim().toLowerCase();
    const labelMatch = catalog.labels.some((label) => label.name.toLowerCase().includes(query));
    const groups = new Map<string, CatalogItem[]>();
    for (const item of catalog.columns) {
      if (item.key === "member") continue;
      if (query && !item.label.toLowerCase().includes(query) && !item.group.toLowerCase().includes(query) && !(item.requiresLabel && labelMatch)) continue;
      const items = groups.get(item.group) ?? [];
      items.push(item);
      groups.set(item.group, items);
    }
    return [...groups.entries()];
  }, [catalog.columns, catalog.labels, columnSearch]);
  const labelCategory = labelCategoryKey ? catalog.columns.find((item) => item.key === labelCategoryKey && item.requiresLabel) : undefined;
  const visibleLabels = useMemo(() => catalog.labels.filter((label) => label.name.toLowerCase().includes(labelSearch.toLowerCase())), [catalog.labels, labelSearch]);

  function columnName(column: ReportColumn) {
    const item = catalog.columns.find((candidate) => candidate.key === column.key);
    return column.labelId ? `${labelNames.get(column.labelId) ?? "Unavailable label"} - ${item?.label ?? column.key}` : item?.label ?? column.key;
  }
  function closePopover(returnFocus = false) {
    setPopover(undefined);
    setColumnSearch("");
    setLabelSearch("");
    setLabelCategoryKey(undefined);
    if (returnFocus) window.requestAnimationFrame(() => trigger.current?.focus());
  }
  function openPopover(next: PopoverState["kind"], button: HTMLButtonElement, columnId?: string) {
    if (!editable) return;
    if (popover?.kind === next && (next === "add" || popover.kind === "column" && popover.columnId === columnId)) return closePopover();
    trigger.current = button;
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
    const reposition = () => {
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
        next.columns = next.columns.filter((item) => reportColumnId(item) !== id);
        next.columnFilters = (next.columnFilters ?? []).filter((filter) => reportColumnId(filter.column) !== id);
      }
      if (!next.columns.some((item) => reportColumnId(item) === reportColumnId(next.sort.column))) next.sort = { column: { key: "member" }, direction: "asc" };
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
  function setTextFilter(column: ReportColumn, value: string) {
    const id = reportColumnId(column);
    onChange((next) => {
      const filters = (next.columnFilters ?? []).filter((filter) => reportColumnId(filter.column) !== id);
      if (value.trim()) filters.push({ column, operator: "contains", value: value.trim() });
      next.columnFilters = filters;
    });
  }

  const activeColumn = popover?.kind === "column" ? definition.columns.find((column) => reportColumnId(column) === popover.columnId) : undefined;
  const activeIndex = activeColumn ? definition.columns.findIndex((column) => reportColumnId(column) === reportColumnId(activeColumn)) : -1;
  const activeCatalog = activeColumn ? catalog.columns.find((item) => item.key === activeColumn.key) : undefined;
  const activeFilter = activeColumn ? (definition.columnFilters ?? []).find((filter) => filter.operator === "contains" && reportColumnId(filter.column) === reportColumnId(activeColumn)) : undefined;
  const popoverStyle = popover ? { "--report-popover-top": `${popover.top}px`, "--report-popover-left": `${popover.left}px` } as CSSProperties : undefined;

  return <>
    <div className="report-table-scroll">
      <table className={`report-table-data editable-report-table${editable ? " is-editable" : " is-read-only"}`}>
        <caption className="visually-hidden">{editable ? "Report results. Drag column headers to reorder them, or open a column header for sorting and column actions." : "Report results."}</caption>
        <thead><tr>{definition.columns.map((column, index) => {
          const id = reportColumnId(column); const sorted = reportColumnId(definition.sort.column) === id; const filtered = (definition.columnFilters ?? []).some((filter) => reportColumnId(filter.column) === id);
          return <th scope="col" key={id} data-column-id={id} draggable={editable && index > 0}
            className={`${draggingId === id ? "is-dragging" : ""}${editable && index > 0 ? " is-draggable" : ""}`}
            onDragStart={(event) => { if (!editable || index === 0) { event.preventDefault(); return; } setDraggingId(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); closePopover(); }}
            onDragEnd={() => setDraggingId(undefined)}
            onDragOver={(event) => { if (editable && index > 0 && draggingId && draggingId !== id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
            onDrop={(event) => { if (!editable) return; event.preventDefault(); const source = event.dataTransfer.getData("text/plain") || draggingId; if (source) moveColumnTo(source, id); setDraggingId(undefined); }}>
            <div className="report-column-header">{editable ? <><span className="report-column-drag" aria-hidden="true"><ColumnIcon name="drag" /></span><button className="report-column-trigger" type="button" aria-label={`${columnName(column)} column options`} aria-haspopup="dialog" aria-expanded={popover?.kind === "column" && popover.columnId === id} onClick={(event) => openPopover("column", event.currentTarget, id)}><span>{columnName(column)}</span>{filtered && <ColumnIcon name="filter" />}{sorted && <ColumnIcon name={definition.sort.direction === "asc" ? "sort-asc" : "sort-desc"} />}<ColumnIcon name="down" /></button></> : <span className="report-column-label"><span>{columnName(column)}</span>{sorted && <ColumnIcon name={definition.sort.direction === "asc" ? "sort-asc" : "sort-desc"} />}</span>}</div>
          </th>;
        })}{editable && <th scope="col" className="report-add-column"><button className="ui-button report-add-column-button" type="button" aria-haspopup="dialog" aria-expanded={popover?.kind === "add"} onClick={(event) => openPopover("add", event.currentTarget)}><ColumnIcon name="add" />Add column</button></th>}</tr></thead>
        <tbody>{result?.rows.map((row) => <tr key={row.member.id}>{definition.columns.map((column, index) => { const id = reportColumnId(column); return <td key={id}>{index === 0 ? <RouteLink href={`/roster/${encodeURIComponent(row.member.memberId)}`} currentPath="" navigate={onNavigate}>{row.cells[id]?.text ?? row.member.name}</RouteLink> : <ReportCell value={row.cells[id]} />}</td>; })}{editable && <td className="report-add-column-spacer" aria-hidden="true" />}</tr>)}</tbody>
      </table>
      {!loading && !result?.rows.length && <p className="empty-state">No members match this report.</p>}
    </div>

    {popover && editable && <div ref={menu} className="report-column-popover" style={popoverStyle} role="dialog" aria-label={popover.kind === "add" ? "Add report column" : `${activeColumn ? columnName(activeColumn) : "Column"} options`}>
      {popover.kind === "add" ? labelCategory ? <>
        <div className="report-column-popover-heading report-column-category-heading"><button className="ui-button report-column-back" type="button" onClick={() => { setLabelCategoryKey(undefined); setLabelSearch(""); }}><ColumnIcon name="left" />Back</button><strong>{labelCategory.label}</strong></div>
        <label className="report-column-search">Search labels<input type="search" value={labelSearch} onChange={(event) => setLabelSearch(event.target.value)} autoFocus /></label>
        <div className="report-column-options">{visibleLabels.map((label) => { const column = { key: labelCategory.key, labelId: label.id }; const id = reportColumnId(column); return <label key={id} className="report-column-option"><input type="checkbox" checked={selectedIds.has(id)} onChange={(event) => toggleColumn(column, event.target.checked)} /><span>{label.name}{!label.active && <small>Retired</small>}</span></label>; })}{!visibleLabels.length && <p className="empty-state">No labels match.</p>}</div>
      </> : <>
        <div className="report-column-popover-heading"><strong>Add a column</strong><span>{definition.columns.length} selected</span></div>
        <label className="report-column-search">Search columns<input type="search" value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} autoFocus /></label>
        <div className="report-column-groups">{columnGroups.map(([group, items]) => <section className="report-column-group" key={group} aria-labelledby={`report-column-group-${group.replaceAll(" ", "-")}`}><h3 id={`report-column-group-${group.replaceAll(" ", "-")}`}>{group}</h3><div className="report-column-options">{items.map((item) => item.requiresLabel ? <button className="report-column-category" type="button" key={item.key} aria-label={`Choose labels for ${item.label}`} onClick={() => { setLabelCategoryKey(item.key); setLabelSearch(""); }}><span><strong>{item.label}</strong><small>Choose labels</small></span><span>{definition.columns.filter((column) => column.key === item.key && column.labelId).length || ""}<ColumnIcon name="right" /></span></button> : (() => { const column = { key: item.key }; const id = reportColumnId(column); return <label key={id} className="report-column-option"><input type="checkbox" checked={selectedIds.has(id)} onChange={(event) => toggleColumn(column, event.target.checked)} /><span>{item.label}</span></label>; })())}</div></section>)}{!columnGroups.length && <p className="empty-state">No columns match.</p>}</div>
      </> : activeColumn && <>
        <div className="report-column-popover-heading"><strong>{columnName(activeColumn)}</strong>{activeFilter && <span>Filtered</span>}</div>
        {activeCatalog?.sortable && <fieldset className="report-column-sort"><legend className="visually-hidden">Sort column</legend><button className={`ui-button${definition.sort.direction === "asc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn) ? " is-selected" : ""}`} type="button" aria-pressed={definition.sort.direction === "asc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn)} onClick={() => { setSort(activeColumn, "asc"); closePopover(true); }}><ColumnIcon name="sort-asc" />Ascending</button><button className={`ui-button${definition.sort.direction === "desc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn) ? " is-selected" : ""}`} type="button" aria-pressed={definition.sort.direction === "desc" && reportColumnId(definition.sort.column) === reportColumnId(activeColumn)} onClick={() => { setSort(activeColumn, "desc"); closePopover(true); }}><ColumnIcon name="sort-desc" />Descending</button></fieldset>}
        {activeCatalog?.filterKind === "text" && <div className="report-column-filter-control"><label className="report-column-filter">Contains<input type="search" value={activeFilter?.value ?? ""} placeholder="Type to filter" onChange={(event) => setTextFilter(activeColumn, event.target.value)} /></label>{activeFilter && <button className="ui-button" type="button" onClick={() => setTextFilter(activeColumn, "")}>Clear filter</button>}</div>}
        {activeIndex > 0 && <div className="report-column-actions"><button className="ui-button" type="button" disabled={activeIndex <= 1} onClick={() => { moveColumn(reportColumnId(activeColumn), -1); closePopover(true); }}><ColumnIcon name="left" />Move left</button><button className="ui-button ui-button--danger report-remove-column" type="button" onClick={() => { toggleColumn(activeColumn, false); closePopover(); }}><ColumnIcon name="trash" />Delete</button><button className="ui-button" type="button" disabled={activeIndex >= definition.columns.length - 1} onClick={() => { moveColumn(reportColumnId(activeColumn), 1); closePopover(true); }}>Move right<ColumnIcon name="right" /></button></div>}
      </>}
    </div>}
  </>;
}
