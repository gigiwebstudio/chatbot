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

// Matches the panel-exit animation's duration in globals.css - how long
// closeChat() keeps the panel mounted so the exit animation can finish
// before it's actually removed.
const PANEL_EXIT_MS = 220;

// Shown once, before the first message - guided quick replies reduce
// blank-input drop-off and convert better than an empty text box alone.
// Free text stays available the whole time; these are just a head start.
const QUICK_REPLIES = [
  { label: "🩺 Our services", message: "What services do you offer?" },
  { label: "📅 Book appointment", message: "How do I book an appointment?" },
  { label: "🕒 Hours & location", message: "What are your hours and where are you located?" },
  { label: "💳 Insurance & billing", message: "Do you offer direct billing or accept ICBC claims?" },
  {
    label: "🤕 Not sure what I need",
    message: "I'm not sure which service I need - can you help me figure out what to book?",
  },
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
  // True only during the close animation - the panel stays mounted (and
  // `open` stays true) for its duration, then closeChat() flips `open` to
  // actually unmount it once the exit animation has had time to finish.
  const [closing, setClosing] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks the in-flight /api/chat request so "start over" can cancel it
  // instead of letting a stale reply land after the conversation's moved on.
  const abortControllerRef = useRef<AbortController | null>(null);
  // Created lazily on first send (a user gesture) rather than on mount, so
  // the browser's autoplay policy doesn't silently block it - reused across
  // the whole conversation instead of a new context per message.
  const audioCtxRef = useRef<AudioContext | null>(null);

  // A short two-tone "ding" for incoming replies, synthesized instead of
  // shipping an audio file - two quick sine tones a few semitones apart
  // reads as a pleasant notification chime rather than a harsh beep.
  function playNotificationSound() {
    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") void ctx.resume();

      const now = ctx.currentTime;
      [880, 1175].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = now + i * 0.09;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.15, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.2);
      });
    } catch {
      // Not critical to the chat working - skip silently if the browser
      // blocks or doesn't support Web Audio.
    }
  }

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

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, message: text, history }),
        signal: controller.signal,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "The request failed.");
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply, escalate: data.escalate },
      ]);
      playNotificationSound();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Cancelled by resetConversation() - the conversation already moved
        // on, so there's nothing to show for this request.
        return;
      }
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
  // whether history is kept. Cancels any in-flight reply so it can't land
  // after the reset and get appended to the (now empty) conversation.
  function resetConversation() {
    abortControllerRef.current?.abort();
    setMessages([]);
    setInput("");
    setError(null);
    setLoading(false);
  }

  // Keeps the panel mounted (and playing the panel-exit CSS animation, see
  // globals.css) for PANEL_EXIT_MS before actually unmounting it - without
  // this, {open && <panel/>} would unmount instantly and there'd be nothing
  // left on screen for a close animation to play against.
  function closeChat() {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, PANEL_EXIT_MS);
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3 font-sans">
      {open && (
        // Full-screen below the sm breakpoint (closed via the header X, not
        // a separate "mobile mode") - a floating 420x760 card above it,
        // same as before, just bigger.
        <div
          className={`fixed inset-0 z-50 flex h-full w-full flex-col overflow-hidden border-0 bg-white text-neutral-900 shadow-none scheme-light sm:static sm:inset-auto sm:h-190 sm:max-h-[calc(100vh-2rem)] sm:w-105 sm:max-w-[calc(100vw-2rem)] sm:animate-none sm:rounded-2xl sm:border sm:border-black/10 sm:shadow-2xl ${
            closing
              ? "animate-[panel-exit_220ms_ease-in_forwards]"
              : "animate-[panel-enter_220ms_ease-out]"
          }`}
        >
          <div className="flex items-center justify-between bg-neutral-900 px-4 py-3 text-white">
            <span className="font-medium">{clinicName} AI Assistant</span>
            {/* Fixed-size flex-centered boxes, not just padding around a
                character - different glyphs (↺ vs ✕) have different font
                metrics, so centering via text baseline left them visibly
                misaligned with each other even at identical padding. */}
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={resetConversation}
                  aria-label="Start over"
                  title="Start over"
                  className="flex h-8 w-8 items-center justify-center rounded text-xl leading-none text-white/80 hover:bg-white/10 hover:text-white"
                >
                  ↺
                </button>
              )}
              <button
                onClick={closeChat}
                aria-label="Close chat"
                className="flex h-8 w-8 items-center justify-center rounded text-xl leading-none text-white/80 hover:bg-white/10 hover:text-white"
              >
                ✕
              </button>
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
          >
            {/* Always visible, not just before the first message - the
                patient can tap another option any time without needing
                "start over" first, and the conversation just continues
                below instead of replacing this with a blank thread. */}
            <div className="flex justify-start">
              {/* Greeting + quick replies as one bubble, same width as a
                  real assistant message (not full-width) - reads as the
                  bot talking and offering options, not a separate menu
                  bolted on below it. */}
              {/* w-full (not just max-w) - the other bubbles only look
                  85% wide because their text is long enough to wrap at
                  that cap; this one's content (short button labels) never
                  needs that much space, so without w-full it just shrinks
                  to fit instead of matching their width. */}
              <div className="w-full max-w-[85%] rounded-2xl bg-neutral-100 p-3 text-sm text-neutral-900">
                <div className="px-2 py-2 font-medium">Hi! How can we help?</div>
                {/* Each reply is its own white card inside the grey bubble,
                    not a row separated by a divider line - color contrast
                    against the bubble reads as "button" on its own,
                    without needing a shared background with the greeting. */}
                <div className="mt-1 flex flex-col gap-1.5">
                  {QUICK_REPLIES.map((qr) => (
                    <button
                      key={qr.label}
                      onClick={() => sendMessage(qr.message)}
                      disabled={loading}
                      className="flex items-center justify-between gap-2 rounded-xl border border-black/10 bg-white px-4 py-3 text-left font-medium text-neutral-700 transition hover:border-black/20 hover:bg-neutral-50 disabled:opacity-40"
                    >
                      <span>{qr.label}</span>
                      <span aria-hidden className="text-neutral-300">
                        ›
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-left text-sm ${
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
                <div className="flex items-center gap-1.5 rounded-2xl bg-neutral-100 px-4 py-4">
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 animate-[bouncy-dot_0.8s_ease-in-out_-0.32s_infinite]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 animate-[bouncy-dot_0.8s_ease-in-out_-0.16s_infinite]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 animate-[bouncy-dot_0.8s_ease-in-out_0s_infinite]" />
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-black/10 p-3">
            {/* items-center, not items-end - with a single-line textarea,
                items-end aligned the (taller, fixed-height) round send
                button to the textarea's bottom, which pushed it above the
                text instead of centering against it. */}
            <div className="flex items-center gap-2 rounded-2xl border border-black/10 bg-white py-2 pl-4 pr-1.5 focus-within:border-neutral-400">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder="Type in English, 한국어, or 中文..."
                // 16px (text-base) is the iOS Safari/WebKit threshold below
                // which focusing an input auto-zooms the page - stay at that
                // on narrow (phone) viewports, but match the rest of the UI's
                // 14px on desktop where auto-zoom doesn't happen.
                className="max-h-24 flex-1 resize-none bg-transparent py-1 text-base text-neutral-900 outline-none placeholder:text-neutral-400 sm:text-sm"
              />
              <button
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
                aria-label="Send message"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white disabled:opacity-40"
              >
                <span aria-hidden className="text-base leading-none">↑</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => (open ? closeChat() : setOpen(true))}
        aria-label={open ? "Close chat" : "Open chat"}
        // On mobile, the open panel is full-screen and covers this button
        // anyway (closing happens via the header X instead) - hide it
        // outright rather than leaving a redundant control floating on top.
        className={`${open ? "hidden sm:flex" : "flex"} h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-2xl text-white shadow-xl transition hover:scale-105`}
      >
        {open ? "✕" : "💬"}
      </button>
    </div>
  );
}
