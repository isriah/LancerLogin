import { createContext, useContext } from "react";
import { type Person, type PersonDraft, type ParticipantDraft, toPersonDraft } from "./carpool-model";

export const AssignmentActionContext = createContext<{ edit: (riderId: string, action: "move" | "swap") => void; review: (riderId: string) => void }>({ edit: () => undefined, review: () => undefined });

export const ParticipantDraftContext = createContext<{ drafts: Record<string, ParticipantDraft>; update: (person: Person, value: PersonDraft) => void; cancel: (id: string) => void; rebase: (person: Person) => void }>({ drafts: {}, update: () => undefined, cancel: () => undefined, rebase: () => undefined });
export function useParticipantDraft(person: Person) {
  const { drafts, update, cancel, rebase } = useContext(ParticipantDraftContext);
  const entry = drafts[person.id]; const value = entry?.value ?? toPersonDraft(person);
  return { draft: value, setDraft: (next: PersonDraft) => update(person, next), dirty: Boolean(entry), conflict: Boolean(entry && entry.base.revision !== person.revision), cancel: () => cancel(person.id), rebase: () => rebase(person) };
}
