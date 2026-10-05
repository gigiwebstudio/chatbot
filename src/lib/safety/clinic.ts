import type { ClinicContact } from "@/lib/supabase";
import type { SafetyPack, SupportedLanguage } from "./types";

// Hard, deterministic emergency gate - runs before any embedding/LLM call.
// Per CLAUDE.md: "증상/응급 관련 키워드는 LLM 호출 전에 필터링해서 무조건
// 직원 연결(escalation)로 라우팅". Scoped to true emergencies only (not
// general symptom questions like "허리 아픈데 어떤 서비스 있나요?"), which
// stay on the normal RAG+LLM path where the system prompt already forbids
// diagnosis/treatment claims - a keyword gate that broad would block most
// legitimate FAQ questions.
//
// Keyword matching (not an LLM classifier) is deliberate: it's fast, free,
// and its behavior is fully auditable - important for a safety-critical gate.
// Plain strings are matched as case-insensitive substrings - fine for
// compound terms with no insertion risk ("chest pain", "심장마비", "中风").
// RegExp entries are for multi-concept phrases where natural speech can
// insert a particle or adverb between the words: Korean postpositions
// (가/이/은/는/을/를) and Chinese degree adverbs (很/非常/太) both do this -
// e.g. "숨쉬기가 너무 힘들어요" does NOT contain the literal substring
// "숨쉬기 힘들" (found via user testing: that exact phrasing silently failed
// to escalate). `.{0,N}` gives a small tolerance gap instead of requiring
// adjacency. English phrases are kept as plain strings since English
// doesn't insert words mid-compound the same way.
const EMERGENCY_PATTERNS: (string | RegExp)[] = [
  // English
  "chest pain",
  "can't breathe",
  "cannot breathe",
  "can't catch my breath",
  "cannot catch my breath",
  "difficulty breathing",
  "trouble breathing",
  "hard to breathe",
  "struggling to breathe",
  "short of breath",
  "heart attack",
  "stroke",
  "paralyzed",
  "paralysis",
  "unconscious",
  "passed out",
  "seizure",
  "convulsion",
  "severe bleeding",
  "won't stop bleeding",
  "bleeding a lot",
  "allergic reaction",
  "anaphylaxis",
  "throat closing",
  "suicidal",
  "kill myself",
  "want to die",
  "self-harm",
  "self harm",
  "911",
  "ambulance",
  "emergency room",
  // Korean
  /가슴.{0,6}(아프|아파|통증|답답)/,
  /숨(을|이|쉬기)?.{0,8}(못\s?쉬|힘들|곤란|막혀|차올라)/,
  /호흡.{0,8}곤란/,
  /심장.{0,2}마비/,
  "뇌졸중",
  "뇌경색",
  /(몸|얼굴|팔|다리|손|발).{0,6}마비/,
  /마비.{0,4}(왔|됐|온)/,
  /의식.{0,6}(잃|없)/,
  "기절",
  "발작",
  "경련",
  /피.{0,6}(멈추지\s?않|많이)/,
  /출혈.{0,4}(심|많)/,
  /알레르기.{0,6}반응/,
  "아나필락시스",
  /목.{0,6}부어/,
  /자살.{0,6}(하고\s?싶|충동|생각)/,
  /자해.{0,6}(하고\s?싶|충동)/,
  /죽고\s?싶/,
  "응급실",
  "구급차",
  "119",
  // Chinese (Simplified & Traditional) - same insertion risk from degree
  // adverbs (很/非常/太), e.g. "呼吸很困难" doesn't contain "呼吸困难".
  /胸口?.{0,4}痛/,
  /呼吸.{0,4}困[难難]/,
  /喘.{0,2}不.{0,2}过气/,
  /喘.{0,2}不.{0,2}過氣/,
  "心脏病发作",
  "心臟病發作",
  "中风",
  "中風",
  "瘫痪",
  "癱瘓",
  "失去知觉",
  "失去知覺",
  "昏迷",
  "晕倒",
  "暈倒",
  "抽搐",
  "痉挛",
  "痙攣",
  /大.{0,2}出血/,
  "流血不止",
  /过敏.{0,2}反应/,
  /過敏.{0,2}反應/,
  "过敏性休克",
  "過敏性休克",
  /喉咙.{0,4}肿/,
  /喉嚨.{0,4}腫/,
  "自杀",
  "自殺",
  "想死",
  "自残",
  "自殘",
  "急诊室",
  "急診室",
  "救护车",
  "救護車",
];

function detectEscalation(message: string): boolean {
  const normalized = message.toLowerCase();
  return EMERGENCY_PATTERNS.some((pattern) =>
    typeof pattern === "string" ? normalized.includes(pattern.toLowerCase()) : pattern.test(message)
  );
}

const EMERGENCY_LINES: Record<SupportedLanguage, string[]> = {
  en: [
    "⚠️ This may be a medical emergency.",
    "",
    "Please call 911 or go to the nearest emergency room immediately.",
    "",
    "I'm a chatbot and can't help with emergencies.",
  ],
  ko: [
    "⚠️ 이것은 응급 상황일 수 있습니다.",
    "",
    "즉시 911에 전화하시거나 가까운 응급실로 가주세요.",
    "",
    "저는 챗봇이라 응급 상황을 도와드릴 수 없습니다.",
  ],
  zh: [
    "⚠️ 这可能是紧急医疗情况。",
    "",
    "请立即拨打911或前往最近的急诊室。",
    "",
    "我是聊天机器人,无法处理紧急情况。",
  ],
};

const CONTACT_LABEL: Record<SupportedLanguage, (name: string) => string> = {
  en: (name) => `Contact ${name}:`,
  ko: (name) => `${name} 문의:`,
  zh: (name) => `联系${name}:`,
};

function buildEscalationResponse(
  clinic: ClinicContact | null,
  language: SupportedLanguage = "en"
): string {
  const contactLines: string[] = [];
  if (clinic?.phone) contactLines.push(`📞 ${clinic.phone}`);
  if (clinic?.email) contactLines.push(`📧 ${clinic.email}`);
  const name = clinic?.name ?? { en: "the clinic", ko: "클리닉", zh: "诊所" }[language];

  return [...EMERGENCY_LINES[language], "", CONTACT_LABEL[language](name), ...contactLines].join(
    "\n"
  );
}

export const clinicSafetyPack: SafetyPack = {
  detectEscalation,
  buildEscalationResponse,
};
