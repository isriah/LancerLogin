# Updater browser request cadence

WU178 shares one cloud updater request owner across the indicator, availability popup and Updates page within a browser document. Automatic requests run only while visible and subscribed. A new page consumer joins an existing request or requests fresh state; it never applies a cached admission result. Hidden documents stop automatic polling and resume when the next check is due.

| State | Automatic cadence |
| --- | --- |
| Running/reconciling job or release scan | 5 seconds |
| Idle, available or terminal job | 60 seconds |
| Unconfigured service | 5 minutes |
| Transport failure | 30 seconds, doubling to a 5-minute cap |

The existing six-hour signed-release discovery age remains a server-check trigger, not a browser status cache. Status results are no longer persisted in local storage. Only authoritative new responses are delivered to subscribers. Thus a completed release is replaced on the next successful read instead of being advertised from a six-hour display cache. Each browser document owns its cadence; this does not coalesce different browser tabs or users.

Explicit Refresh bypasses cadence/backoff and fetches fresh cloud and kiosk status. Simultaneous explicit refresh requests coalesce. Mutations serialize with in-flight status requests, invalidate their delivery generation and publish the action's authoritative result. A late pre-action response cannot clear a saved admission or overwrite newer action state. Frozen admission and recovery UUIDs retain their existing lost-response semantics. No browser cache makes an authorization or admission decision.

Kiosk reads have their own visible-only cadence: 60 seconds normally, 10 seconds while a command is awaiting a receipt or restart. Cloud job polling does not repeatedly fetch kiosk lists, commands or the release feed. Manual refresh and kiosk command submission still refresh immediately. The command payload, physical kiosk source and safety checks are unchanged.

Focused checks: `node --experimental-strip-types --test tests-ts/updater-polling.test.ts`, `npm run verify:dashboard`, and `npx playwright test tests-browser/updates-page.spec.ts --workers=1`. Fake-clock tests cover three shared consumers, idle/active/unconfigured cadence, visibility, failure backoff, explicit refresh coalescing and pre-action response invalidation. Browser tests count requests through the mounted page/indicator/popup and retain existing admission/recovery behavior coverage.

UI review: this unit changes request ownership and timing only. Existing headings, labels, keyboard behavior, control states, semantic colors and typography/spacing/shape tokens remain in place; it adds no markup or CSS. The existing focused branded desktop/mobile case remains in the browser suite. No new theme matrix is introduced for this polling-only change. Local dependency junctions can cause Vite font-serving warnings; behavioral assertions do not establish font rendering under that development setup.
