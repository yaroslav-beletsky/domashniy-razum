package bridge

// station-llm fork: стенд для проб озвучки (без колонки и без голоса владельца).
//
// Файл tts.cases в рабочем каталоге моста: по одному JSON-объекту на строку, например
//
//	{"id":"plain","text":"Привет, как дела?"}
//	{"id":"ssml-break","text":"<speak>Привет<break time=\"500ms\"/>как дела</speak>","voice":"ermil"}
//	{"id":"pcm","text":"Привет","format":"audio/x-pcm;bit=16;rate=16000"}
//
// Поля: id, text, voice (по умолчанию ermil), emotion, quality, format, lang, tag, speed, volume.
// Мост забирает файл (переименовывает в tts.cases.taken, чтобы не запускать дважды), шлёт серверу
// TtsGenerate по кейсу на каждую строку, глушит аудио и пишет в service.log строку tts_case_result:
// outcome=ok|exception|timeout, exception (текст), audio_bytes, audio_frames, first_ms, total_ms.
// С форматом PCM 16 кГц длительность = audio_bytes / 32000 с.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	header "github.com/freequasar/quasar-go-genproto/proto/alice/protos/api/alicekit/events/common/event_header"
	tts "github.com/freequasar/quasar-go-genproto/proto/alice/protos/api/alicekit/events/tts_generate"
	client "github.com/freequasar/quasar-go-genproto/proto/alice/protos/api/alicekit/protocol/client"

	"quasarbridge/internal/wire"
)

var ttsCasesPath = "tts.cases"

type ttsCase struct {
	ID      string   `json:"id"`
	Text    string   `json:"text"`
	Voice   string   `json:"voice"`
	Emotion string   `json:"emotion"`
	Quality string   `json:"quality"`
	Format  string   `json:"format"`
	Lang    string   `json:"lang"`
	Tag     string   `json:"tag"`
	Speed   *float64 `json:"speed"`
	Volume  *float64 `json:"volume"`
	Dump    bool     `json:"dump"`
}

// ttsProbe копит результат одного пробного запроса озвучки.
type ttsProbe struct {
	mu        sync.Mutex
	started   time.Time
	firstAt   time.Time
	bytes     int
	frames    int
	pcm       []byte
	exception string
	closed    bool
	done      chan struct{}
	once      sync.Once
}

func newTtsProbe() *ttsProbe { return &ttsProbe{started: time.Now(), done: make(chan struct{})} }

func (t *ttsProbe) speak() {
	t.mu.Lock()
	if t.firstAt.IsZero() {
		t.firstAt = time.Now()
	}
	t.mu.Unlock()
}

func (t *ttsProbe) audio(b []byte) {
	t.mu.Lock()
	t.bytes += len(b)
	t.frames++
	if len(t.pcm)+len(b) <= 4<<20 {
		t.pcm = append(t.pcm, b...)
	}
	t.mu.Unlock()
}

func (t *ttsProbe) fail(msg string) {
	t.mu.Lock()
	t.exception = msg
	t.mu.Unlock()
	t.once.Do(func() { close(t.done) })
}

func (t *ttsProbe) close() {
	t.mu.Lock()
	t.closed = true
	t.mu.Unlock()
	t.once.Do(func() { close(t.done) })
}

func parseTtsCases(data []byte) []ttsCase {
	var out []ttsCase
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), 64*1024)
	for sc.Scan() && len(out) < 40 {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var c ttsCase
		if err := json.Unmarshal([]byte(line), &c); err != nil || c.Text == "" {
			continue
		}
		if c.ID == "" {
			c.ID = "case"
		}
		out = append(out, c)
	}
	return out
}

func (c ttsCase) generate() *tts.TTtsGenerate {
	g := &tts.TTtsGenerate{Text: new(c.Text), Lang: new("ru-RU"), Format: new("audio/opus")}
	voice := c.Voice
	if voice == "" {
		voice = "ermil"
	}
	g.Voice = new(voice)
	if c.Lang != "" {
		g.Lang = new(c.Lang)
	}
	if c.Format != "" {
		g.Format = new(c.Format)
	}
	if c.Emotion != "" {
		g.Emotion = new(c.Emotion)
	}
	if c.Quality != "" {
		g.Quality = new(c.Quality)
	}
	if c.Tag != "" {
		g.Tag = new(c.Tag)
	}
	g.Speed = c.Speed
	g.Volume = c.Volume
	return g
}

