"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import ChatWidget from "@/components/ChatWidget";

// This page renders nothing but the widget itself - it's meant to be loaded
// inside the iframe that public/embed.js creates on a client's own site, not
// visited directly. The root layout's body has an opaque background (fine
// for the demo page at "/"), which would show as a solid box behind the
// widget here, so override it to transparent for this page only.
function TransparentBackground() {
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  return null;
}

function WidgetPageInner() {
  const searchParams = useSearchParams();
  const clinicId = searchParams.get("clinicId");
  const clinicName = searchParams.get("clinicName") ?? undefined;
  const vertical = searchParams.get("vertical") ?? undefined;

  if (!clinicId) {
    return (
      <p style={{ fontFamily: "sans-serif", fontSize: 12, color: "#991b1b", padding: 8 }}>
        Missing clinicId - check the embed snippet&apos;s data-clinic-id attribute.
      </p>
    );
  }

  return <ChatWidget clinicId={clinicId} clinicName={clinicName} vertical={vertical} />;
}

export default function WidgetPage() {
  return (
    <>
      <TransparentBackground />
      <Suspense fallback={null}>
        <WidgetPageInner />
      </Suspense>
    </>
  );
}
