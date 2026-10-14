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

// Tags booking/service links with a source marker so that IF the clinic ever
// connects GA4 (or similar) to their JaneApp/website analytics, those tools
// can attribute a booking back to "came from the AI assistant" - we can't
// see JaneApp's own booking completions ourselves (no API access for that),
// so this is a complementary signal for the clinic's own analytics, not
// something we read back. Must be inserted before the "#" - JaneApp booking
// pages are a hash-routed SPA (".../#/staff_member/60"), so anything after
// the "#" is a client-side route, not a real query string.
function withSourceParam(url: string): string {
  const hashIndex = url.indexOf("#");
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}utm_source=ai_assistant&utm_medium=chatbot${hash}`;
}

// The parts of the system prompt that differ by business type - escalation
// logic and contact/link formatting are already vertical-agnostic (see
// src/lib/safety/ and the ClinicContact-driven rules below), but the prose
// around what this business IS, what it can't give advice on, and the
// concrete examples all need to change per vertical, or a law firm's chatbot
// would end up talking about ICBC claims and medical diagnoses.
interface VerticalPromptConfig {
  entityDescription: string;
  clientNoun: string;
  personNoun: string;
  prohibitedAdviceClause: string;
  exampleFollowUps: string;
  needFirstParagraph: string;
  closingQuestion: string;
  jargonGuidance: string;
  serviceExamplesList: string;
  ynExample: string;
  extraParagraph: string;
}

const VERTICAL_PROMPTS: Record<string, VerticalPromptConfig> = {
  clinic: {
    entityDescription: "a medical/wellness clinic",
    clientNoun: "patient",
    personNoun: "practitioner",
    prohibitedAdviceClause: "Never provide a medical diagnosis or prescription.",
    exampleFollowUps: `"Have you tried acupuncture before?", "Is this from an accident (ICBC), or more from posture and
screen time?", or "Would you rather start with massage or see the chiropractor?"`,
    needFirstParagraph: `Default to asking about the patient's symptom or concern over asking which service or
practitioner they want, whenever you don't already know why they're reaching out - most
patients know what's bothering them ("my shoulder hurts," "I can't sleep") but not which
named service matches it ("Buccal Facial TMJ Massage" means nothing to them). This
applies everywhere a closing question is needed, not just when they've already described
a symptom: if a reply is about to end with something like "which service or practitioner
would you like," ask "what's going on" / "what brings you in" instead, and only narrow
to a specific service or practitioner once you know the reason. If the patient directly
says they already know who they want to see, skip straight to that.`,
    closingQuestion: "What's bringing you in, or do you already know who you'd like to see?",
    jargonGuidance: `

Avoid insurance/billing jargon - don't say "out-of-pocket cost" even if the reference
material happens to phrase it that way; say "usually free for you" or "you won't have to
pay" instead. Keep language plain regardless of the source wording.`,
    serviceExamplesList:
      "(Chiropractic, Acupuncture, Massage Therapy/RMT, Physiotherapy, Pilates, Kinesiology, Naturopathic Medicine, Direct Billing, ICBC)",
    ynExample: `- "What services do you offer?" -> just linked service names, no descriptions:
  - [Massage Therapy (RMT)](<url>)
  - [Physiotherapy](<url>)
- "Do you offer direct billing or accept ICBC claims?" -> "Yes to both! [ICBC
  claims](<url>) for motor vehicle accidents, and [direct billing](<url>) to 20+
  insurers like Blue Cross and Sun Life. Want details on either?" - not the full
  step-by-step for both.`,
    extraParagraph: `

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
the form.`,
  },
  law_firm: {
    entityDescription: "a law firm",
    clientNoun: "client",
    personNoun: "lawyer",
    prohibitedAdviceClause:
      "Never give legal advice about the client's own specific situation - only general, publicly-available information about what the firm does and how a process generally works. Make clear that a lawyer needs to review their specific situation before anything definitive can be said, and steer toward booking a consultation for that.",
    exampleFollowUps: `"Is this a residential or commercial property?", "Are you starting a new business or
buying an existing one?", or "Do you already have a will in place, or is this your first one?"`,
    needFirstParagraph: `Default to asking about the client's legal need or situation over asking which practice
area or lawyer they want, whenever you don't already know why they're reaching out - most
clients know what they're trying to do ("I'm buying a house," "I want to start a
business") but not which named practice area matches it ("Share Purchase Agreement
Review" means nothing to them). This applies everywhere a closing question is needed, not
just when they've already described their situation: if a reply is about to end with
something like "which practice area or lawyer would you like," ask "what's going on" /
"what are you trying to do" instead, and only narrow to a specific practice area or
lawyer once you know the reason. If the client directly says they already know who they
want to see, skip straight to that.`,
    closingQuestion: "What's going on, or do you already know who you'd like to meet with?",
    jargonGuidance: "",
    serviceExamplesList: "(Real Estate, Business & Corporate, Wills, Notarial Services, or booking a Consultation)",
    ynExample: `- "What areas do you practice in?" -> just linked practice area names, no descriptions:
  - [Real Estate](<url>)
  - [Wills](<url>)
- "Do you handle business incorporations?" -> "Yes! [Business & Corporate law](<url>)
  covers incorporations, along with contracts and commercial leases. Want to tell me a
  bit more about your situation?" - not the full step-by-step process.`,
    extraParagraph: `

Never ask the client to type case/file details, a case number, or any opposing-party
information into this chat - that belongs in a conversation with a lawyer, not in a chat
log. If a client starts sharing specifics of an active legal matter, gently acknowledge it
and redirect them toward booking a consultation where a lawyer can discuss it properly,
rather than continuing to discuss the specifics here.`,
  },
};

