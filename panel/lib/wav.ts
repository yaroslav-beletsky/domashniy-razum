// Утилиты WAV: разбор загруженного файла и сборка ответа (PCM16 mono).

export interface ParsedWav {
  pcm: Buffer;
  rate: number;
  channels: number;
  width: number;
}

/** Разбирает несжатый PCM WAV. Возвращает null, если формат не поддерживается. */
export function parseWav(buf: Buffer): ParsedWav | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let pos = 12;
  let fmt: { channels: number; rate: number; bits: number } | null = null;
  let data: { offset: number; length: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      const audioFormat = buf.readUInt16LE(body);
      if (audioFormat !== 1) return null; // только PCM
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = { offset: body, length: Math.min(size, buf.length - body) };
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data || data.length <= 0) return null;
  if (fmt.bits !== 16) return null; // только PCM16
  if (fmt.channels !== 1) return null; // приводим к mono на клиенте
  if (fmt.rate < 8000 || fmt.rate > 48000) return null;
  return { pcm: Buffer.from(buf.subarray(data.offset, data.offset + data.length)), rate: fmt.rate, channels: 1, width: 2 };
}

/** Заголовок WAV для PCM16. */
export function buildWav(pcm: Buffer, rate: number, channels = 1, width = 2): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * width), 28); // byte rate
  header.writeUInt16LE(channels * width, 32); // block align
  header.writeUInt16LE(width * 8, 34); // bits
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
