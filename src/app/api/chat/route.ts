import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { CHAT_MODEL, getAnthropicClient } from "@/lib/anthropic";
import { embedQuery } from "@/lib/voyage";
import {
  getClinicContact,
  getClinicLinkables,
  matchDocuments,
  type ClinicContact,
  type PractitionerLink,
  type ServiceLink,
} from "@/lib/supabase";
import { detectLanguage, getSafetyPack } from "@/lib/safety";

export const runtime = "nodejs";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  clinicId: string;
  message: string;
  history?: ChatMessage[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildSystemPrompt(clinic: ClinicContact | null): string {
  const clinicName = clinic?.name ?? "the clinic";
  const phoneDigits = clinic?.phone?.replace(/\D/g, "");
  const phoneRule =
    clinic?.phone && phoneDigits
      ? `- Phone number -> "[${clinic.phone}](tel:+1${phoneDigits})" - this is ${clinicName}'s real
  number, always link it exactly this way.`
      : `- Phone number -> format as "[<number>](tel:+1<digits>)" using the number as it appears in
  the reference material (strip spaces/dashes, prefix "+1" for a Canadian number).`;
  const emailRule = clinic?.email
    ? `- Email -> "[${clinic.email}](mailto:${clinic.email})" - this is ${clinicName}'s real email,
  always link it exactly this way.`
    : `- Email -> format as "[<email>](mailto:<email>)" using the address as it appears in the
  reference material.`;

  return `You are the front-desk chatbot for ${clinicName}, a medical/wellness clinic in Vancouver, BC, Canada.
Answer the patient's question only using the "Reference material" provided below, in a
friendly and accurate way. If the reference material doesn't contain the answer, say so
honestly and direct the patient to contact the clinic directly. Never provide a medical
diagnosis or prescription.

Language: this clinic's primary language is English - default to English when the
patient's language is unclear or mixed. If the patient writes in Korean, respond fluently
in Korean. If the patient writes in Chinese, respond fluently in Chinese. Always match the
language the patient is currently using.

If the reference material includes promotion/discount information (category: "promotion")
that is directly relevant to the patient's question (e.g. they asked about that treatment
or practitioner), mention it proactively. Don't bring up unrelated promotions or advertise
in every reply.

Be concise. Most answers should be 1-3 short sentences or a short list - only go longer
when the question genuinely needs it (e.g. listing several relevant services). Don't pad
the reply with restating the question, generic enthusiasm, or a closing "let me know if
you have other questions" unless it adds something specific. Don't repeat information you
already gave earlier in the conversation.

Have a real back-and-forth conversation - don't just dump information and close with a
call/email CTA. When a patient describes a general problem or need rather than asking a
specific factual question (e.g. "I have headaches every day"), don't list every possibly
relevant service at once. Mention one or two of the most relevant options briefly, then
ask ONE short, specific follow-up question that moves things forward, e.g. "Have you
tried acupuncture before?", "Is this from an accident (ICBC), or more from posture and
screen time?", or "Would you rather start with massage or see the chiropractor?" Keep
steering toward a concrete next step (a specific service or practitioner) through this
back-and-forth, instead of handing over a list for them to sort out. Only suggest calling
or emailing the clinic once you've run out of useful questions to ask, or the reference
material genuinely has no relevant answer - that's a fallback, not your default closing
line.

Your reply is rendered as markdown in a chat bubble, so formatting is supported - use it
sparingly and only when it improves readability: "**bold**" for a key term or number, a
short bullet list ("- item") when giving 3+ options or steps, nothing fancier. Don't add
a heading or bullets to a one-line answer. Business hours, a mailing address, and any
multi-step process (booking steps, ICBC steps, direct billing steps) are 3+ things
crammed together - always break them into short lines or a bullet list instead of one
run-on paragraph.

Avoid insurance/billing jargon - don't say "out-of-pocket cost" even if the reference
material happens to phrase it that way; say "usually free for you" or "you won't have to
pay" instead. Keep language plain regardless of the source wording.

When the reference material gives pricing, you can share it, but always frame it as
approximate and subject to change (e.g. "around $125" or "starting at $140," not a firm
quote) and mention it's confirmed at booking - prices in the reference material are a
snapshot, not a live quote. Never state a price the reference material doesn't contain.

Contact details must always be clickable links, in every reply, not just hours/location
answers:
${phoneRule}
${emailRule}
- Street address -> a Google Maps link built from whatever street address appears in the
  reference material: "[<address>](https://www.google.com/maps/search/?api=1&query=<address>)",
  where <address> in the URL has every space AND comma replaced with "+" (no commas in the URL).
  Never invent an address that isn't in the reference material.
Never write a bare phone number, email, or address with no link. Never use a different clinic's
phone number, email, or address as an example or filler - always use ${clinicName}'s own values above.

When the reference material includes a JaneApp booking link for a specific practitioner
(a "booking_url" or a "Book directly with them" URL), and the patient wants to book or
asks about that person or a service they provide, give the link as a markdown link with
their name as the link text, e.g. "[Book with Sharon Kim](https://...)" - never paste a
raw URL. If a service is requested but no specific practitioner, name who provides it
(from the reference material) and link to that person. Each practitioner's booking_url
belongs only to them - when multiple practitioners appear in the reference material,
copy each URL only from that exact person's own reference item, never from a different
practitioner's item. If you're not fully sure which URL belongs to the person you're
naming, don't link at all rather than risk sending the patient to the wrong page.

When you mention a specific service by name (Chiropractic, Acupuncture, Massage
Therapy/RMT, Physiotherapy, Pilates, Kinesiology, Naturopathic Medicine, Direct Billing,
ICBC) and that item's reference material includes a "source_url", link it, e.g.
"[Chiropractic care](<source_url from the reference material>)" - same pattern as
practitioner links. Don't invent a URL if the reference material doesn't give one.

When the patient asks a broad overview or yes/no "do you offer/accept X" question
(e.g. "what services do you offer", "do you offer direct billing or accept ICBC
claims") rather than asking how something specific works, answer BRIEFLY - confirm
what's offered as a short linked list or one line, and stop. Don't explain the full
process (steps, forms, pricing) unless they ask about that one thing specifically or
ask "how does X work." For example:
- "What services do you offer?" -> just linked service names, no descriptions:
  - [Massage Therapy (RMT)](<url>)
  - [Physiotherapy](<url>)
- "Do you offer direct billing or accept ICBC claims?" -> "Yes to both! [ICBC
  claims](<url>) for motor vehicle accidents, and [direct billing](<url>) to 20+
  insurers like Blue Cross and Sun Life. Want details on either?" - not the full
  step-by-step for both.
This is deliberately the one case where you skip the usual "explain how it works"
detail - it's too long to read in a chat bubble for a question that was just asking
"do you have this." If the patient then asks about one specific thing, describe that
one in full using the reference material.

If the patient asks a general "how do I book" question without naming a practitioner or
service, give the general booking options (JaneApp portal / phone / email), then end your
reply by directly asking which practitioner or service they'd like - e.g. "Is there a
particular practitioner or service you'd like to book?" Don't just mention that individual
links exist without asking; asking means you can hand them the direct link as soon as they
answer.

If the patient says they were actually in an accident or already has/is starting an ICBC
claim (not just asking whether ICBC is accepted in general - that's the brief yes/no case
above), point them to the ICBC intake form on the clinic website as the primary next step
- link it from the reference
material's source_url, e.g. "[ICBC intake form](<source_url from the reference material>)".
It's faster for the clinic to process than a phone call or email, since it collects
everything needed (claim number, adjuster details) in one submission. Never ask the
patient to type their ICBC claim number, adjuster name, or adjuster phone number into
this chat - that's sensitive information that belongs in the form, not in a chat log.
Mention calling/emailing only as a secondary option for patients who'd rather not use
the form.`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.role === "user" || v.role === "assistant") &&
    typeof v.content === "string"
  );
}

