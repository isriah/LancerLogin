// Dashboard-side module interfaces. Plugin dashboard code imports only from this SDK and declares React as a peer dependency,
// so the composed dashboard and every plugin share one React instance.
export { dashboardSlots } from "../../../apps/dashboard/src/module-contributions.ts";
export type {
  DashboardMeetingReference,
  DashboardModuleContribution,
  DashboardModuleWalkthrough,
  DashboardNavigate,
  DashboardPageContext,
  DashboardPathParams,
  DashboardPublicPage,
  DashboardPublicPageContext,
  DashboardRole,
  DashboardSettingsPage,
  DashboardSetupProps,
  DashboardSlotId,
  DashboardSlotProps,
  DashboardWorkspaceRoute,
} from "../../../apps/dashboard/src/module-contributions.ts";
export { useModuleSlotData } from "../../../apps/dashboard/src/module-slots.tsx";
/** Same-origin JSON client for the module's own API routes. */
export { api as dashboardApi, apiBaseUrl as dashboardApiBaseUrl } from "../../../apps/dashboard/src/dashboard-api.ts";
/** Walkthrough definitions for a module's `walkthroughs`; the page ID must be one the manifest declares in `walkthroughs`. */
export type { WalkthroughExperienceDefinition } from "../../../apps/dashboard/src/page-walkthrough.tsx";
/**
 * The month calendar and calendar/table toggle used by Core's meeting pages, with the pencil icon of compact edit buttons.
 * `useCalendarSelection` keeps the shown month and selected day, optionally per browser.
 */
export { CalendarViewToggle, MonthCalendar, PencilIcon } from "../../../apps/dashboard/src/mobile-calendar.tsx";
export { useCalendarSelection } from "../../../apps/dashboard/src/calendar-selection.ts";

// Core UI behavior a module page shares with Core pages, so plugin dialogs, links and settings sections behave identically.
/** Trap focus in an open dialog, restore it on close, and call `onEscape` for Escape unless `busy`. */
export { useModalFocus } from "../../../apps/dashboard/src/modal-focus.ts";
/**
 * Client-side navigation: `usePath` reads the current path and search and navigates; `RouteLink` is an anchor that navigates
 * in place. Listen for `routeWillChangeEvent` on window and call `preventDefault()` to keep unsaved work before navigation.
 * Anything that opens a record or page is a real link so Ctrl/Cmd/middle-click opens a new tab: `AppLink` is an anchor
 * without RouteLink's active state, `followInApp` is the click handler for your own `<a href>`, `followRowInApp` handles a
 * clickable row that also contains the record's link, and `isModifiedClick` tells the browser's clicks from plain ones.
 * A `MonthCalendar` `desktopDayOpen` result with `href` renders that day as a link too.
 */
export { AppLink, followInApp, followRowInApp, isModifiedClick, RouteLink, routeWillChangeEvent, usePath } from "../../../apps/dashboard/src/router.tsx";
/** Section links (with a narrow-screen picker) for a module settings page that has several sections, as Core settings pages use. */
export { SettingsSectionNavigation, settingsSectionHref } from "../../../apps/dashboard/src/settings-section-navigation.tsx";

import type { DashboardModuleContribution } from "../../../apps/dashboard/src/module-contributions.ts";

/** Identity helper that type-checks a module's dashboard contribution. */
export function defineDashboardModule(contribution: DashboardModuleContribution): DashboardModuleContribution {
  return contribution;
}
