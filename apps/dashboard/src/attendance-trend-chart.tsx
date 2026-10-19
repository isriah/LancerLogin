import { useLayoutEffect, useRef, useState } from "react";

type Point = { meetingId: string; title: string; startsAt: string; rate: number };

export function AttendanceTrendChart({ points, timeZone }: { points: Point[]; timeZone?: string }) {
  const chart = useRef<HTMLDivElement>(null);
  const [splitDates, setSplitDates] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const dates = points.map(point => {
    const date = new Date(point.startsAt);
    return { month: date.toLocaleDateString(undefined, { month: "short", timeZone }), day: date.toLocaleDateString(undefined, { day: "numeric", timeZone }), full: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone }) };
  });
  const labelsKey = points.map(point => `${point.meetingId}:${point.startsAt}`).join("|");
  useLayoutEffect(() => {
    const element = chart.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const wrapped = Array.from(element.querySelectorAll<HTMLElement>(".trend-date")).some(label => (label.querySelector<HTMLElement>(".trend-date-measure")?.getBoundingClientRect().width ?? 0) > label.clientWidth);
      setSplitDates(wrapped);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    void document.fonts.ready.then(measure);
    return () => { active = false; observer.disconnect(); };
  }, [labelsKey]);
  const selected = points.findIndex((point) => point.meetingId === selectedId);
  const selectedIndex = selected < 0 ? points.length - 1 : selected;
  return <><div className="trend-frame"><div className="trend-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div><div ref={chart} className="trend-chart" data-split-dates={splitDates || undefined} role="group" aria-label="Team regular attendance trend">
    {points.map((point, index) => <button className="ui-button trend-point" type="button" key={point.meetingId} aria-label={`${dates[index].full} - ${point.title}: ${point.rate}% attendance`} aria-pressed={selectedIndex === index} onFocus={() => setSelectedId(point.meetingId)} onClick={() => setSelectedId(point.meetingId)}>
      <span className="trend-plot"><span className="trend-bar" style={{ height: `${point.rate}%` }}><span className="trend-value">{point.rate}%</span></span></span>
      <small className="trend-date"><time dateTime={point.startsAt} aria-label={dates[index].full}><b className="trend-month">{dates[index].month}</b>{" "}<b className="trend-day">{dates[index].day}</b></time><i className="trend-date-measure" aria-hidden="true">{dates[index].month} {dates[index].day}</i></small>
    </button>)}
  </div></div><p className="trend-detail" aria-live="polite">{points[selectedIndex] ? `${dates[selectedIndex].full} - ${points[selectedIndex].title}: ${points[selectedIndex].rate}% regular attendance` : "No eligible meetings in this period."}</p></>;
}