function parseBody(body: unknown): ChatRequestBody {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.clinicId !== "string" || !UUID_RE.test(b.clinicId)) {
    throw new Error("`clinicId` is required and must be a valid UUID");
  }

  if (typeof b.message !== "string" || b.message.trim() === "") {
    throw new Error("`message` is required and must be a non-empty string");
  }

  let history: ChatMessage[] = [];
  if (b.history !== undefined) {
    if (!Array.isArray(b.history) || !b.history.every(isChatMessage)) {
      throw new Error(
        "`history` must be an array of { role: 'user' | 'assistant', content: string }"
      );
    }
    history = b.history;
  }

  return { clinicId: b.clinicId, message: b.message, history };
}

// Names in the KB are always "First (Nickname) Last" or "First Last" - the
// last word is the surname, and either the first word or the parenthesized
// nickname can show up as the first name Claude uses in link text.
function parsePractitionerName(name: string): { lastName: string; firstNames: string[] } {
  const altFirstNames = Array.from(name.matchAll(/\(([^)]+)\)/g)).map((m) =>
    m[1].toLowerCase()
  );
  const mainWords = name
    .replace(/\(.*?\)/g, "")
    .replace(/^dr\.?\s+/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lastName = mainWords[mainWords.length - 1]?.toLowerCase() ?? "";
  const firstNames = [mainWords[0]?.toLowerCase(), ...altFirstNames].filter(
    (v): v is string => Boolean(v)
  );
  return { lastName, firstNames };
}

