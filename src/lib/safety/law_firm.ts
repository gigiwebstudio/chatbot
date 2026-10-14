import type { ClinicContact } from "@/lib/supabase";
import type { SafetyPack, SupportedLanguage } from "./types";

// Hard, deterministic urgent-legal-situation gate - same rationale as
// src/lib/safety/clinic.ts (fast, free, auditable - important for a
// safety-critical gate). A "medical emergency" has no equivalent here;
// instead this catches situations that need an actual lawyer's attention
// right now (an arrest, an imminent court deadline, a notice with a
// response window) rather than general FAQ answers the normal RAG+LLM path
// already handles fine.
const URGENT_PATTERNS: (string | RegExp)[] = [
  // English - short keywords/regexes rather than long fixed phrases, since
  // natural speech inserts words mid-phrase ("I was just arrested" doesn't
  // contain the literal substring "I was arrested" - found via testing:
  // that exact phrasing silently failed to escalate). Same rationale as the
  // Korean/Chinese regex entries below and in src/lib/safety/clinic.ts.
  "arrested",
  "under arrest",
  "detained",
  "police custody",
  /police.{0,15}question/,
  /serv(ed|ing).{0,15}(papers|notice|lawsuit|subpoena|summons)/,
  "subpoena",
  "arrest warrant",
  "restraining order",
  /(court|hearing|trial).{0,20}tomorrow/,
  "being sued",
  "lawsuit against me",
  "eviction notice",
  "being evicted",
  /deadline.{0,15}today/,
  // Korean
  "체포됐",
  "체포당했",
  "구속됐",
  /경찰.{0,6}조사/,
  "소환장",
  "구속영장",
  "체포영장",
  /접근금지.{0,4}명령/,
  /내일.{0,4}(재판|법정|공판)/,
  /고소.{0,4}당했/,
  /소송.{0,4}당했/,
  "퇴거명령",
  "강제퇴거",
  /오늘.{0,4}마감/,
  // Chinese (Simplified & Traditional)
  "被捕",
  "被逮捕",
  "被拘留",
  "传票",
  "傳票",
  "逮捕令",
  /明天.{0,4}(开庭|開庭|庭审|庭審)/,
  "被起诉",
  "被起訴",
  "驱逐令",
  "驅逐令",
  /今天.{0,4}截止/,
];

function detectUrgent(message: string): boolean {
  const normalized = message.toLowerCase();
  return URGENT_PATTERNS.some((pattern) =>
    typeof pattern === "string" ? normalized.includes(pattern.toLowerCase()) : pattern.test(message)
  );
}

const URGENT_LINES: Record<SupportedLanguage, string[]> = {
  en: [
    "⚠️ This sounds like it needs a lawyer's attention right away, not a chat FAQ.",
    "",
    "Please contact the firm directly as soon as possible.",
    "",
    "I'm an AI assistant and can't advise on an active legal situation like this.",
  ],
  ko: [
    "⚠️ 이 내용은 지금 바로 변호사의 확인이 필요한 사안으로 보입니다.",
    "",
    "가능한 한 빨리 사무소로 직접 연락해주세요.",
    "",
    "저는 AI 어시스턴트라 진행 중인 법적 사안에 대해서는 자문드릴 수 없습니다.",
  ],
  zh: [
    "⚠️ 这件事听起来需要律师立即关注,而不是聊天FAQ能处理的。",
    "",
    "请尽快直接联系事务所。",
    "",
    "我是AI助手,无法就这类正在进行的法律事项提供建议。",
  ],
};

const CONTACT_LABEL: Record<SupportedLanguage, (name: string) => string> = {
  en: (name) => `Contact ${name}:`,
  ko: (name) => `${name} 문의:`,
  zh: (name) => `联系${name}:`,
};

function buildUrgentResponse(
  clinic: ClinicContact | null,
  language: SupportedLanguage = "en"
): string {
  const contactLines: string[] = [];
  if (clinic?.phone) contactLines.push(`📞 ${clinic.phone}`);
  if (clinic?.email) contactLines.push(`📧 ${clinic.email}`);
  const name = clinic?.name ?? { en: "the firm", ko: "사무소", zh: "事务所" }[language];

  return [...URGENT_LINES[language], "", CONTACT_LABEL[language](name), ...contactLines].join("\n");
}

export const lawFirmSafetyPack: SafetyPack = {
  detectEscalation: detectUrgent,
  buildEscalationResponse: buildUrgentResponse,
};
