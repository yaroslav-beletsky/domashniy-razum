package bridge

// station-llm fork: выразительная озвучка ответа модели.
//
// 1. Тег стиля в начале ответа (его пишет агент/модель, мост вырезает до показа и озвучки):
//
//	[tts emotion=good speed=1.15] Привет, Ярослав!
//
// Ключи: emotion (neutral|good|evil), speed (0.6..1.6), volume (0.3..2.0).
// Тег перекрывает глобальные значения из tts.override только для этого ответа.
//
// 2. Подготовка текста к синтезу (сервер SSML не понимает и читает теги вслух):
//   - <break time="500ms"/> → sil<[500]> (паузу сервер понимает только в такой записи);
//   - остальные XML-теги вырезаются, markdown (**, _, `, #, ссылки) чистится;
//   - «плюс» перед гласной (з+амок) и sil<[мс]> остаются как есть.

import (
	"regexp"
	"strconv"
	"strings"

	tts "github.com/freequasar/quasar-go-genproto/proto/alice/protos/api/alicekit/events/tts_generate"
)

type ttsStyle struct {
	emotion string
	speed   *float64
	volume  *float64
}

var (
	styleTagRe = regexp.MustCompile(`^\s*\[tts\s+([^\]]{0,120})\]\s*`)
	breakRe    = regexp.MustCompile(`(?i)<break\s+time\s*=\s*"?(\d+(?:\.\d+)?)\s*(ms|s)?"?\s*/?>`)
	xmlTagRe   = regexp.MustCompile(`</?[A-Za-z][^<>]{0,200}>`)
	linkRe     = regexp.MustCompile(`\[([^\]]+)\]\((?:[^)\s]+)\)`)
	mdMarkRe   = regexp.MustCompile("[*`]+|__+|~~")
	mdLineRe   = regexp.MustCompile(`(?m)^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+)`)
	spacesRe   = regexp.MustCompile(`[ \t]{2,}`)
	silPlainRe = regexp.MustCompile(`(?i)\bsil<(\d{1,4})>`)
)

// splitTtsStyle вырезает ведущий тег [tts …] и возвращает чистый текст и стиль (nil, если тега нет).
func splitTtsStyle(text string) (string, *ttsStyle) {
	m := styleTagRe.FindStringSubmatchIndex(text)
	if m == nil {
		return text, nil
	}
	st := &ttsStyle{}
	for _, kv := range strings.Fields(text[m[2]:m[3]]) {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch strings.ToLower(k) {
		case "emotion":
			switch v = strings.ToLower(v); v {
			case "neutral", "good", "evil":
				st.emotion = v
			}
		case "speed":
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				f = clampF(f, 0.6, 1.6)
				st.speed = &f
			}
		case "volume":
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				f = clampF(f, 0.3, 2.0)
				st.volume = &f
			}
		}
	}
	return text[m[1]:], st
}

func clampF(f, lo, hi float64) float64 {
	if f < lo {
		return lo
	}
	if f > hi {
		return hi
	}
	return f
}

func (s *ttsStyle) apply(g *tts.TTtsGenerate) {
	if s == nil {
		return
	}
	if s.emotion != "" {
		g.Emotion = new(s.emotion)
	}
	if s.speed != nil {
		g.Speed = new(*s.speed)
	}
	if s.volume != nil {
		g.Volume = new(*s.volume)
	}
}

// cleanSpeech готовит текст ответа к синтезу; показываемый текст не меняется.
func cleanSpeech(text string) string {
	if !strings.ContainsAny(text, "<*`_#>~[-+") {
		return text
	}
	text = breakRe.ReplaceAllStringFunc(text, func(s string) string {
		m := breakRe.FindStringSubmatch(s)
		v, _ := strconv.ParseFloat(m[1], 64)
		if strings.EqualFold(m[2], "s") || (m[2] == "" && v < 20) {
			v *= 1000
		}
		return " sil<[" + strconv.Itoa(int(clampF(v, 100, 2000))) + "]> "
	})
	text = silPlainRe.ReplaceAllString(text, "sil<[$1]>")
	text = xmlTagRe.ReplaceAllString(text, "")
	text = linkRe.ReplaceAllString(text, "$1")
	text = mdLineRe.ReplaceAllString(text, "")
	text = mdMarkRe.ReplaceAllString(text, "")
	text = spacesRe.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}
