"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";

interface ChatWidgetProps {
  clinicId: string;
  clinicName?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  escalate?: boolean;
}

// Shown once, before the first message - guided quick replies reduce
// blank-input drop-off and convert better than an empty text box alone.
// Free text stays available the whole time; these are just a head start.
const QUICK_REPLIES = [
  {
    label: "🤕 Not sure what I need",
    message: "I'm not sure which service I need - can you help me figure out what to book?",
  },
  { label: "📅 Book an appointment", message: "How do I book an appointment?" },
  { label: "🕒 Hours & location", message: "What are your hours and where are you located?" },
  { label: "💳 Insurance & billing", message: "Do you offer direct billing or accept ICBC claims?" },
];

// Tailwind styling for markdown elements rendered inside a small chat bubble -
// tight spacing, no default browser margins/font sizes.
const markdownComponents = {
  p: (props: React.ComponentPropsWithoutRef<"p">) => (
    <p className="mb-2 last:mb-0" {...props} />
  ),
  ul: (props: React.ComponentPropsWithoutRef<"ul">) => (
    <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0" {...props} />
  ),
  ol: (props: React.ComponentPropsWithoutRef<"ol">) => (
    <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0" {...props} />
  ),
  strong: (props: React.ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold" {...props} />
  ),
  h1: (props: React.ComponentPropsWithoutRef<"h1">) => (
    <h3 className="mb-1 mt-2 font-semibold first:mt-0" {...props} />
  ),
  h2: (props: React.ComponentPropsWithoutRef<"h2">) => (
    <h3 className="mb-1 mt-2 font-semibold first:mt-0" {...props} />
  ),
  h3: (props: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 className="mb-1 mt-2 font-semibold first:mt-0" {...props} />
  ),
  a: (props: React.ComponentPropsWithoutRef<"a">) => (
    <a className="underline" target="_blank" rel="noopener noreferrer" {...props} />
  ),
};

export default function ChatWidget({
  clinicId,
  clinicName = "Support",
}: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  // When embedded via public/embed.js, this widget renders inside an iframe
  // that's just big enough to hold it - the host page itself can't see past
  // the iframe's edges. Tell the loader script how much room we need so it
  // can grow/shrink the iframe instead of always reserving the full open
  // panel's space (which would block clicks on the host page around the
  // closed button).
  useEffect(() => {
    if (window.parent === window) return; // not embedded in an iframe
    window.parent.postMessage(
      { source: "clinic-chat-widget", type: "resize", open },
      "*"
    );
  }, [open]);

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    setError(null);
    setInput("");
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, message: text, history }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "The request failed.");
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply, escalate: data.escalate },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // Full reset, not "show the quick replies again below the old messages" -
  // one unambiguous meaning ("start over") instead of leaving it unclear
  // whether history is kept.
  function resetConversation() {
    setMessages([]);
    setInput("");
    setError(null);
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3 font-sans">
      {open && (
        <div className="flex h-[520px] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white text-neutral-900 shadow-2xl scheme-light">
          <div className="flex items-center justify-between bg-neutral-900 px-4 py-3 text-white">
            <span className="font-medium">{clinicName} AI Assistant</span>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={resetConversation}
                  aria-label="Start over"
                  title="Start over"
                  className="rounded p-1 text-white/80 hover:bg-white/10 hover:text-white"
                >
                  ↺
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                aria-label="Close chat"
                className="rounded p-1 text-white/80 hover:bg-white/10 hover:text-white"
              >
                ✕
              </button>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
          >
            {messages.length === 0 && (
              <div>
                <p className="text-sm text-neutral-500">Hi! How can we help?</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {QUICK_REPLIES.map((qr) => (
                    <button
                      key={qr.label}
                      onClick={() => sendMessage(qr.message)}
                      disabled={loading}
                      className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-left text-xs font-medium text-neutral-700 transition hover:border-black/20 hover:bg-neutral-50 disabled:opacity-40"
                    >
                      {qr.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-left text-sm ${
                    m.role === "user"
                      ? "whitespace-pre-wrap bg-neutral-900 text-white"
                      : m.escalate
                        ? "border border-red-300 bg-red-50 text-red-900"
                        : "bg-neutral-100 text-neutral-900"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <Markdown
                      remarkPlugins={[remarkBreaks]}
                      components={markdownComponents}
                    >
                      {m.content}
                    </Markdown>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl bg-neutral-100 px-3 py-2.5">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" />
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-end gap-2 border-t border-black/10 p-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Type in English, 한국어, or 中文..."
              // 16px (text-base) is the iOS Safari/WebKit threshold below
              // which focusing an input auto-zooms the page - this stays at
              // or above that regardless of the rest of the UI's text size.
              className="max-h-24 flex-1 resize-none rounded-xl border border-black/10 bg-white px-3 py-2 text-base text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-400"
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="rounded-xl bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close chat" : "Open chat"}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-2xl text-white shadow-xl transition hover:scale-105"
      >
        {open ? "✕" : "💬"}
      </button>
    </div>
  );
}
