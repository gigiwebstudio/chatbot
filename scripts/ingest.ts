// Ingests a knowledge-base seed file into Supabase: upserts the clinic row,
// embeds each document's content with Voyage AI, and inserts the rows.
//
// Usage: npm run ingest -- supabase/seed/joayo-therapy.json
import { config } from "dotenv";
import { readFileSync } from "fs";

config({ path: ".env.local" });

import { embedDocuments } from "../src/lib/voyage";
import { getSupabaseClient } from "../src/lib/supabase";

interface SeedDocument {
  content: string;
  metadata: Record<string, unknown>;
  // ISO timestamp. Omit for content that never expires (most documents).
  // Once past, match_documents() stops returning this row - see schema.sql.
  expires_at?: string;
}

interface SeedFile {
  clinic: {
    slug: string;
    name: string;
    booking_url?: string;
    phone?: string;
    email?: string;
    // Which safety/prompt pack this clinic loads at runtime. Omit for the
    // default 'clinic' vertical (see supabase/schema.sql).
    vertical?: string;
  };
  documents: SeedDocument[];
}

async function main() {
  const seedPath = process.argv[2];
  if (!seedPath) {
    console.error("Usage: npm run ingest -- <path-to-seed.json>");
    process.exit(1);
  }

  const seed: SeedFile = JSON.parse(readFileSync(seedPath, "utf-8"));
  const supabase = getSupabaseClient();

  console.log(`Upserting clinic "${seed.clinic.slug}"...`);
  const { data: clinic, error: clinicError } = await supabase
    .from("clinics")
    .upsert(
      {
        slug: seed.clinic.slug,
        name: seed.clinic.name,
        booking_url: seed.clinic.booking_url ?? null,
        phone: seed.clinic.phone ?? null,
        email: seed.clinic.email ?? null,
        vertical: seed.clinic.vertical ?? "clinic",
      },
      { onConflict: "slug" }
    )
    .select()
    .single();

  if (clinicError || !clinic) {
    throw new Error(`Failed to upsert clinic: ${clinicError?.message}`);
  }
  console.log(`Clinic id: ${clinic.id}`);

  console.log(`Clearing existing documents for clinic "${seed.clinic.slug}"...`);
  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("clinic_id", clinic.id);
  if (deleteError) {
    throw new Error(`Failed to clear existing documents: ${deleteError.message}`);
  }

  console.log(`Embedding ${seed.documents.length} documents via Voyage AI...`);
  const embeddings = await embedDocuments(
    seed.documents.map((d) => d.content)
  );

  const rows = seed.documents.map((doc, i) => ({
    clinic_id: clinic.id,
    content: doc.content,
    metadata: doc.metadata,
    embedding: embeddings[i],
    expires_at: doc.expires_at ?? null,
  }));

  console.log(`Inserting ${rows.length} documents...`);
  const { error: insertError } = await supabase.from("documents").insert(rows);
  if (insertError) {
    throw new Error(`Failed to insert documents: ${insertError.message}`);
  }

  console.log(
    `Done. Inserted ${rows.length} documents for clinic "${clinic.slug}" (${clinic.id}).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
