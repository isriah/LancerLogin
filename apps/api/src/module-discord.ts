import type { ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";
import { bundledModuleRegistry } from "../../../packages/shared/src/module-platform.ts";
import type { D1Database } from "./d1-usage.ts";
import { captureModuleServiceDatabase } from "./module-database-scope.ts";
import { requireModuleService } from "./module-platform.ts";
import { outreachDiscordHandlers } from "./outreach-discord.ts";

export type DiscordModuleInteraction = {
  id?: string;
  type?: number;
  data?: { name?: string; options?: Array<{ name?: string; value?: string }> };
  member?: { user?: { id?: string } };
  user?: { id?: string };
};
export type DiscordModuleInteractionHandler = (db: D1Database, interaction: DiscordModuleInteraction, now: number) => Promise<string>;
export type DiscordModuleContribution = { moduleId: string; handlers: Readonly<Record<string, DiscordModuleInteractionHandler>> };
type DiscordCommandRegistry = { modules: readonly ModuleDefinition[]; get(id: string): ModuleDefinition | undefined; discordCommandOwner(name: string): ModuleDefinition | undefined };

export function createModuleDiscordDispatcher(registry: DiscordCommandRegistry, contributions: readonly DiscordModuleContribution[]) {
  const handlers = new Map<string, DiscordModuleInteractionHandler>(); const contributedModules = new Set<string>();
  for (const contribution of contributions) {
    const module = registry.get(contribution.moduleId);
    if (!module || contributedModules.has(module.id)) throw new Error("Invalid module Discord contribution");
    contributedModules.add(module.id);
    const expected = new Set(module.discordCommands.map((command) => command.name)); const actual = Object.keys(contribution.handlers);
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) throw new Error("Module Discord handlers do not match declared commands");
    for (const [name, handler] of Object.entries(contribution.handlers)) {
      if (handlers.has(name) || registry.discordCommandOwner(name)?.id !== module.id) throw new Error("Discord command handler collision");
      handlers.set(name, handler);
    }
  }
  for (const module of registry.modules) if (module.discordCommands.length && !contributedModules.has(module.id)) throw new Error("Module Discord command handlers are missing");
  return async (db: D1Database, interaction: DiscordModuleInteraction, now = Date.now()): Promise<string | null> => {
    const name = interaction.data?.name; if (!name) return null;
    const owner = registry.discordCommandOwner(name); if (!owner) return null;
    const handler = handlers.get(name); if (!handler) return null;
    const generation = await requireModuleService(db, owner.id);
    return handler(captureModuleServiceDatabase(db, owner.id, generation), interaction, now);
  };
}

export const dispatchModuleDiscordCommand = createModuleDiscordDispatcher(bundledModuleRegistry, [
  { moduleId: "hour-tracking", handlers: outreachDiscordHandlers },
]);
