import { NextRequest, NextResponse } from "next/server";
import { insertEvent, type EventType } from "@/lib/supabase";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_TYPES: EventType[] = [
  "widget_opened",
  "quick_reply_click",
  "outbound_link_click",
];

// Fire-and-forget usage tracking from the widget (see events table in
// schema.sql) - no PII: session_id is a random id the widget generates
// itself, and event_data is capped/stringified below so it can only ever
// hold small, non-personal details like a button label or link URL.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (typeof b.clinicId !== "string" || !UUID_RE.test(b.clinicId)) {
    return NextResponse.json({ error: "`clinicId` must be a valid UUID" }, { status: 400 });
  }
  if (typeof b.sessionId !== "string" || !UUID_RE.test(b.sessionId)) {
    return NextResponse.json({ error: "`sessionId` must be a valid UUID" }, { status: 400 });
  }
  if (typeof b.eventType !== "string" || !EVENT_TYPES.includes(b.eventType as EventType)) {
    return NextResponse.json({ error: "Invalid `eventType`" }, { status: 400 });
  }

  const eventData =
    typeof b.eventData === "object" && b.eventData !== null
      ? (b.eventData as Record<string, unknown>)
      : {};
  // Cap the payload size - this only ever needs to hold a short label/URL,
  // never enough to smuggle in a full message or large blob.
  if (JSON.stringify(eventData).length > 1000) {
    return NextResponse.json({ error: "`eventData` is too large" }, { status: 400 });
  }

  await insertEvent(b.clinicId, b.sessionId, b.eventType as EventType, eventData);

  return NextResponse.json({ ok: true });
}
