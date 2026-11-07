import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ReportColumn } from "./saved-reports";

export function ColumnIcon({ name }: { name: "add" | "drag" | "down" | "filter" | "hidden" | "left" | "right" | "sort-asc" | "sort-desc" | "trash" }) {
  const paths = {
    add: <path d="M12 5v14M5 12h14" />,
    drag: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
    down: <path d="m7 10 5 5 5-5" />,
    filter: <path d="M4 5h16l-6 7v5l-4 2v-7z" />,
    hidden: <path d="M3 3l18 18M10.6 6.1A9 9 0 0 1 12 6c5 0 9 6 9 6a15 15 0 0 1-2.6 3.1M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a8 8 0 0 0 4.4-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
    left: <path d="m15 18-6-6 6-6" />,
    right: <path d="m9 18 6-6-6-6" />,
    "sort-asc": <path d="M12 19V5m0 0L7 10m5-5 5 5" />,
    "sort-desc": <path d="M12 5v14m0 0 5-5m-5 5-5-5" />,
    trash: <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" />,
  };
  return <svg className="report-column-icon" aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

/** A filter the report can carry: a column filter, or one of the dataset's list filters. */
export type ReportFilterTarget = { kind: "column"; column: ReportColumn } | { kind: "labels" } | { kind: "module"; filterId: string } | { kind: "roster" } | { kind: "meetings" };
export const reportFilterTargetKey = (target: ReportFilterTarget, columnId: (column: ReportColumn) => string) => target.kind === "column" ? `column:${columnId(target.column)}` : target.kind === "module" ? `module:${target.filterId}` : target.kind;

/** Where a report popover opens: under its trigger when there is room, otherwise above it, inside the viewport. */
export function placeReportPopover(trigger: HTMLElement, tall = false): { top: number; left: number } {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(336, Math.max(280, window.innerWidth - 32));
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
  const desiredHeight = Math.min(tall ? 480 : 320, window.innerHeight - 32);
  const spaceBelow = window.innerHeight - rect.bottom - 16;
  const top = spaceBelow >= Math.min(desiredHeight, 220) ? rect.bottom + 8 : Math.max(16, rect.top - desiredHeight - 8);
  return { top, left };
}

/** The dashboard root that report popovers render into, so card styles don't restyle their controls. */
export const reportPopoverHost = (element?: Element | null) => element?.closest(".app") ?? document.body;

/**
 * A dialog anchored to the button that opened it, in the column popover style. It closes on Escape (returning focus to
 * its trigger), on a press outside it, and when its trigger leaves the page. `view` moves focus in when its content changes.
 */
export function ReportPopover({ anchor, label, tall, view, onClose, children }: { anchor: HTMLElement; label: string; tall?: boolean; view: string; onClose: (returnFocus: boolean) => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => placeReportPopover(anchor, tall));
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    // Focus the first field, the chosen option, or else the first control, so Back isn't where typing starts.
    const frame = window.requestAnimationFrame(() => { const root = panel.current; (root?.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]), select") ?? root?.querySelector<HTMLElement>("input[type=radio]:checked") ?? root?.querySelector<HTMLElement>("input, button:not(:disabled)"))?.focus(); });
    return () => window.cancelAnimationFrame(frame);
  }, [view]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close.current(false); };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close.current(true); } };
    const reposition = (event?: Event) => {
      if (event?.type === "scroll" && event.target instanceof Node && panel.current?.contains(event.target)) return;
      if (!anchor.isConnected) return close.current(false);
      setPosition(placeReportPopover(anchor, tall));
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keydown); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [anchor, tall]);
  const style = { "--report-popover-top": `${position.top}px`, "--report-popover-left": `${position.left}px` } as CSSProperties;
  return createPortal(<div ref={panel} className="report-column-popover report-filter-popover" style={style} role="dialog" aria-label={label}>{children}</div>, reportPopoverHost(anchor));
}

/** A popover heading: the field or setting's name, a status pill, and Back when it was picked from + Filter. */
export function ReportPopoverHeading({ title, status, onBack }: { title: string; status?: string; onBack?: () => void }) {
  return <div className={`report-column-popover-heading${onBack ? " report-column-category-heading" : ""}`}>{onBack && <button className="ui-button report-column-back" type="button" onClick={onBack}><ColumnIcon name="left" />Back</button>}<strong>{title}</strong>{status && <span>{status}</span>}</div>;
}

/** Clear and Apply, the footer of every filter popover. Apply submits the popover's form. */
export function ReportFilterActions({ canApply, onClear, clearLabel = "Clear" }: { canApply: boolean; onClear?: () => void; clearLabel?: string }) {
  return <div className="report-filter-popover-actions">{onClear && <button className="ui-button" type="button" onClick={onClear}>{clearLabel}</button>}<button className="ui-button ui-button--primary" type="submit" disabled={!canApply}>Apply</button></div>;
}

