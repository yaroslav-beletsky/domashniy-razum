package bridge

import (
	"os"
	"path/filepath"
	"testing"
)

// station-llm fork: QUASAR_TTS_VOICE → TtsGenerate.Voice; пусто = как в upstream.
func TestNewTtsGenerateVoice(t *testing.T) {
	t.Setenv("QUASAR_TTS_VOICE", "")
	old := ttsOverridePath
	ttsOverridePath = filepath.Join(t.TempDir(), "absent")
	defer func() { ttsOverridePath = old }()
	g := newTtsGenerate("привет")
	if g.Voice != nil || g.GetLang() != "ru-RU" || g.GetFormat() != "audio/opus" || g.GetText() != "привет" {
		t.Fatalf("default changed: %v", g)
	}
	t.Setenv("QUASAR_TTS_VOICE", "  filipp ")
	g = newTtsGenerate("привет")
	if g.GetVoice() != "filipp" || g.GetLang() != "ru-RU" || g.GetFormat() != "audio/opus" {
		t.Fatalf("voice not applied: %v", g)
	}
}

// tts.override перекрывает окружение и читается на каждый запрос.
func TestTtsOverride(t *testing.T) {
	t.Setenv("QUASAR_TTS_VOICE", "filipp")
	old := ttsOverridePath
	ttsOverridePath = filepath.Join(t.TempDir(), "tts.override")
	defer func() { ttsOverridePath = old }()
	if err := os.WriteFile(ttsOverridePath, []byte("voice=alena\nemotion=good\nspeed=1.1\nquality=ultra\nbogus=1\nlang=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	g := newTtsGenerate("x")
	if g.GetVoice() != "alena" || g.GetEmotion() != "good" || g.GetSpeed() != 1.1 || g.GetQuality() != "ultra" || g.GetLang() != "ru-RU" || g.GetFormat() != "audio/opus" {
		t.Fatalf("override: %v", g)
	}
	if err := os.WriteFile(ttsOverridePath, []byte("emotion=evil\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	g = newTtsGenerate("x")
	if g.GetVoice() != "filipp" || g.GetEmotion() != "evil" {
		t.Fatalf("override second read: %v", g)
	}
}

// probe=… в tts.override: список кандидатов, максимум 12, пустые пропускаются.
func TestReadProbeList(t *testing.T) {
	p := filepath.Join(t.TempDir(), "tts.override")
	if got := readProbeList(p); got != nil {
		t.Fatalf("absent file: %v", got)
	}
	if err := os.WriteFile(p, []byte("voice=alena\nprobe= ermil, zahar@good ,,filipp\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := readProbeList(p)
	if len(got) != 3 || got[0] != "ermil" || got[1] != "zahar@good" || got[2] != "filipp" {
		t.Fatalf("probe list: %v", got)
	}
}

// tts.cases: JSON-строки, комментарии и мусор пропускаются, дефолтный голос ermil.
func TestParseTtsCases(t *testing.T) {
	in := "# коммент\n{\"id\":\"a\",\"text\":\"привет\"}\nне json\n{\"id\":\"b\",\"text\":\"x\",\"voice\":\"zahar\",\"speed\":1.2,\"emotion\":\"good\",\"format\":\"audio/x-pcm;bit=16;rate=16000\"}\n{\"id\":\"c\"}\n"
	cs := parseTtsCases([]byte(in))
	if len(cs) != 2 {
		t.Fatalf("cases: %v", cs)
	}
	a, b := cs[0].generate(), cs[1].generate()
	if a.GetVoice() != "ermil" || a.GetFormat() != "audio/opus" || a.GetLang() != "ru-RU" || a.Speed != nil {
		t.Fatalf("a: %v", a)
	}
	if b.GetVoice() != "zahar" || b.GetSpeed() != 1.2 || b.GetEmotion() != "good" || b.GetFormat() != "audio/x-pcm;bit=16;rate=16000" {
		t.Fatalf("b: %v", b)
	}
}

// Тег стиля [tts …] вырезается, значения ограничиваются; без тега текст не меняется.
func TestSplitTtsStyle(t *testing.T) {
	txt, st := splitTtsStyle("[tts emotion=good speed=9 volume=0.1] Привет!")
	if txt != "Привет!" || st == nil || st.emotion != "good" || *st.speed != 1.6 || *st.volume != 0.3 {
		t.Fatalf("got %q %+v", txt, st)
	}
	txt, st = splitTtsStyle("[tts emotion=zzz]Привет")
	if txt != "Привет" || st == nil || st.emotion != "" {
		t.Fatalf("bad emotion: %q %+v", txt, st)
	}
	txt, st = splitTtsStyle("Привет [tts emotion=good]")
	if st != nil || txt != "Привет [tts emotion=good]" {
		t.Fatalf("mid tag: %q %+v", txt, st)
	}
	g := newTtsGenerate("x")
	(*ttsStyle)(nil).apply(g)
	_, st = splitTtsStyle("[tts emotion=evil speed=1.2]a")
	st.apply(g)
	if g.GetEmotion() != "evil" || g.GetSpeed() != 1.2 {
		t.Fatalf("apply: %v", g)
	}
}

func TestCleanSpeech(t *testing.T) {
	cases := map[string]string{
		"Привет, Ярослав.":                                     "Привет, Ярослав.",
		`<speak>Раз<break time="500ms"/>два</speak>`:           "Раз sil<[500]> два",
		`Раз<break time="1s"/>два`:                             "Раз sil<[1000]> два",
		"**Привет**, `код` [ссылка](http://x.y)":               "Привет, код ссылка",
		"- пункт\n- ещё":                                       "пункт\nещё",
		"Раз sil<800> два":                                     "Раз sil<[800]> два",
		"В двери висит з+амок":                                 "В двери висит з+амок",
		"a < b и c > d":                                        "a < b и c > d",
		"<speak><prosody rate=\"slow\">Тихо</prosody></speak>": "Тихо",
	}
	for in, want := range cases {
		if got := cleanSpeech(in); got != want {
			t.Errorf("cleanSpeech(%q) = %q, want %q", in, got, want)
		}
	}
}
