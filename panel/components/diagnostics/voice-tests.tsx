"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, MessageSquareText, Mic, Play, Send, Square, Volume2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface VoiceStatus {
  online: boolean;
  ms?: number;
  baseUrl?: string;
  sttEngine?: string;
  sttModel?: string;
  ttsEngine?: string;
  ttsVoice?: string;
  belchReachable?: boolean;
  error?: string;
}

interface SttResult {
  ok: boolean;
  ms: number;
  text?: string;
  language?: string;
  confidence?: number;
  error?: string;
}

interface AskResult {
  ok: boolean;
  ms: number;
  replyWav?: string;
  replyText?: string;
  sttText?: string;
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
  error?: string;
}

interface TtsResult {
  ok: boolean;
  ms: number;
  wav?: string;
  bytes?: number;
  error?: string;
}

function writeStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** Аудио из файла или микрофона → WAV PCM16 mono 16 кГц. */
async function toWav16k(buf: ArrayBuffer): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const rate = 16000;
    const length = Math.max(1, Math.ceil(decoded.duration * rate));
    const off = new OfflineAudioContext(1, length, rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    const ch = rendered.getChannelData(0);
    const out = new ArrayBuffer(44 + ch.length * 2);
    const view = new DataView(out);
    writeStr(view, 0, "RIFF");
    view.setUint32(4, 36 + ch.length * 2, true);
    writeStr(view, 8, "WAVE");
    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, "data");
    view.setUint32(40, ch.length * 2, true);
    let o = 44;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return new Blob([out], { type: "audio/wav" });
  } finally {
    void ctx.close();
  }
}

