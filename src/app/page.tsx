"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import ChatWidget from "@/components/ChatWidget";

// Falls back to the Joayo Therapy demo (NEXT_PUBLIC_DEMO_CLINIC_ID) when no
// query params are given, so the link already shared with Joayo keeps
// working unchanged - but passing ?clinicId=...&clinicName=... shows a
// *different* clinic's demo at the same root URL, so onboarding a second
// client never risks repointing the first client's saved demo link. One
// Vercel deployment, every clinic's demo distinguished only by this param -
// same mechanism the real embed (public/embed.js) already uses.
const DEFAULT_CLINIC_ID = process.env.NEXT_PUBLIC_DEMO_CLINIC_ID;
const DEFAULT_CLINIC_NAME = "Joayo Therapy";

function HomeInner() {
  const searchParams = useSearchParams();
  const clinicId = searchParams.get("clinicId") ?? DEFAULT_CLINIC_ID;
  const clinicName = searchParams.get("clinicName") ?? DEFAULT_CLINIC_NAME;
  const vertical = searchParams.get("vertical") ?? undefined;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 font-sans">
      <h1 className="text-center text-2xl font-semibold text-zinc-900">
        AI Assistant Widget Demo
      </h1>
      <p className="mt-2 max-w-md text-center text-sm text-zinc-500">
        오른쪽 아래 채팅 버튼을 눌러 테스트해보세요. 이 페이지는 위젯 동작
        확인용 데모이며, 실제 서비스는 API를 임베드해서 사용합니다.
      </p>

      {clinicId ? (
        <ChatWidget clinicId={clinicId} clinicName={clinicName} vertical={vertical} />
      ) : (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-800">
          NEXT_PUBLIC_DEMO_CLINIC_ID가 .env.local에 설정되어 있지 않습니다.
        </p>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}
