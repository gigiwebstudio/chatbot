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

export interface ServiceLink {
  service: string;
  sourceUrl: string;
}

export interface ClinicLinkables {
  practitioners: PractitionerLink[];
  services: ServiceLink[];
}

// Full clinic roster of practitioners and services, independent of
// similarity search - one query, used to correct both practitioner and
// service links in the LLM's reply. Matching against only that turn's
// top-K retrieved docs isn't enough, since the correct doc may not have
// been retrieved (e.g. a massage question won't surface the chiropractor's
// doc), leaving a hallucinated or wrong link with nothing to check it
// against.
export async function getClinicLinkables(
  clinicId: string
): Promise<ClinicLinkables> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("documents")
    .select("metadata")
    .eq("clinic_id", clinicId);

  if (error) {
    throw new Error(`Failed to fetch clinic roster: ${error.message}`);
  }

  const practitioners = new Map<string, string>();
  const services = new Map<string, string>();
  for (const row of data ?? []) {
    const meta = (row as { metadata: Record<string, unknown> }).metadata;

    const name = meta.name ?? meta.practitioner;
    const bookingUrl = meta.booking_url;
    if (typeof name === "string" && typeof bookingUrl === "string" && !practitioners.has(name)) {
      practitioners.set(name, bookingUrl);
    }

    // "billing" docs (ICBC, direct billing) are link targets the same way
    // services are - their own content text doesn't always spell out the
    // URL inline (direct-billing's doesn't), so without this they'd have no
    // URL for Claude to copy even an approximate one from.
    if (meta.category === "service" || meta.category === "billing") {
      const service = meta.service;
      const sourceUrl = meta.source_url;
      if (typeof service === "string" && typeof sourceUrl === "string" && !services.has(service)) {
        services.set(service, sourceUrl);
      }
    }
  }
  return {
    practitioners: Array.from(practitioners, ([name, bookingUrl]) => ({ name, bookingUrl })),
    services: Array.from(services, ([service, sourceUrl]) => ({ service, sourceUrl })),
  };
}

export interface ClinicContact {
  name: string;
  phone: string | null;
  email: string | null;
  vertical: string;
  address: string | null;
  mapsUrl: string | null;
}

// Used by the escalation gate (src/lib/safety/) to pick the right pack and
// build its response, and by the chat route to template the system prompt -
// a plain row lookup, no RAG.
export async function getClinicContact(
  clinicId: string
): Promise<ClinicContact | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("clinics")
    .select("name, phone, email, vertical, address, maps_url")
    .eq("id", clinicId)
    .maybeSingle();

  if (error || !data) return null;
  return {
    name: data.name,
    phone: data.phone,
    email: data.email,
    vertical: data.vertical,
    address: data.address,
    mapsUrl: data.maps_url,
  };
}
