import { useEffect, useState } from "react";
import { api } from "./dashboard-api";

type Contest = { status: "open" };

export function ContestIndicator({ openMeetings }: { openMeetings: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => { void api<{ contests: Contest[] }>("/discord/contests").then((result) => setCount(result.contests.filter((contest) => contest.status === "open").length)).catch(() => undefined); }, []);
  if (!count) return null;
  return <button className="contest-indicator" type="button" onClick={openMeetings} aria-label={`${count} attendance contest${count === 1 ? "" : "s"} awaiting review. Open Home.`}><span aria-hidden="true">!</span> {count} contest{count === 1 ? "" : "s"} awaiting review</button>;
}