// runTtsCases вызывается раз в пару секунд; работает, только если файл tts.cases существует.
func (n *Native) runTtsCases() {
	st, err := os.Stat(ttsCasesPath)
	if err != nil || st.Size() == 0 || st.Size() > 64*1024 {
		return
	}
	taken := ttsCasesPath + ".taken"
	if err := os.Rename(ttsCasesPath, taken); err != nil {
		return // забрал другой экземпляр
	}
	data, err := os.ReadFile(taken)
	if err != nil {
		return
	}
	cases := parseTtsCases(data)
	slog.Info("tts_cases_start", "count", len(cases))
	for _, c := range cases {
		select {
		case <-n.ctx.Done():
			return
		default:
		}
		n.runTtsCase(c)
		select {
		case <-time.After(600 * time.Millisecond):
		case <-n.ctx.Done():
			return
		}
	}
	slog.Info("tts_cases_done", "count", len(cases))
}

func (n *Native) runTtsCase(c ttsCase) {
	g := c.generate()
	id := newID()
	probe := newTtsProbe()
	p := &nativeRequest{id: id, ttsID: id, canceled: true, probe: probe}
	n.mu.Lock()
	n.tts[id] = p
	n.mu.Unlock()
	defer func() {
		time.AfterFunc(30*time.Second, func() {
			n.mu.Lock()
			delete(n.tts, id)
			for s, q := range n.streams {
				if q == p {
					delete(n.streams, s)
				}
			}
			n.mu.Unlock()
		})
	}()
	t := &client.TClientMessage{Message: &client.TClientMessage_Event{Event: &client.TClientMessage_TEvent{Header: &header.TEventHeader{MessageId: id}, Event: &client.TClientMessage_TEvent_TtsGenerate{TtsGenerate: g}}}}
	b, err := (wire.Frame{Client: t, Prefix: []byte("AAPI")}).Marshal()
	if err == nil {
		err = n.up(n.ctx, websocket.MessageBinary, b)
	}
	if err != nil {
		slog.Warn("tts_case_result", "id", c.ID, "outcome", "send_failed")
		return
	}
	outcome := "ok"
	select {
	case <-probe.done:
		// после закрытия потока даём досыпаться хвосту
		time.Sleep(150 * time.Millisecond)
	case <-time.After(10 * time.Second):
		outcome = "timeout"
	case <-n.ctx.Done():
		return
	}
	probe.mu.Lock()
	defer probe.mu.Unlock()
	if probe.exception != "" {
		outcome = "exception"
	}
	firstMs := int64(-1)
	if !probe.firstAt.IsZero() {
		firstMs = probe.firstAt.Sub(probe.started).Milliseconds()
	}
	if c.Dump && len(probe.pcm) > 0 {
		if err := os.MkdirAll("tts-dump", 0o700); err == nil {
			_ = os.WriteFile("tts-dump/"+safeName(c.ID)+".pcm", probe.pcm, 0o600)
		}
	}
	text := c.Text
	if r := []rune(text); len(r) > 90 {
		text = string(r[:90]) + "…"
	}
	slog.Info("tts_case_result", "id", c.ID, "outcome", outcome, "exception", probe.exception,
		"audio_bytes", probe.bytes, "audio_frames", probe.frames, "first_ms", firstMs,
		"total_ms", time.Since(probe.started).Milliseconds(),
		"voice", g.GetVoice(), "emotion", g.GetEmotion(), "quality", g.GetQuality(), "format", g.GetFormat(),
		"speed", g.GetSpeed(), "volume", g.GetVolume(), "text_len", len([]rune(c.Text)), "text", text)
}

func safeName(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return "case"
	}
	return string(out)
}
