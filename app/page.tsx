'use client';

import { useState, useEffect, useRef } from 'react';
import { TargetLevel, BikinPahamPayload, SummaryTopic, FlashcardItem, QuizQuestion } from '@/types/payload';
import Logo from '@/components/Logo';
import { Upload, BookOpen, Layers, HelpCircle, CheckCircle, XCircle, Sparkles, X, Send, Bot, User } from 'lucide-react';

type TabType = 'summary' | 'flashcards' | 'quiz' | 'tutor';

const LEVEL_CONFIG: Record<TargetLevel, { label: string; color: string; emoji: string }> = {
  SD_SMP:    { label: 'SD / SMP',   color: 'bg-[#86EFAC]', emoji: '🎒' },
  SMA_SMK:   { label: 'SMA / SMK',  color: 'bg-[#7DD3FC]', emoji: '📐' },
  MAHASISWA: { label: 'Mahasiswa',  color: 'bg-[#C084FC]', emoji: '🎓' },
};

const CARD_COLORS = ['bg-[#C084FC]', 'bg-[#7DD3FC]', 'bg-[#86EFAC]', 'bg-[#FBCFE8]', 'bg-[#FFE600]'];

const LOADING_STEPS = [
  "📄 Membaca & mengekstrak dokumen...",
  "🧠 Menganalisis konsep utama materi...",
  "📝 Menyusun modul rangkuman...",
  "🃏 Ngeracik flashcard interaktif...",
  "🎯 Bikin soal kuis & simulasi ujian...",
  "✨ Menyiapkan AI Socratic Tutor...",
];