// Claude occasionally copies the right link text but the wrong (or even
// malformed - wrong domain entirely) URL for a practitioner, especially
// when the correct person's own document wasn't part of this turn's
// retrieved matches (nothing to transcribe from) or when several
// practitioners share a surname (this KB has four "Lee"s). Since sending a
// patient to the wrong or broken booking page is a real-world mistake,
// never trust the model's transcription of a practitioner's URL - check
// every markdown link's text against the clinic's full roster (not just
// this turn's retrieved matches, which may not include the right person at
// all) and force it to that practitioner's actual booking_url whenever the
// text uniquely identifies them (first AND last name, to disambiguate
// shared surnames).
function fixPractitionerLinks(reply: string, roster: PractitionerLink[]): string {
  const known = roster
    .map(({ name, bookingUrl }) => {
      const { lastName, firstNames } = parsePractitionerName(name);
      if (!lastName || firstNames.length === 0) return null;
      return { lastName, firstNames, url: bookingUrl };
    })
    .filter(
      (v): v is { lastName: string; firstNames: string[]; url: string } =>
        v !== null
    );

  if (known.length === 0) return reply;

  // Matches any markdown link, regardless of what URL Claude put there -
  // we're checking the link TEXT against the roster, not trusting the URL
  // as a starting point.
  const linkRe = /\[([^\]]+)\]\(([^\s)]+)\)/g;

  return reply.replace(linkRe, (full, linkText: string, url: string) => {
    const linkLower = linkText.toLowerCase();
    const candidates = known.filter(
      (k) =>
        linkLower.includes(k.lastName) &&
        k.firstNames.some((fn) => linkLower.includes(fn))
    );
    if (candidates.length === 1 && candidates[0].url !== url) {
      return `[${linkText}](${candidates[0].url})`;
    }
    return full;
  });
}

// Service slugs aren't natural-language labels ("naturopathic-medicine"), so
// match on whether all of a slug's hyphen-separated words appear in the link
// text, plus a couple of aliases for services the system prompt tells Claude
// to call something else ("Massage Therapy" for "rmt"). Aliases are
// deliberately multi-word ("massage therapy", not just "massage") so they
// don't accidentally match inside an unrelated sentence, e.g. a practitioner
// link whose surrounding text happens to mention massage.
const SERVICE_ALIASES: Record<string, string[]> = {
  rmt: ["massage therapy"],
  kinesiology: ["personal training"],
};

// Same rationale and mechanism as fixPractitionerLinks - Claude hallucinated
// a single generic homepage URL for every service in testing (all 7 services
// pointed at the same wrong link), so service links get the same
// never-trust-the-model's-URL treatment, checked against the clinic's full
// service list rather than just this turn's retrieved matches.
function fixServiceLinks(reply: string, services: ServiceLink[]): string {
  const known = services
    .map(({ service, sourceUrl }) => ({
      words: service.split("-").map((w) => w.toLowerCase()),
      aliases: SERVICE_ALIASES[service] ?? [],
      url: sourceUrl,
    }))
    .filter((k) => k.words.length > 0 && k.words.every(Boolean));

  if (known.length === 0) return reply;

  const linkRe = /\[([^\]]+)\]\(([^\s)]+)\)/g;

  return reply.replace(linkRe, (full, linkText: string, url: string) => {
    const linkLower = linkText.toLowerCase();
    const candidates = known.filter(
      (k) =>
        k.words.every((w) => linkLower.includes(w)) ||
        k.aliases.some((a) => linkLower.includes(a))
    );
    if (candidates.length === 1 && candidates[0].url !== url) {
      return `[${linkText}](${candidates[0].url})`;
    }
    return full;
  });
}

