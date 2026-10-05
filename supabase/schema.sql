-- RAG knowledge base schema for the clinic chatbot.
-- Multi-tenant: every clinic (Joayo Therapy, Queen's Therapy, Acuplus, Reversepain, ...)
-- shares this schema, scoped by clinic_id. See CLAUDE.md.
-- Run this in the Supabase SQL editor (or via `supabase db push`).

create extension if not exists vector;
create extension if not exists pgcrypto; -- for gen_random_uuid()

create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique, -- e.g. 'joayo-therapy', 'queens-therapy'
  name text not null,
  booking_url text, -- JaneApp base link; per-service overrides can live in a service table later
  -- Used for the emergency-escalation response (src/lib/safety.ts), which must
  -- reply without an embedding/LLM round-trip - so it can't come from `documents`.
  phone text,
  email text,
  created_at timestamptz not null default now()
);

alter table clinics add column if not exists phone text;
alter table clinics add column if not exists email text;

create table if not exists documents (
  id bigserial primary key,
  clinic_id uuid not null references clinics(id) on delete cascade,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  -- Dimension must match EMBEDDING_DIMENSION in src/lib/voyage.ts (voyage-3.5 @ 1024 dims)
  embedding vector(1024),
  -- Null = never expires. Time-limited content (e.g. promotions) should set
  -- this so match_documents() stops surfacing it once it's out of date.
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- Safe to re-run on an existing table: adds the column if this schema was
-- applied before expires_at existed.
alter table documents add column if not exists expires_at timestamptz;

create index if not exists documents_clinic_id_idx
  on documents (clinic_id);

-- Cosine-similarity ANN index for fast nearest-neighbor search
create index if not exists documents_embedding_idx
  on documents using hnsw (embedding vector_cosine_ops);

-- RPC used by src/lib/supabase.ts -> matchDocuments()
-- Always scoped to one clinic - never search across clinics.
create or replace function match_documents (
  p_clinic_id uuid,
  query_embedding vector(1024),
  match_count int default 5,
  -- Low floor to reject near-zero-relevance noise only - not a relevance
  -- filter. See the comment above the call site in src/app/api/chat/route.ts.
  match_threshold float default 0.2
)
returns table (
  id bigint,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    documents.id,
    documents.content,
    documents.metadata,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where documents.clinic_id = p_clinic_id
    and documents.embedding is not null
    and (documents.expires_at is null or documents.expires_at > now())
    and 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
$$;
