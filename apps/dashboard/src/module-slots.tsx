import { createContext, useContext, useLayoutEffect, useState, type ComponentType, type ReactNode } from "react";
import { dashboardSlotContributors, dashboardSlots, type DashboardDataSlotId, type DashboardModuleSet, type DashboardRenderSlotId, type DashboardSlotProps } from "./module-contributions.ts";

type ModuleRuntime = { readonly modules: DashboardModuleSet; readonly ready: (moduleId: string) => boolean };
type SlotDataValues = Readonly<Partial<Record<DashboardDataSlotId, Readonly<Record<string, unknown>>>>>;

const ModuleRuntimeContext = createContext<ModuleRuntime | undefined>(undefined);
const ModuleIdentityContext = createContext<string | undefined>(undefined);
const SlotDataContext = createContext<SlotDataValues>({});

/** Core provides the installed modules and their current readiness to host slots. */
export const DashboardModuleRuntime = ModuleRuntimeContext.Provider;

/** The element that marks a module's rendered UI and scopes its stylesheet. It generates no box of its own. */
export function ModuleRoot({ moduleId, inline = false, children }: { moduleId: string; inline?: boolean; children: ReactNode }) {
  const content = <ModuleIdentityContext.Provider value={moduleId}>{children}</ModuleIdentityContext.Provider>;
  return inline ? <span className="module-root" data-module={moduleId}>{content}</span> : <div className="module-root" data-module={moduleId}>{content}</div>;
}

/** Render every ready contribution to a host render slot, each inside its module root. */
export function ModuleSlot<Id extends DashboardRenderSlotId>({ id, props }: { id: Id; props: DashboardSlotProps[Id] }) {
  const runtime = useContext(ModuleRuntimeContext);
  if (!runtime) return null;
  return <>{dashboardSlotContributors(runtime.modules, id, runtime.ready).map(({ manifest, contribution }) => {
    const Component = contribution.slots![id] as ComponentType<DashboardSlotProps[Id]>;
    return <ModuleRoot key={manifest.id} moduleId={manifest.id} inline={dashboardSlots[id].kind === "inline"}><Component {...props} /></ModuleRoot>;
  })}</>;
}

/** Wrap a host region with a data slot. Each ready contribution's data hook runs once for the region without changing its markup. */
export function ModuleSlotData<Id extends DashboardDataSlotId>({ id, props, children }: { id: Id; props: DashboardSlotProps[Id]; children: ReactNode }) {
  const runtime = useContext(ModuleRuntimeContext);
  const parent = useContext(SlotDataContext);
  const [values, setValues] = useState<Readonly<Record<string, unknown>>>({});
  const contributors = runtime ? dashboardSlotContributors(runtime.modules, id, runtime.ready) : [];
  const current = Object.fromEntries(contributors.filter(({ manifest }) => Object.hasOwn(values, manifest.id)).map(({ manifest }) => [manifest.id, values[manifest.id]]));
  return <SlotDataContext.Provider value={{ ...parent, [id]: current }}>
    {contributors.map(({ manifest, contribution }) => <SlotDataHook key={manifest.id} use={contribution.slotData![id] as (props: DashboardSlotProps[Id]) => unknown} props={props} onValue={(value) => setValues((previous) => Object.hasOwn(previous, manifest.id) && previous[manifest.id] === value ? previous : { ...previous, [manifest.id]: value })} />)}
    {children}
  </SlotDataContext.Provider>;
}

function SlotDataHook<Props>({ use, props, onValue }: { use: (props: Props) => unknown; props: Props; onValue: (value: unknown) => void }) {
  const value = use(props);
  useLayoutEffect(() => { onValue(value); }, [value]);
  return null;
}

/** Read the value this module's data hook produced for the nearest enclosing data slot. */
export function useModuleSlotData<T>(id: DashboardDataSlotId): T | undefined {
  const moduleId = useContext(ModuleIdentityContext);
  const values = useContext(SlotDataContext);
  return moduleId ? values[id]?.[moduleId] as T | undefined : undefined;
}