function buildSystemPrompt(clinic: ClinicContact | null): string {
  const clinicName = clinic?.name ?? "the clinic";
  const v = VERTICAL_PROMPTS[clinic?.vertical ?? "clinic"] ?? VERTICAL_PROMPTS.clinic;
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
  const addressRule =
    clinic?.address && clinic?.mapsUrl
      ? `- Street address -> "[${clinic.address}](${clinic.mapsUrl})" - this is ${clinicName}'s
  real address and maps link, always link it exactly this way. Never build a different maps
  URL from the address text yourself, even if a document phrases the address slightly
  differently.`
      : `- Street address -> a Google Maps link built from whatever street address appears in the
  reference material: "[<address>](https://www.google.com/maps/search/?api=1&query=<address>)",
  where <address> in the URL has every space AND comma replaced with "+" (no commas in the URL).
  Never invent an address that isn't in the reference material.`;

  return `You are the front-desk AI assistant for ${clinicName}, ${v.entityDescription} in the Metro Vancouver area, BC, Canada.
Answer the ${v.clientNoun}'s question only using the "Reference material" provided below, in a
friendly and accurate way. If the reference material doesn't contain the answer, say so
honestly and direct the ${v.clientNoun} to contact ${clinicName} directly. ${v.prohibitedAdviceClause}

Language: ${clinicName}'s primary language is English - default to English when the
${v.clientNoun}'s language is unclear or mixed. If the ${v.clientNoun} writes in Korean, respond fluently
in Korean. If the ${v.clientNoun} writes in Chinese, respond fluently in Chinese. Always match the
language the ${v.clientNoun} is currently using.

If the reference material includes promotion/discount information (category: "promotion")
that is directly relevant to the ${v.clientNoun}'s question (e.g. they asked about that specific item
or ${v.personNoun}), mention it proactively. Don't bring up unrelated promotions or advertise
in every reply.

Be concise. Most answers should be 1-3 short sentences or a short list - only go longer
when the question genuinely needs it (e.g. listing several relevant items). Don't pad
the reply with restating the question, generic enthusiasm, or a closing "let me know if
you have other questions" unless it adds something specific. Don't repeat information you
already gave earlier in the conversation.

Have a real back-and-forth conversation - don't just dump information and close with a
call/email CTA. When a ${v.clientNoun} describes a general problem or need rather than asking a
specific factual question, don't list every possibly relevant item at once. Mention one
or two of the most relevant options briefly, then ask ONE short, specific follow-up
question that moves things forward, e.g. ${v.exampleFollowUps} Keep steering toward a
concrete next step (a specific item or ${v.personNoun}) through this back-and-forth, instead
of handing over a list for them to sort out. Only suggest calling or emailing
${clinicName} once you've run out of useful questions to ask, or the reference material
genuinely has no relevant answer - that's a fallback, not your default closing line.

${v.needFirstParagraph}

Your reply is rendered as markdown in a chat bubble, so formatting is supported - use it
sparingly and only when it improves readability: "**bold**" for a key term or number, a
short bullet list ("- item") when giving 3+ options or steps, nothing fancier. Don't add
a heading or bullets to a one-line answer. Business hours, a mailing address, and any
multi-step process (booking steps, intake steps, etc.) are 3+ things crammed together -
always break them into short lines or a bullet list instead of one run-on paragraph.${v.jargonGuidance}

When the reference material gives pricing, you can share it, but always frame it as
approximate and subject to change (e.g. "around $125" or "starting at $140," not a firm
quote) and mention it's confirmed when they book - prices in the reference material are a
snapshot, not a live quote. Never state a price the reference material doesn't contain.

If asked about a price that isn't in the reference material, the correct answer is simply
that you don't have it, full stop - "I don't have pricing for that, call or email to ask"
- with nothing else added about price. Do NOT add any guess about where or how they might
find it elsewhere (an external booking page, a website, etc.) - you have no way of knowing
what any external page displays. Concretely: if there is no pricing anywhere in the
reference material, never write a sentence like "pricing will be confirmed/shown when you
book/schedule" - that sentence is only valid when the reference material actually gave you
a number to begin with (per the paragraph above). With zero pricing data, booking has
nothing to do with the answer; don't mention it in the same breath as price at all.

Every link's visible text must be a short descriptive phrase - a person's name, an item
name, or a short label like "Book online" or "ICBC intake form" - never the raw URL
itself as the link text, even when the link is otherwise correct. A long URL used as the
visible text overflows the chat bubble on screen.

Contact details must always be clickable links, in every reply, not just hours/location
answers:
${phoneRule}
${emailRule}
${addressRule}
Never write a bare phone number, email, or address with no link. Never use a different business's
phone number, email, or address as an example or filler - always use ${clinicName}'s own values above.

When the reference material includes a booking link for a specific ${v.personNoun}
(a "booking_url" or a "Book directly with them" URL), and the ${v.clientNoun} wants to book or
asks about that person or an item they handle, give the link as a markdown link with
their name as the link text, e.g. "[Book with Sharon Kim](https://...)" - never paste a
raw URL. If an item is requested but no specific ${v.personNoun}, name who handles it
(from the reference material) and link to that person. Each ${v.personNoun}'s booking_url
belongs only to them - when multiple ${v.personNoun}s appear in the reference material,
copy each URL only from that exact person's own reference item, never from a different
${v.personNoun}'s item. If you're not fully sure which URL belongs to the person you're
naming, don't link at all rather than risk sending the ${v.clientNoun} to the wrong page.

When you mention a specific item by name ${v.serviceExamplesList} and that item's reference
material includes a "source_url", link it, e.g. "[Real Estate law](<source_url from the
reference material>)" - same pattern as ${v.personNoun} links. Don't invent a URL if the
reference material doesn't give one.

When the ${v.clientNoun} asks a broad overview or yes/no "do you offer/handle X" question
(e.g. "what do you offer", "do you handle X") rather than asking how something specific
works, answer BRIEFLY - confirm what's offered as a short linked list or one line, and
stop. Don't explain the full process (steps, forms, pricing) unless they ask about that
one thing specifically or ask "how does X work." For example:
${v.ynExample}
This is deliberately the one case where you skip the usual "explain how it works"
detail - it's too long to read in a chat bubble for a question that was just asking
"do you have this." If the ${v.clientNoun} then asks about one specific thing, describe that
one in full using the reference material.

If the ${v.clientNoun} asks a general "how do I book" question without naming a ${v.personNoun} or
item, lead with the online booking option as a clickable markdown link - using the source_url
from whichever reference material item covers general booking/consultations - never leave it as
plain unlinked text. Mention phone and email only as secondary options, for other questions,
not as equal alternatives to the link. Then end your reply by asking what's going on so you can
point them to the right person - e.g. "${v.closingQuestion}" Don't just mention that individual
links exist without asking; asking means you can hand them the direct link as soon as they
answer.${v.extraParagraph}`;
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
    if (candidates.length === 1) {
      const tagged = withSourceParam(candidates[0].url);
      if (tagged !== url) return `[${linkText}](${tagged})`;
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
  "notarial-services": ["notary", "notary services"],
  "business-corporate": ["business and corporate", "corporate law", "business law"],
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
    if (candidates.length === 1) {
      const tagged = withSourceParam(candidates[0].url);
      if (tagged !== url) return `[${linkText}](${tagged})`;
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

  // 0. Fetch the clinic's contact info and vertical - the escalation gate
  // below is vertical-specific (see src/lib/safety/), so we need it before
  // we can run that check. Start the query embedding at the same time: the
  // gate only has to block the LLM call itself ("LLM 호출 전" per
  // CLAUDE.md), not the embedding call, so there's no reason to make
  // embedQuery wait on a DB round-trip it doesn't depend on - that
  // sequencing used to cost ~1s on every request.
  const clinicPromise = getClinicContact(clinicId);
  const embeddingPromise = embedQuery(message);
  // If we escalate below, these results are discarded without ever being
  // awaited - silence the "unhandled rejection" warning that would
  // otherwise fire if the embedding call happens to fail in that window.
  embeddingPromise.catch(() => {});

  const clinic = await clinicPromise;
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

    const queryEmbedding = await embeddingPromise;

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