export default function Home() {
  const [targetLevel, setTargetLevel] = useState<TargetLevel>('SMA_SMK');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [payload, setPayload] = useState<BikinPahamPayload | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('summary');

  // Flashcard state
  const [currentCardIdx, setCurrentCardIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);

  // Quiz state
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  // Chat state
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Loading step state
  const [loadingStep, setLoadingStep] = useState(0);
  useEffect(() => {
    if (!loading) { setLoadingStep(0); return; }
    const id = setInterval(() => {
      setLoadingStep(prev => (prev + 1) % LOADING_STEPS.length);
    }, 1800);
    return () => clearInterval(id);
  }, [loading]);

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || chatLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setChatLoading(true);

    try {
      const summaryContext = payload
        ? payload.summary_module
            .map(t => `${t.topic}: ${t.key_points.join('; ')}`)
            .join(' | ')
        : '';

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, { role: 'user', content: userMessage }],
          summaryContext,
          target_level: targetLevel,
        }),
      });

      if (!response.ok) throw new Error('Chat API error');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = '';

      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          assistantMessage += chunk;
          setMessages(prev => {
            const next = [...prev];
            next[next.length - 1] = { role: 'assistant', content: assistantMessage };
            return next;
          });
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Maaf, terjadi kesalahan. Coba lagi.' }]);
    } finally {
      setChatLoading(false);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected && (
      selected.type === 'application/pdf' ||
      selected.type.startsWith('image/') ||
      selected.name.toLowerCase().endsWith('.ppt') ||
      selected.name.toLowerCase().endsWith('.pptx') ||
      selected.type === 'application/vnd.ms-powerpoint' ||
      selected.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )) {
      setFile(selected);
    } else {
      alert('Upload file PDF, PPTX, atau gambar.');
    }
  };

  const handleIngest = async () => {
    if (!file) { alert('Pilih file terlebih dahulu.'); return; }
    setLoading(true);
    setIngestError(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('target_level', targetLevel);
    try {
      const res = await fetch('/api/ingest', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setPayload(data.payload);
      setFromCache(data.cached === true);
      setActiveTab('summary');
      setCurrentCardIdx(0);
      setFlipped(false);
      setQuizAnswers({});
      setQuizSubmitted(false);
      setFromCache(false);
    } catch (error) {
      console.error(error);
      setIngestError(error instanceof Error ? error.message : 'Gagal memproses dokumen.');
    } finally {
      setLoading(false);
    }
  };

  const handleQuizAnswer = (qId: number, opt: string) => {
    if (quizSubmitted) return;
    setQuizAnswers(prev => ({ ...prev, [qId]: opt }));
  };

  const score = payload
    ? payload.quiz_exam.filter(q => quizAnswers[q.id] === q.correct_answer).length
    : 0;

  const tabs: { id: TabType; label: string; emoji: string }[] = [
    { id: 'summary',    label: 'Rangkuman',  emoji: '📚' },
    { id: 'flashcards', label: 'Flashcards', emoji: '📇' },
    { id: 'quiz',       label: 'Kuis',       emoji: '🧠' },
    { id: 'tutor',      label: 'AI Tutor',   emoji: '🤖' },
  ];

  return (
    <div className="min-h-screen bg-[#FAF8F5] p-4 md:p-8">

      {/* ── HEADER ── */}
      <header className="max-w-5xl mx-auto mb-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          {/* Logo */}
          <Logo />

          {/* Level Pills */}
          <div className="flex gap-2 flex-wrap">
            {(Object.entries(LEVEL_CONFIG) as [TargetLevel, typeof LEVEL_CONFIG[TargetLevel]][]).map(([level, cfg]) => (
              <button
                key={level}
                onClick={() => setTargetLevel(level)}
                className={`px-4 py-2 rounded-xl border-2 border-black font-bold text-sm transition-all
                  ${targetLevel === level
                    ? `${cfg.color} shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] -translate-x-0.5 -translate-y-0.5`
                    : 'bg-white hover:bg-gray-50 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]'
                  }`}
              >
                {cfg.emoji} {cfg.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-gray-600 mt-3 font-medium">
          Unggah materi → dapat rangkuman, flashcards, kuis, dan tutor Socratic sesuai level {LEVEL_CONFIG[targetLevel].label}.
        </p>
      </header>

      <main className="max-w-5xl mx-auto space-y-6">

        {/* ── UPLOAD CARD ── */}
        <section className="bg-white border-2 border-black rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
          <h2 className="text-xl font-black text-black mb-4 flex items-center gap-2">
            <Upload size={20} /> Unggah Materi
          </h2>

          {/* Dropzone */}
          <label className="block border-2 border-dashed border-black bg-[#FAF8F5] rounded-2xl p-8 text-center cursor-pointer hover:bg-[#FFF9E6] transition-colors">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.txt,.ppt,.pptx"
              onChange={handleFileChange}
              className="sr-only"
            />
            <div className="text-4xl mb-2">📄</div>
            <p className="font-bold text-black">Klik untuk pilih file</p>
            <p className="text-sm text-gray-500 mt-1">PDF, PPTX, atau Gambar (PNG, JPG)</p>
          </label>

          {/* Selected file */}
          {file && (
            <div className="mt-4 flex items-center justify-between bg-white border-2 border-black rounded-xl px-4 py-3 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
              <div className="flex items-center gap-3">
                {/* File type badge */}
                {(() => {
                  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
                  const badgeMap: Record<string, string> = {
                    pdf:  'bg-[#FECDD3]',
                    ppt:  'bg-[#FDBA74]',
                    pptx: 'bg-[#FDBA74]',
                    png:  'bg-[#7DD3FC]',
                    jpg:  'bg-[#7DD3FC]',
                    jpeg: 'bg-[#7DD3FC]',
                  };
                  const cls = badgeMap[ext] ?? 'bg-[#E5E7EB]';
                  return (
                    <span className={`${cls} border-2 border-black rounded-lg px-2 py-0.5 font-black text-xs uppercase shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] shrink-0`}>
                      {ext}
                    </span>
                  );
                })()}
                <div>
                  <p className="font-bold text-black text-sm">{file.name}</p>
                  <p className="text-xs text-gray-500">{Math.round(file.size / 1024)} KB</p>
                </div>
              </div>
              <button
                onClick={() => setFile(null)}
                className="bg-[#FECDD3] border-2 border-black rounded-lg p-1.5 hover:bg-red-300 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {/* Multi-step progress card */}
          {loading && (
            <div className="mt-5 bg-white border-2 border-black rounded-2xl p-5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
              <p className="font-black text-black text-sm mb-4">⏳ Sedang diproses oleh AI...</p>
              <div className="space-y-2">
                {LOADING_STEPS.map((step, idx) => {
                  const done    = idx < loadingStep;
                  const active  = idx === loadingStep;
                  return (
                    <div
                      key={idx}
                      className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border-2 transition-all duration-300
                        ${active  ? 'border-black bg-[#FFE600] shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] -translate-x-0.5 -translate-y-0.5' :
                          done    ? 'border-black bg-[#86EFAC]' :
                                    'border-gray-200 bg-[#FAF8F5] opacity-50'}`}
                    >
                      <span className="text-base leading-none">
                        {done ? '✅' : active ? '⚙️' : '⬜'}
                      </span>
                      <span className={`text-sm ${active ? 'font-black text-black' : done ? 'font-bold text-gray-700 line-through' : 'font-medium text-gray-400'}`}>
                        {step}
                      </span>
                      {active && (
                        <div className="ml-auto flex gap-1">
                          <span className="w-1.5 h-1.5 bg-black rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-black rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-black rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Error banner */}
          {ingestError && (
            <div className="mt-4 flex items-start gap-3 bg-[#FECDD3] border-2 border-black rounded-xl p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
              <span className="text-xl">❌</span>
              <div className="flex-1">
                <p className="font-black text-black text-sm">Gagal memproses dokumen</p>
                <p className="text-xs text-gray-700 mt-1 break-all">{ingestError}</p>
              </div>
              <button onClick={() => setIngestError(null)} className="text-gray-500 hover:text-black">
                <X size={16} />
              </button>
            </div>
          )}
          <button
            onClick={handleIngest}
            disabled={loading || !file}
            className="mt-5 w-full bg-[#FFE600] hover:bg-[#FACC15] text-black font-black text-lg py-3 px-8 border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-x-1 active:translate-y-1 active:shadow-none transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-black shrink-0" />
                <span className="truncate">{LOADING_STEPS[loadingStep]}</span>
              </>
            ) : (
              <><Sparkles size={20} /> Proses Materi</>
            )}
          </button>
        </section>

        {/* ── WORKSPACE (post-ingest) ── */}
        {payload && (
          <section className="bg-white border-2 border-black rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-hidden">

            {/* Cache badge */}
            {fromCache && (
              <div className="flex items-center gap-2 px-5 py-3 border-b-2 border-black bg-[#86EFAC]">
                <span className="text-lg">⚡</span>
                <span className="font-black text-black text-sm">Dimuat dari Cache (0 Token digunakan!)</span>
              </div>
            )}

            {/* Tab Bar */}
            <div className="flex border-b-2 border-black overflow-x-auto">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-5 py-4 font-black text-sm whitespace-nowrap border-r-2 border-black transition-all
                    ${activeTab === tab.id
                      ? 'bg-[#FFE600] text-black'
                      : 'bg-white text-gray-600 hover:bg-[#FAF8F5]'
                    }`}
                >
                  <span>{tab.emoji}</span> {tab.label}
                </button>
              ))}
            </div>

            <div className="p-6">

              {/* ── TAB 1: RANGKUMAN ── */}
              {activeTab === 'summary' && (
                <div>
                  <h3 className="text-2xl font-black text-black mb-2">📚 Modul Rangkuman</h3>
                  <p className="text-gray-600 font-medium mb-6">{payload.document_meta.title}</p>
                  <div className="grid md:grid-cols-2 gap-5">
                    {payload.summary_module.map((topic: SummaryTopic, idx) => (
                      <div
                        key={idx}
                        className="bg-white border-2 border-black rounded-2xl overflow-hidden shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] transition-all"
                      >
                        <div className={`${CARD_COLORS[idx % CARD_COLORS.length]} border-b-2 border-black px-5 py-3`}>
                          <h4 className="font-black text-black">{topic.topic}</h4>
                        </div>
                        <div className="p-5">
                          <ul className="space-y-2 mb-4">
                            {topic.key_points.map((point, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <span className="mt-1 w-3 h-3 bg-black rounded-sm shrink-0" />
                                <span className="text-gray-800 text-sm">{point}</span>
                              </li>
                            ))}
                          </ul>
                          <div className="bg-[#FAF8F5] border-2 border-black rounded-xl p-3 text-sm text-gray-700">
                            {topic.explanation}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── TAB 2: FLASHCARDS ── */}
              {activeTab === 'flashcards' && (
                <div>
                  <h3 className="text-2xl font-black text-black mb-6">📇 Flashcards</h3>

                  {payload.flashcards.length > 0 && (() => {
                    const card: FlashcardItem = payload.flashcards[currentCardIdx];
                    return (
                      <div className="flex flex-col items-center gap-6">
                        {/* Progress */}
                        <p className="text-sm font-bold text-gray-500">
                          Kartu {currentCardIdx + 1} / {payload.flashcards.length}
                        </p>

                        {/* Flip card */}
                        <div
                          className="w-full max-w-xl h-64 cursor-pointer [perspective:1000px]"
                          onClick={() => setFlipped(f => !f)}
                        >
                          <div className={`relative w-full h-full transition-all duration-500 [transform-style:preserve-3d] ${flipped ? '[transform:rotateY(180deg)]' : ''}`}>
                            {/* Front */}
                            <div className="absolute inset-0 bg-white border-2 border-black rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col items-center justify-center p-8 [backface-visibility:hidden]">
                              <div className="text-4xl mb-4">❓</div>
                              <p className="text-xl font-black text-black text-center">{card.front}</p>
                              <p className="text-xs font-bold text-gray-400 mt-6 uppercase tracking-widest">Klik untuk Membalik</p>
                            </div>
                            {/* Back */}
                            <div className="absolute inset-0 bg-[#86EFAC] border-2 border-black rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col items-center justify-center p-8 [backface-visibility:hidden] [transform:rotateY(180deg)]">
                              <div className="text-4xl mb-4">💡</div>
                              <p className="text-xl font-black text-black text-center">{card.back}</p>
                              <p className="text-xs font-bold text-gray-600 mt-6 uppercase tracking-widest">Klik untuk Membalik</p>
                            </div>
                          </div>
                        </div>

                        {/* Navigation */}
                        <div className="flex gap-3">
                          <button
                            onClick={() => { setCurrentCardIdx(i => Math.max(0, i - 1)); setFlipped(false); }}
                            disabled={currentCardIdx === 0}
                            className="px-5 py-2 bg-white border-2 border-black rounded-xl font-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-30"
                          >
                            ← Prev
                          </button>
                          <button
                            onClick={() => { setCurrentCardIdx(i => Math.min(payload.flashcards.length - 1, i + 1)); setFlipped(false); }}
                            disabled={currentCardIdx === payload.flashcards.length - 1}
                            className="px-5 py-2 bg-[#FFE600] border-2 border-black rounded-xl font-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-30"
                          >
                            Next →
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* ── TAB 3: KUIS ── */}
              {activeTab === 'quiz' && (
                <div>
                  <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
                    <h3 className="text-2xl font-black text-black">🧠 Kuis & Ujian</h3>
                    {/* Score badge */}
                    {quizSubmitted && (
                      <div className="bg-[#FFE600] border-2 border-black rounded-xl px-5 py-2 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
                        <span className="font-black text-black text-lg">
                          Skor: {score} / {payload.quiz_exam.length}
                          {score === payload.quiz_exam.length ? ' 🎉' : score >= payload.quiz_exam.length / 2 ? ' 👍' : ' 💪'}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-6">
                    {payload.quiz_exam.map((q: QuizQuestion) => {
                      const userAnswer = quizAnswers[q.id];
                      return (
                        <div key={q.id} className="border-2 border-black rounded-2xl overflow-hidden shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                          <div className="bg-[#FAF8F5] border-b-2 border-black px-5 py-3">
                            <h4 className="font-black text-black">{q.id}. {q.question}</h4>
                          </div>
                          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
                            {q.options.map((opt, idx) => {
                              let optStyle = 'bg-white hover:bg-[#FAF8F5] border-2 border-black';
                              if (quizSubmitted) {
                                if (opt === q.correct_answer) optStyle = 'bg-[#86EFAC] border-2 border-black';
                                else if (userAnswer === opt) optStyle = 'bg-[#FECDD3] border-2 border-black';
                                else optStyle = 'bg-white border-2 border-gray-300 opacity-60';
                              } else if (userAnswer === opt) {
                                optStyle = 'bg-[#7DD3FC] border-2 border-black';
                              }
                              return (
                                <label
                                  key={idx}
                                  className={`flex items-center gap-3 p-4 rounded-xl cursor-pointer transition-all shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ${optStyle}`}
                                >
                                  <input
                                    type="radio"
                                    name={`q${q.id}`}
                                    value={opt}
                                    checked={userAnswer === opt}
                                    onChange={() => handleQuizAnswer(q.id, opt)}
                                    disabled={quizSubmitted}
                                    className="h-4 w-4 accent-black"
                                  />
                                  <span className="flex-1 font-medium text-sm">{opt}</span>
                                  {quizSubmitted && opt === q.correct_answer && <CheckCircle size={18} className="text-green-700 shrink-0" />}
                                  {quizSubmitted && userAnswer === opt && userAnswer !== q.correct_answer && <XCircle size={18} className="text-red-600 shrink-0" />}
                                </label>
                              );
                            })}
                          </div>
                          {quizSubmitted && (
                            <div className="mx-5 mb-5 bg-[#7DD3FC] border-2 border-black rounded-xl p-4">
                              <p className="font-black text-black text-sm mb-1">💬 Penjelasan:</p>
                              <p className="text-sm text-gray-800">{q.explanation}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex gap-3 mt-8 flex-wrap">
                    <button
                      onClick={() => setQuizSubmitted(true)}
                      disabled={quizSubmitted || Object.keys(quizAnswers).length !== payload.quiz_exam.length}
                      className="px-6 py-3 bg-[#86EFAC] border-2 border-black rounded-xl font-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      ✅ Submit Jawaban
                    </button>
                    <button
                      onClick={() => { setQuizAnswers({}); setQuizSubmitted(false); }}
                      className="px-6 py-3 bg-white border-2 border-black rounded-xl font-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none transition-all"
                    >
                      🔄 Reset Kuis
                    </button>
                  </div>

                  {!quizSubmitted && (
                    <p className="mt-4 text-sm font-medium text-gray-500">
                      Terjawab {Object.keys(quizAnswers).length} dari {payload.quiz_exam.length} soal.
                    </p>
                  )}
                </div>
              )}

              {/* ── TAB 4: TUTOR ── */}
              {activeTab === 'tutor' && (
                <div>
                  <h3 className="text-2xl font-black text-black mb-4">🤖 Socratic AI Tutor</h3>
                  <div className="border-2 border-black rounded-2xl overflow-hidden shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col h-[500px]">

                    {/* Messages */}
                    <div className="flex-1 p-4 overflow-y-auto bg-[#FAF8F5] space-y-4 flex flex-col">
                      {messages.length === 0 && (
                        <div className="flex-1 flex flex-col items-center justify-center text-center">
                          <div className="text-5xl mb-3">🦉</div>
                          <p className="font-black text-black text-lg">Halo! Saya Tutor Socratic.</p>
                          <p className="text-gray-500 text-sm mt-1 max-w-xs">
                            Saya tidak memberi jawaban langsung — saya bantu kamu berpikir sendiri. Tanya sesuatu!
                          </p>
                        </div>
                      )}
                      {messages.map((m, idx) => (
                        <div
                          key={idx}
                          className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                        >
                          {/* Avatar */}
                          <div className={`w-9 h-9 rounded-xl border-2 border-black flex items-center justify-center shrink-0 font-black text-sm shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ${m.role === 'user' ? 'bg-[#FFE600]' : 'bg-[#C084FC]'}`}>
                            {m.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                          </div>
                          {/* Bubble */}
                          <div className={`max-w-[75%] border-2 border-black rounded-2xl p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] ${m.role === 'user' ? 'bg-[#FFE600]' : 'bg-white'}`}>
                            <p className="text-xs font-black text-gray-600 mb-1">{m.role === 'user' ? 'Kamu' : 'Tutor Socrates'}</p>
                            <p className="text-sm whitespace-pre-wrap text-black">{m.content}</p>
                          </div>
                        </div>
                      ))}
                      {chatLoading && (
                        <div className="flex gap-3 flex-row">
                          <div className="w-9 h-9 rounded-xl border-2 border-black bg-[#C084FC] flex items-center justify-center shrink-0 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
                            <Bot size={16} />
                          </div>
                          <div className="bg-white border-2 border-black rounded-2xl p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] flex items-center gap-1.5">
                            <span className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                          </div>
                        </div>
                      )}
                      <div ref={messagesEndRef} />
                    </div>

                    {/* Input */}
                    <form onSubmit={handleChatSubmit} className="border-t-2 border-black p-4 bg-white flex gap-3">
                      <input
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        placeholder="Tanya tentang materi ini..."
                        className="flex-1 border-2 border-black rounded-xl px-4 py-2.5 font-medium text-sm focus:outline-none focus:bg-[#FFF9E6] bg-[#FAF8F5] transition-colors"
                      />
                      <button
                        type="submit"
                        disabled={chatLoading || !input.trim()}
                        className="bg-[#FFE600] border-2 border-black rounded-xl px-5 py-2.5 font-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        <Send size={16} /> Kirim
                      </button>
                    </form>
                  </div>
                  <p className="text-xs text-gray-500 font-medium mt-3">
                    💡 Tutor membimbing dengan pertanyaan, bukan jawaban langsung.
                  </p>
                </div>
              )}

            </div>
          </section>
        )}
      </main>

      <footer className="max-w-5xl mx-auto mt-10 text-center">
        <div className="inline-flex items-center gap-2 bg-white border-2 border-black rounded-2xl px-6 py-3 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] text-sm font-medium text-gray-600">
          <span>BikinPaham.ai</span>
          <span className="text-gray-300">|</span>
          <span>Powered by Gemini + Groq Llama 3</span>
        </div>
      </footer>
    </div>
  );
}
