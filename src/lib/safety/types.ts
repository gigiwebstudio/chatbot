import type { ClinicContact } from "@/lib/supabase";

export type SupportedLanguage = "en" | "ko" | "zh";

// Cheap, deterministic (no LLM call, keeping the escalation path fast and
// auditable) - Hangul presence means Korean; CJK ideographs without Hangul
// means Chinese; otherwise default to English. Good enough to pick the one
// language the patient is actually reading in for a short escalation notice.
export function detectLanguage(message: string): SupportedLanguage {
  if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(message)) return "ko";
  if (/[一-鿿]/.test(message)) return "zh";
  return "en";
}

// One implementation per vertical (clinic, law_firm, accounting, ...),
// selected at runtime by the clinic's `vertical` column (see
// supabase/schema.sql and src/lib/safety/index.ts). Each pack owns its own
// hard, deterministic gate - what counts as an escalation and what the
// escalation message says - since both are vertical-specific (a medical
// emergency keyword list means nothing to a law firm). See
// src/lib/safety/clinic.ts for why the gate itself is keyword-based rather
// than model-based.
export interface SafetyPack {
  detectEscalation(message: string): boolean;
  buildEscalationResponse(
    clinic: ClinicContact | null,
    language: SupportedLanguage
  ): string;
}
