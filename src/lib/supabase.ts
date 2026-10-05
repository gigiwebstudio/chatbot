import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable"
    );
  }

  // Service role key bypasses RLS - only ever use this client from server-side
  // code (API routes / server actions), never expose it to the browser.
  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return client;
}

export interface MatchedDocument {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export async function matchDocuments(
  clinicId: string,
  embedding: number[],
  matchCount = 5,
  matchThreshold = 0.5
): Promise<MatchedDocument[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc("match_documents", {
    p_clinic_id: clinicId,
    query_embedding: embedding,
    match_count: matchCount,
    match_threshold: matchThreshold,
  });

  if (error) {
    throw new Error(`Supabase match_documents failed: ${error.message}`);
  }

  return (data ?? []) as MatchedDocument[];
}

export interface PractitionerLink {
  name: string;
  bookingUrl: string;
}

// Full clinic roster (name -> booking_url), independent of similarity
// search. Used to correct practitioner links in the LLM's reply - matching
// against only that turn's top-K retrieved docs isn't enough, since the
// correct person's own doc may not have been retrieved (e.g. a massage
// question won't surface the chiropractor's doc), leaving a hallucinated
// or wrong-practitioner link with nothing to check it against.
export async function getAllPractitioners(
  clinicId: string
): Promise<PractitionerLink[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("documents")
    .select("metadata")
    .eq("clinic_id", clinicId);

  if (error) {
    throw new Error(`Failed to fetch practitioner roster: ${error.message}`);
  }

  const seen = new Map<string, string>();
  for (const row of data ?? []) {
    const meta = (row as { metadata: Record<string, unknown> }).metadata;
    const name = meta.name ?? meta.practitioner;
    const url = meta.booking_url;
    if (typeof name === "string" && typeof url === "string" && !seen.has(name)) {
      seen.set(name, url);
    }
  }
  return Array.from(seen.entries()).map(([name, bookingUrl]) => ({ name, bookingUrl }));
}

export interface ClinicContact {
  name: string;
  phone: string | null;
  email: string | null;
}

// Used by the emergency-escalation gate (src/lib/safety.ts), which must
// respond without an embedding/LLM round-trip - a plain row lookup, no RAG.
export async function getClinicContact(
  clinicId: string
): Promise<ClinicContact | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("clinics")
    .select("name, phone, email")
    .eq("id", clinicId)
    .maybeSingle();

  if (error || !data) return null;
  return data as ClinicContact;
}
