import { clinicSafetyPack } from "./clinic";
import type { SafetyPack } from "./types";

export { detectLanguage } from "./types";
export type { SafetyPack, SupportedLanguage } from "./types";

const PACKS: Record<string, SafetyPack> = {
  clinic: clinicSafetyPack,
};

// Falls back to the clinic/medical pack for an unknown or missing vertical -
// every clinic row defaults to vertical='clinic' (see supabase/schema.sql),
// so this only matters for a bad/unset value, and failing toward the
// strictest pack we have is safer than failing open with no escalation gate.
export function getSafetyPack(vertical: string | null | undefined): SafetyPack {
  return PACKS[vertical ?? "clinic"] ?? clinicSafetyPack;
}
