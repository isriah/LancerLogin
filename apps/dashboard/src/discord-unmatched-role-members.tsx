import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import { unmatchedRoleUserCount } from "./discord-roles";
import "./discord-label-two-way.css";

export type UnmatchedRoleUser = { discordUserId: string; displayName: string; seenAt: string };
export type UnmatchedRoleLabel = { labelId: string; labelName: string; roleId: string; roleName: string; checkedAt?: string; users: UnmatchedRoleUser[] };
export type DiscordUnmatchedRoleMembersProps = {
  /** Loads GET /admin/integrations/discord/label-roles/unmatched (Admin only). Tests and previews may pass their own. */
  load?: () => Promise<{ labels: UnmatchedRoleLabel[] }>;
  /** Changes whenever the page reloads its role links, so the list is read again. */
  refresh?: unknown;
};

/**
 * The Labels page's collapsible list of Discord users who hold a two-way label's role but aren't linked to anyone on
 * the roster. Two-way sync never changes them. It reads what the last two-way check stored, so it costs no Discord call.
 */
export function DiscordUnmatchedRoleMembers({ load = () => api<{ labels: UnmatchedRoleLabel[] }>("/admin/integrations/discord/label-roles/unmatched"), refresh }: DiscordUnmatchedRoleMembersProps) {
  const { path, navigate } = usePath();
  const [labels, setLabels] = useState<UnmatchedRoleLabel[]>();
  const [error, setError] = useState("");
  useEffect(() => { let current = true; void load().then((result) => { if (current) { setLabels(result.labels); setError(""); } }).catch((reason: Error) => { if (current) setError(reason.message); }); return () => { current = false; }; }, [refresh]);
  const total = labels ? unmatchedRoleUserCount(labels) : 0;
  return <details className="settings-disclosure discord-unmatched-disclosure">
    <summary><span>Discord users not on the roster{labels && <> <span className="status-pill ui-status" data-tone={total ? "warning" : "neutral"}>{total}</span></>}</span></summary>
    <div className="discord-unmatched">
      <p>These people hold a two-way label's Discord role but aren't linked to anyone on the roster, so two-way sync leaves them alone. Pair them in <RouteLink href="/roster" currentPath={path} navigate={navigate}>Roster</RouteLink> to sync their label.</p>
      {error && !labels ? <p className="ui-status" data-tone="error" role="status">{error}</p>
        : !labels ? <p className="ui-status" role="status">Loading…</p>
        : !labels.length ? <p>No labels sync both ways.</p>
        : labels.map((label) => <div className="discord-unmatched-label" key={label.labelId}>
          <h3>{label.labelName} · @{label.roleName}</h3>
          {label.users.length ? <ul className="compact-list">{label.users.map((user) => <li key={user.discordUserId}><strong>{user.displayName}</strong> <small>{user.discordUserId}</small></li>)}</ul> : <p>Everyone with @{label.roleName} is on the roster.</p>}
          {label.checkedAt && <small className="discord-unmatched-checked">Checked {new Date(label.checkedAt).toLocaleString()}</small>}
        </div>)}
    </div>
  </details>;
}