export function VoiceTests() {
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [sttBusy, setSttBusy] = useState(false);
  const [stt, setStt] = useState<SttResult | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsText, setTtsText] = useState("Привет! Проверка синтеза речи.");
  const [tts, setTts] = useState<TtsResult | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        setVoice(j.voice);
      }
    } catch {
      /* offline штатно */
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 10000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const runStt = async (blob: Blob) => {
    setSttBusy(true);
    setStt(null);
    try {
      const fd = new FormData();
      fd.append("file", blob, "voice.wav");
      const r = await fetch("/api/voice/stt", { method: "POST", body: fd });
      setStt(await r.json());
    } catch (e) {
      setStt({ ok: false, ms: 0, error: e instanceof Error ? e.message : "ошибка сети" });
    } finally {
      setSttBusy(false);
    }
  };

  const runAsk = async (blob: Blob) => {
    setAskBusy(true);
    setAsk(null);
    try {
      const fd = new FormData();
      fd.append("file", blob, "voice.wav");
      const r = await fetch("/api/voice/ask", { method: "POST", body: fd });
      setAsk(await r.json());
    } catch (e) {
      setAsk({ ok: false, ms: 0, error: e instanceof Error ? e.message : "ошибка сети" });
    } finally {
      setAskBusy(false);
    }
  };

  const runTts = async () => {
    setTtsBusy(true);
    setTts(null);
    try {
      const r = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ttsText }),
      });
      setTts(await r.json());
    } catch (e) {
      setTts({ ok: false, ms: 0, error: e instanceof Error ? e.message : "ошибка сети" });
    } finally {
      setTtsBusy(false);
    }
  };

  const onFile = async (fn: (blob: Blob) => Promise<void>) => {
    const file = fileRef.current?.files?.[0];
    if (!file) return false;
    const wav = await toWav16k(await file.arrayBuffer());
    await fn(wav);
    return true;
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimer.current) clearInterval(recTimer.current);
        setRecording(false);
        setRecSec(0);
        try {
          const wav = await toWav16k(await new Blob(chunks).arrayBuffer());
          await runAsk(wav);
        } catch (e) {
          setAsk({ ok: false, ms: 0, error: e instanceof Error ? e.message : "ошибка кодирования" });
        }
      };
      mr.start();
      setRecording(true);
      const started = Date.now();
      recTimer.current = setInterval(() => setRecSec(Math.floor((Date.now() - started) / 1000)), 500);
      recRef.current = { stop: () => mr.stop() };
    } catch (e) {
      setAsk({ ok: false, ms: 0, error: `микрофон недоступен: ${e instanceof Error ? e.message : "denied"}` });
    }
  };

  const online = Boolean(voice?.online);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
            <Mic className="size-3.5" /> Голосовая цепочка
            <Badge
              variant="outline"
              className={cn(
                "ml-auto h-6 gap-1.5 font-mono text-[11px] font-normal sm:h-5",
                voice === null ? "" : online ? "border-emerald-900 text-emerald-400" : "border-red-900 text-red-400",
              )}
            >
              <span className={cn("inline-block size-1.5 rounded-full", voice === null ? "bg-zinc-600" : online ? "bg-emerald-400" : "bg-red-400")} />
              {voice === null ? "…" : online ? `online ${voice.ms ?? 0} мс` : "offline"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 font-mono text-[11px] text-zinc-500">
          {online ? (
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span>STT: <span className="text-zinc-300">{voice?.sttEngine ?? "?"} / {voice?.sttModel ?? "?"}</span></span>
              <span>TTS: <span className="text-zinc-300">{voice?.ttsEngine ?? "?"} / {voice?.ttsVoice ?? "?"}</span></span>
              <span>belch: <span className={voice?.belchReachable ? "text-emerald-400" : "text-amber-400"}>{voice?.belchReachable ? "reachable" : "unreachable"}</span></span>
            </div>
          ) : (
            <span>{voice?.error ?? "нет связи"} — тесты ниже заработают, когда цепочка поднимется.</span>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
              <Play className="size-3.5" /> STT: аудио → текст
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-4 pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,.wav"
                className="min-h-11 w-full font-mono text-xs text-zinc-400 file:mr-3 file:h-11 file:rounded file:border-0 file:bg-zinc-800 file:px-3 file:font-mono file:text-xs file:text-zinc-300 hover:file:bg-zinc-700 sm:file:h-8"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-11 shrink-0 gap-1.5 px-3 font-mono text-xs sm:h-8"
                disabled={sttBusy || !online}
                onClick={async () => {
                  if (!(await onFile(runStt))) setStt({ ok: false, ms: 0, error: "сначала выберите аудиофайл" });
                }}
              >
                <Send className="size-3" /> {sttBusy ? "слушаю…" : "распознать"}
              </Button>
            </div>
            {stt && !stt.ok && (
              <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 font-mono text-xs text-red-400">{stt.error}</div>
            )}
            {stt?.ok && (
              <div className="flex flex-col gap-1 rounded border border-zinc-800 p-2 font-mono text-xs">
                <div className="flex flex-wrap gap-x-4 text-zinc-500">
                  <span className="text-emerald-400">{stt.ms} мс</span>
                  {stt.language && <span>язык: {stt.language}</span>}
                  {stt.confidence !== undefined && stt.confidence >= 0 && <span>уверенность: {stt.confidence.toFixed(2)}</span>}
                </div>
                <div className={cn("whitespace-pre-wrap", stt.text ? "text-zinc-200" : "text-amber-500")}>
                  {stt.text || "(пустой результат — не расслышала)"}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
              <MessageSquareText className="size-3.5" /> Полный круг: микрофон → ответ
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-4 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className={cn("h-11 sm:h-9 gap-1.5 px-3 font-mono text-xs", recording && "border-red-900 text-red-400")}
                disabled={askBusy || !online || recording}
                onClick={startRec}
              >
                <Mic className="size-3" /> записать вопрос
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-9 gap-1.5 px-3 font-mono text-xs"
                disabled={!recording}
                onClick={() => recRef.current?.stop()}
              >
                <Square className="size-3" /> стоп
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-9 gap-1.5 px-3 font-mono text-xs"
                disabled={askBusy || !online}
                onClick={async () => {
                  if (!(await onFile(runAsk))) setAsk({ ok: false, ms: 0, error: "сначала выберите аудиофайл (или запишите с микрофона)" });
                }}
              >
                <Send className="size-3" /> {askBusy ? "думаю…" : "файл → круг"}
              </Button>
              {recording && <span className="font-mono text-xs text-red-400">● {recSec} с</span>}
            </div>
            <p className="font-mono text-[10px] text-zinc-600">
              запись → STT (gigaam) → LLM (LiteLLM) → TTS (piper) → аудио; длинные ответы обрезайте промптом у моста
            </p>
            {ask && !ask.ok && (
              <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 font-mono text-xs text-red-400">
                {ask.error}
                {ask.sttText && <div className="mt-1 text-zinc-500">распознано: «{ask.sttText}»</div>}
              </div>
            )}
            {ask?.ok && (
              <div className="flex flex-col gap-2 rounded border border-zinc-800 p-2 font-mono text-xs">
                <div className="flex flex-wrap gap-x-4 text-zinc-500">
                  <span className="text-emerald-400">{ask.ms} мс</span>
                  {ask.sttMs !== undefined && <span>STT {ask.sttMs} мс</span>}
                  {ask.llmMs !== undefined && <span>LLM {ask.llmMs} мс</span>}
                  {ask.ttsMs !== undefined && <span>TTS {ask.ttsMs} мс</span>}
                </div>
                {ask.sttText && <div className="text-zinc-500">вы: <span className="text-zinc-300">«{ask.sttText}»</span></div>}
                {ask.replyText && <div className="text-zinc-500">ответ: <span className="text-zinc-200">{ask.replyText}</span></div>}
                {ask.replyWav ? (
                  <audio controls autoPlay className="h-11 w-full sm:h-8" src={`data:audio/wav;base64,${ask.replyWav}`} />
                ) : (
                  <span className="text-amber-500">аудио-ответ пуст{ask.replyText ? ` — текст: ${ask.replyText}` : ""}</span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
              <Volume2 className="size-3.5" /> TTS: текст → аудио
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-4 pb-3">
            <Label htmlFor="tts-text" className="font-mono text-[11px] text-zinc-500">
              текст для синтеза (≤2000 симв.)
            </Label>
            <Textarea id="tts-text" value={ttsText} onChange={(e) => setTtsText(e.target.value)} className="min-h-20 font-mono text-xs" />
            <Button size="sm" variant="outline" className="h-11 w-fit gap-1.5 px-3 font-mono text-xs sm:h-8" disabled={ttsBusy || !online} onClick={runTts}>
              <Send className="size-3" /> {ttsBusy ? "синтез…" : "озвучить"}
            </Button>
            {tts && !tts.ok && (
              <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 font-mono text-xs text-red-400">{tts.error}</div>
            )}
            {tts?.ok && tts.wav && (
              <div className="flex flex-col gap-2 rounded border border-zinc-800 p-2 font-mono text-xs">
                <span className="text-emerald-400">{tts.ms} мс · {tts.bytes ?? 0} байт</span>
                <audio controls autoPlay className="h-11 w-full sm:h-8" src={`data:audio/wav;base64,${tts.wav}`} />
              </div>
            )}
            {!online && voice?.error && (
              <Alert>
                <CircleAlert className="size-4" />
                <AlertTitle>Голосовая цепочка offline</AlertTitle>
                <AlertDescription className="font-mono text-[11px]">{voice.error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