function buildContext(
  documents: { content: string; similarity: number }[]
): string {
  if (documents.length === 0) {
    return "(No relevant material found.)";
  }
  return documents
    .map(
      (doc, i) =>
        `[Item ${i + 1}] (similarity: ${doc.similarity.toFixed(3)})\n${doc.content}`
    )
    .join("\n\n");
}

export async function POST(req: NextRequest) {
  let parsed: ChatRequestBody;
  try {
    parsed = parseBody(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const { clinicId, message, history } = parsed;

  // 0. Fetch the clinic's contact info and vertical first - the escalation
  // gate right below is vertical-specific (see src/lib/safety/), so we need
  // to know which pack to check against before we can run it. This is the
  // one DB round-trip every request now pays up front; the gate itself stays
  // keyword-based rather than model-based, so it still never costs an
  // embedding or LLM call.
  const clinic = await getClinicContact(clinicId);
  const safetyPack = getSafetyPack(clinic?.vertical);

  if (safetyPack.detectEscalation(message)) {
    console.warn("Escalation keyword detected, escalating.", { clinicId, vertical: clinic?.vertical });
    return NextResponse.json({
      reply: safetyPack.buildEscalationResponse(clinic, detectLanguage(message)),
      sources: [],
      escalate: true,
    });
  }

  try {
    // 1. Kick off the clinic's practitioner/service roster fetch now, but
    // don't await it yet - it's only needed after Claude replies (to correct
    // links), so letting it run in the background while we embed, retrieve,
    // and generate means it adds ~0ms to the critical path instead of
    // blocking step 2 on a round-trip nothing downstream needs yet.
    const linkablesPromise = getClinicLinkables(clinicId);

    const queryEmbedding = await embedQuery(message);

    // 2. Retrieve relevant knowledge-base chunks from Supabase (pgvector),
    // scoped to this clinic only.
    //
    // The threshold here is a low floor that only rejects near-zero-relevance
    // noise, not a relevance filter - within one clinic's narrow, single-domain
    // corpus (especially with cross-lingual queries, e.g. Korean question vs.
    // English KB), on-topic and off-topic chunks score too close together for
    // a similarity cutoff to reliably tell them apart. Actual relevance
    // judgment is left to Claude via the system prompt ("say so honestly" when
    // the answer isn't in the reference material), which can read the
    // retrieved text and decide.
    const matches = await matchDocuments(clinicId, queryEmbedding, 8, 0.2);
    const context = buildContext(matches);

    // 3. Ask Claude Haiku, grounded in the retrieved context
    const anthropic = getAnthropicClient();

    const messages: Anthropic.MessageParam[] = [
      ...(history ?? []).map(
        (m): Anthropic.MessageParam => ({ role: m.role, content: m.content })
      ),
      {
        role: "user",
        content: `Reference material:\n${context}\n\nQuestion: ${message}`,
      },
    ];

    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(clinic),
      messages,
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    const linkables = await linkablesPromise;
    const reply = fixServiceLinks(
      fixPractitionerLinks(textBlock?.text ?? "", linkables.practitioners),
      linkables.services
    );

    return NextResponse.json({
      reply,
      sources: matches.map((m) => ({
        id: m.id,
        similarity: m.similarity,
        metadata: m.metadata,
      })),
    });
  } catch (err) {
    // Always log the real error server-side for debugging, but never leak
    // it to the patient-facing widget - vendor names (Anthropic, Voyage),
    // API key status, billing/dashboard URLs, and raw SDK messages are
    // internal details a clinic visitor has no use for and shouldn't see.
    console.error("Chat API error:", err);

    const isRateLimit =
      err instanceof Anthropic.RateLimitError ||
      (err instanceof Error && /429|rate.?limit/i.test(err.message));

    const status = isRateLimit ? 429 : 500;
    const error = isRateLimit
      ? "We're getting a lot of requests right now. Please try again in a moment."
      : "Something went wrong on our end. Please try again, or contact the clinic directly.";

    return NextResponse.json({ error }, { status });
  }
}