export type ReportFilterPickerItem = { key: string; name: string; hint: string; filtered: boolean; onPick: () => void };
/** + Filter's field list: fields in the table, then fields and list filters that aren't. */
export function ReportFilterPicker({ groups, activeCount }: { groups: { title: string; items: ReportFilterPickerItem[] }[]; activeCount: number }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visible = groups.map((group) => ({ ...group, items: group.items.filter((item) => !query || item.name.toLocaleLowerCase().includes(query)) })).filter((group) => group.items.length);
  return <>
    <ReportPopoverHeading title="Add a filter" status={`${activeCount} active`} />
    <label className="report-column-search">Search fields<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="report-column-groups">{visible.map((group, index) => <section className="report-column-group" key={group.title} aria-labelledby={`report-filter-group-${index}`}><h3 id={`report-filter-group-${index}`}>{group.title}</h3><div className="report-column-options">{group.items.map((item) => <button className="report-column-category" type="button" key={item.key} aria-label={`${item.name} (${item.hint.toLocaleLowerCase()})${item.filtered ? ", filtered" : ""}`} onClick={item.onPick}><span><strong>{item.name}</strong><small>{item.hint}</small></span><span>{item.filtered && <span className="report-filter-tag">Filtered</span>}<ColumnIcon name="right" /></span></button>)}</div></section>)}{!visible.length && <p className="empty-state">No fields match.</p>}</div>
  </>;
}

/** One step of a drill-in inside + Filter, such as a per-label field and then its label: Back, a search and a list to pick from. */
export function ReportFilterChoiceList({ title, searchLabel, items, onBack }: { title: string; searchLabel: string; items: ReportFilterPickerItem[]; onBack?: () => void }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const visible = items.filter((item) => !query || item.name.toLocaleLowerCase().includes(query));
  return <>
    <ReportPopoverHeading title={title} onBack={onBack} />
    <label className="report-column-search">{searchLabel}<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="report-column-options">{visible.map((item) => <button className="report-column-category" type="button" key={item.key} aria-label={`${item.name} (${item.hint.toLocaleLowerCase()})${item.filtered ? ", filtered" : ""}`} onClick={item.onPick}><span><strong>{item.name}</strong><small>{item.hint}</small></span><span>{item.filtered && <span className="report-filter-tag">Filtered</span>}<ColumnIcon name="right" /></span></button>)}{!visible.length && <p className="empty-state">Nothing matches.</p>}</div>
  </>;
}

export type ReportChoiceOption = { id: string; name: string; note?: string };
/** A list filter such as Labels: search, up to `limit` checked options, and Any or All matching. Nothing changes until Apply. */
export function ReportChoiceFilter({ title, status, noun, options, missingIds, missingName, selected, match, limit = 25, onBack, onApply }: { title: string; status?: string; noun: string; options: ReportChoiceOption[]; missingIds: string[]; missingName: string; selected: string[]; match: "any" | "all"; limit?: number; onBack?: () => void; onApply: (ids: string[], match: "any" | "all") => void }) {
  const [ids, setIds] = useState(selected); const [mode, setMode] = useState(match); const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const shown = useMemo(() => options.filter((option) => !query || option.name.toLocaleLowerCase().includes(query)), [options, query]);
  const full = ids.length >= limit;
  const toggle = (id: string, checked: boolean) => setIds((current) => checked ? current.includes(id) || current.length >= limit ? current : [...current, id] : current.filter((value) => value !== id));
  const name = useRef(`report-match-${Math.random().toString(36).slice(2)}`).current;
  return <form className="report-filter-form" onSubmit={(event) => { event.preventDefault(); onApply(ids, mode); }}>
    <ReportPopoverHeading title={title} status={status} onBack={onBack} />
    <label className="report-column-search">Search {title.toLocaleLowerCase()}<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="report-column-options report-filter-option-list">
      {missingIds.map((id) => <label className="report-column-option" key={id}><input type="checkbox" checked={ids.includes(id)} onChange={(event) => toggle(id, event.target.checked)} /><span>{missingName}<small>Remove to save</small></span></label>)}
      {shown.map((option) => { const checked = ids.includes(option.id); return <label className="report-column-option" key={option.id}><input type="checkbox" checked={checked} disabled={!checked && full} onChange={(event) => toggle(option.id, event.target.checked)} /><span>{option.name}{option.note && <small>{option.note}</small>}</span></label>; })}
      {!shown.length && !missingIds.length && <p className="empty-state">No {noun}s match.</p>}
    </div>
    <fieldset className="report-filter-match"><legend className="visually-hidden">{title} matching</legend><label><input type="radio" name={name} checked={mode === "any"} onChange={() => setMode("any")} />Any selected</label><label><input type="radio" name={name} checked={mode === "all"} onChange={() => setMode("all")} />All selected</label></fieldset>
    <p className="report-filter-popover-help">Up to {limit} {noun}s.{full ? ` ${limit} are selected.` : ""}</p>
    <ReportFilterActions canApply onClear={() => onApply([], "any")} />
  </form>;
}

/** A filter with one of a few settings, such as Roster: active or all members. */
export function ReportOptionFilter<T extends string>({ title, status, options, value, clearValue, help, onBack, onApply }: { title: string; status?: string; options: { value: T; label: string }[]; value: T; clearValue: T; help?: string; onBack?: () => void; onApply: (value: T) => void }) {
  const [choice, setChoice] = useState(value);
  const name = useRef(`report-option-${Math.random().toString(36).slice(2)}`).current;
  return <form className="report-filter-form" onSubmit={(event) => { event.preventDefault(); onApply(choice); }}>
    <ReportPopoverHeading title={title} status={status} onBack={onBack} />
    <fieldset className="report-filter-choices"><legend className="visually-hidden">{title}</legend>{options.map((option) => <label className="report-column-option" key={option.value}><input type="radio" name={name} checked={choice === option.value} onChange={() => setChoice(option.value)} /><span>{option.label}</span></label>)}</fieldset>
    {help && <p className="report-filter-popover-help">{help}</p>}
    <ReportFilterActions canApply onClear={() => onApply(clearValue)} />
  </form>;
}
