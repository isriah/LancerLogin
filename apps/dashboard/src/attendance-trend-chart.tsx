import { useLayoutEffect, useRef, useState } from "react";

type Point = { meetingId: string; title: string; startsAt: string; rate: number };

export function AttendanceTrendChart({ points }: { points: Point[] }) {
  const chart = useRef<HTMLDivElement>(null);
  const [splitDates, setSplitDates] = useState(false);
  const dates = points.map(point => {
    const date = new Date(point.startsAt);
    return { month: date.toLocaleDateString(undefined, { month: "short" }), day: date.toLocaleDateString(undefined, { day: "numeric" }), full: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) };
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
  const summary = points.map((point, index) => `${dates[index].full}: ${point.title} ${point.rate}%`).join("; ");
  return <><div ref={chart} className="trend-chart" data-split-dates={splitDates || undefined} role="img" aria-label={`Team regular attendance trend: ${summary}`}>
    {points.map((point, index) => <div key={point.meetingId} title={`${dates[index].full} - ${point.title}: ${point.rate}%`}>
      <span style={{ height: `${point.rate}%` }} />
      <small className="trend-date"><time dateTime={point.startsAt} aria-label={dates[index].full}><b className="trend-month">{dates[index].month}</b>{" "}<b className="trend-day">{dates[index].day}</b></time><i className="trend-date-measure" aria-hidden="true">{dates[index].month} {dates[index].day}</i></small>
    </div>)}
  </div><ul className="visually-hidden">{points.map((point, index) => <li key={point.meetingId}>{dates[index].full} - {point.title}: {point.rate}% regular attendance</li>)}</ul></>;
}
