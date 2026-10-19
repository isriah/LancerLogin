import type { LocationLookup } from "./carpool-model";

export function CarpoolLocationStatus({ lookup, busy, onRetry }: { lookup: LocationLookup; busy: boolean; onRetry: () => Promise<void> }) {
  if (!lookup.remaining) return null;
  const pending = lookup.state === "queued" || lookup.state === "running";
  return <section className="ui-card carpool-location-progress" aria-label="Automatic location lookup"><div role="status"><strong>{pending ? "Locating saved addresses..." : lookup.state === "unconfigured" ? "Automatic lookup is not configured" : "Automatic lookup paused"}</strong><p>{pending ? `${lookup.remaining} trip locations awaiting lookup. Only unmatched addresses will need manual review.` : lookup.state === "unconfigured" ? "An Administrator can configure location lookup in Settings > Modules > Carpool. Manual pins are also available in participant details." : lookup.errorCode === "conflict" ? "The saved plan changed during lookup. Refresh saved data before retrying. Your local edits are retained." : "The lookup service did not finish. Retry saved addresses or place manual pins. Your local edits are retained."}</p></div>{lookup.state === "failed" && <button className="ui-button" type="button" disabled={busy} onClick={() => void onRetry()}>Retry location lookup</button>}</section>;
}
