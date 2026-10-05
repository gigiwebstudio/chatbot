import { VoyageAIClient } from "voyageai";

let client: VoyageAIClient | null = null;

// voyage-4 (not voyage-3.5, now a legacy model with no free-tier tokens)
// gets 200M free tokens/month - see the cost discussion in the project
// history for why this matters for a low-volume clinic chatbot.
const EMBEDDING_MODEL = process.env.VOYAGE_EMBED_MODEL || "voyage-4";
export const EMBEDDING_DIMENSION = 1024;

function getVoyageClient(): VoyageAIClient {
  if (client) return client;

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing VOYAGE_API_KEY environment variable");
  }

  client = new VoyageAIClient({ apiKey });
  return client;
}

export async function embedQuery(text: string): Promise<number[]> {
  const voyage = getVoyageClient();

  const response = await voyage.embed({
    input: text,
    model: EMBEDDING_MODEL,
    inputType: "query",
    outputDimension: EMBEDDING_DIMENSION,
  });

  const embedding = response.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("Voyage AI returned no embedding for the query");
  }

  return embedding;
}

const VOYAGE_BATCH_LIMIT = 128;

// For indexing knowledge-base content (inputType "document") - use embedQuery
// for the user's search query instead, since Voyage optimizes each differently.
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const voyage = getVoyageClient();
  const results: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += VOYAGE_BATCH_LIMIT) {
    const batch = texts.slice(start, start + VOYAGE_BATCH_LIMIT);

    const response = await voyage.embed({
      input: batch,
      model: EMBEDDING_MODEL,
      inputType: "document",
      outputDimension: EMBEDDING_DIMENSION,
    });

    if (!response.data || response.data.length !== batch.length) {
      throw new Error("Voyage AI returned an unexpected number of embeddings");
    }

    for (const item of response.data) {
      if (!item.embedding || item.index === undefined) {
        throw new Error("Voyage AI returned an incomplete embedding item");
      }
      results[start + item.index] = item.embedding;
    }
  }

  return results;
}
