const VOICE_SUFFIX =
  "\n\nФормат ответа: отвечай коротко, 2–3 фразы, без markdown — голосовой ответ.";

export function voiceSystemPrompt(base: string): string {
  return `${base.trim()}${VOICE_SUFFIX}`;
}

/** Strip thinking blocks, markdown artifacts; trim to ~maxChars at a sentence boundary. */
export function voiceClean(input: string, maxChars = 600): string {
  let t = input.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");
  t = t.replace(/(\*|_)([^*_]+)\1/g, "$2");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, "");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.trim();

  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const m = /^(.*[.!?…])\s+/s.exec(cut);
  const trimmed = m ? m[1] : cut.slice(0, cut.lastIndexOf(" "));
  return (trimmed.length > maxChars * 0.5 ? trimmed : cut) + "…";
}
