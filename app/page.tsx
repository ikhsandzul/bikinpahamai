'use client';

import { useState, useEffect, useRef } from 'react';
import { TargetLevel, BikinPahamPayload, SummaryTopic, FlashcardItem, QuizQuestion } from '@/types/payload';
import { Upload, BookOpen, Layers, HelpCircle, CheckCircle, XCircle, Sparkles } from 'lucide-react';

type TabType = 'summary' | 'flashcards' | 'quiz' | 'tutor';

export default function Home() {
  const [targetLevel, setTargetLevel] = useState<TargetLevel>('SMA_SMK');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<BikinPahamPayload | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('summary');
  const [flippedCards, setFlippedCards] = useState<Record<number, boolean>>({});
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  // Chat state
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || chatLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setChatLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, { role: 'user', content: userMessage }],
          context: payload ? `Document: ${payload.document_meta.title}. Topics: ${payload.summary_module.map(s => s.topic).join(', ')}` : 'General learning',
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
            const newMessages = [...prev];
            newMessages[newMessages.length - 1] = { role: 'assistant', content: assistantMessage };
            return newMessages;
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

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected && (selected.type === 'application/pdf' || selected.type.startsWith('image/'))) {
      setFile(selected);
    } else {
      alert('Please upload a PDF or image file.');
    }
  };

  const handleIngest = async () => {
    if (!file) {
      alert('Please select a file first.');
      return;
    }

    setLoading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('target_level', targetLevel);

    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setPayload(data);
      setActiveTab('summary');
    } catch (error) {
      console.error(error);
      alert('Failed to process document. Check console for details.');
    } finally {
      setLoading(false);
    }
  };

  const toggleCardFlip = (id: number) => {
    setFlippedCards(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleQuizAnswer = (questionId: number, option: string) => {
    if (quizSubmitted) return;
    setQuizAnswers(prev => ({ ...prev, [questionId]: option }));
  };

  const submitQuiz = () => {
    setQuizSubmitted(true);
  };

  const resetQuiz = () => {
    setQuizAnswers({});
    setQuizSubmitted(false);
  };

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'summary', label: 'Modul Rangkuman', icon: <BookOpen size={18} /> },
    { id: 'flashcards', label: 'Flashcards', icon: <Layers size={18} /> },
    { id: 'quiz', label: 'Kuis & Ujian', icon: <HelpCircle size={18} /> },
    { id: 'tutor', label: 'Socratic AI Tutor', icon: <Sparkles size={18} /> },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 md:p-8">
      <header className="max-w-6xl mx-auto mb-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 flex items-center gap-2">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-purple-600">
                BikinPaham.ai
              </span>
              <span className="text-sm bg-blue-100 text-blue-800 px-3 py-1 rounded-full">AI‑Powered Study Ecosystem</span>
            </h1>
            <p className="text-gray-600 mt-2">Unggah materi, dapatkan rangkuman, flashcards, kuis, dan tutor Socratic.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['SD_SMP', 'SMA_SMK', 'MAHASISWA'] as TargetLevel[]).map(level => (
              <button
                key={level}
                onClick={() => setTargetLevel(level)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition ${targetLevel === level
                    ? 'bg-blue-600 text-white shadow'
                    : 'bg-white text-gray-700 hover:bg-gray-100'
                  }`}
              >
                {level.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto">
        {/* Upload Section */}
        <section className="bg-white rounded-2xl shadow-xl p-6 mb-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Upload size={20} /> Unggah Materi (PDF/Gambar)
          </h2>
          <div className="flex flex-col md:flex-row gap-4 items-start md:items-center">
            <div className="flex-1">
              <label className="block">
                <span className="sr-only">Choose file</span>
                <input
                  type="file"
                  accept=".pdf,image/*"
                  onChange={handleFileChange}
                  className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
              </label>
              {file && (
                <p className="mt-2 text-sm text-gray-700">
                  Selected: <strong>{file.name}</strong> ({Math.round(file.size / 1024)} KB)
                </p>
              )}
            </div>
            <button
              onClick={handleIngest}
              disabled={loading || !file}
              className="px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold rounded-full hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  Memproses...
                </>
              ) : (
                <>
                  <Sparkles size={18} /> Proses Materi
                </>
              )}
            </button>
          </div>
          <p className="text-sm text-gray-500 mt-4">
            Sistem akan mengekstrak konten, membuat rangkuman, flashcards, dan kuis sesuai tingkat {targetLevel.replace('_', ' ')}.
          </p>
        </section>

        {payload && (
          <section className="bg-white rounded-2xl shadow-xl p-6">
            {/* Tabs */}
            <div className="flex flex-wrap border-b border-gray-200 mb-6">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-5 py-3 font-medium rounded-t-lg transition ${activeTab === tab.id
                      ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-600'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                    }`}
                >
                  {tab.icon} {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="min-h-[400px]">
              {/* Summary Module */}
              {activeTab === 'summary' && (
                <div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-6">
                    📚 Modul Rangkuman: {payload.document_meta.title}
                  </h3>
                  <div className="grid md:grid-cols-2 gap-6">
                    {payload.summary_module.map((topic: SummaryTopic, idx) => (
                      <div key={idx} className="bg-blue-50 border border-blue-100 rounded-xl p-5">
                        <h4 className="text-lg font-semibold text-blue-900 mb-3">{topic.topic}</h4>
                        <ul className="space-y-2 mb-4">
                          {topic.key_points.map((point, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <div className="w-2 h-2 bg-blue-500 rounded-full mt-2"></div>
                              <span className="text-gray-800">{point}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-gray-700 text-sm bg-white p-3 rounded-lg">{topic.explanation}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Flashcards */}
              {activeTab === 'flashcards' && (
                <div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-6">📇 Flashcards Interaktif</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {payload.flashcards.map((card: FlashcardItem) => (
                      <div
                        key={card.id}
                        className="relative h-64 cursor-pointer [perspective:1000px]"
                        onClick={() => toggleCardFlip(card.id)}
                      >
                        <div className={`absolute inset-0 rounded-2xl shadow-lg transition-all duration-500 [transform-style:preserve-3d] ${flippedCards[card.id] ? '[transform:rotateY(180deg)]' : ''}`}>
                          {/* Front */}
                          <div className="absolute inset-0 bg-gradient-to-br from-white to-blue-50 border-2 border-blue-200 rounded-2xl p-6 flex flex-col justify-center items-center [backface-visibility:hidden]">
                            <div className="text-4xl mb-4">❓</div>
                            <p className="text-lg font-semibold text-center text-gray-900">{card.front}</p>
                            <p className="text-sm text-gray-500 mt-4">Click to flip</p>
                          </div>
                          {/* Back */}
                          <div className="absolute inset-0 bg-gradient-to-br from-green-50 to-emerald-100 border-2 border-green-200 rounded-2xl p-6 flex flex-col justify-center items-center [backface-visibility:hidden] [transform:rotateY(180deg)]">
                            <div className="text-4xl mb-4">💡</div>
                            <p className="text-lg font-semibold text-center text-gray-900">{card.back}</p>
                            <p className="text-sm text-gray-500 mt-4">Click to flip back</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quiz */}
              {activeTab === 'quiz' && (
                <div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-6">🧠 Kuis & Ujian</h3>
                  <div className="space-y-8">
                    {payload.quiz_exam.map((q: QuizQuestion) => {
                      const userAnswer = quizAnswers[q.id];
                      const isCorrect = userAnswer === q.correct_answer;
                      return (
                        <div key={q.id} className="border border-gray-200 rounded-xl p-6 bg-gray-50">
                          <h4 className="text-lg font-semibold text-gray-900 mb-4">
                            {q.id}. {q.question}
                          </h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                            {q.options.map((opt, idx) => (
                              <label
                                key={idx}
                                className={`flex items-center gap-3 p-4 rounded-lg border-2 cursor-pointer transition ${!quizSubmitted
                                    ? 'border-gray-300 hover:border-blue-400 bg-white'
                                    : opt === q.correct_answer
                                      ? 'border-green-500 bg-green-50'
                                      : userAnswer === opt
                                        ? 'border-red-500 bg-red-50'
                                        : 'border-gray-300 bg-white'
                                  }`}
                              >
                                <input
                                  type="radio"
                                  name={`q${q.id}`}
                                  value={opt}
                                  checked={userAnswer === opt}
                                  onChange={() => handleQuizAnswer(q.id, opt)}
                                  disabled={quizSubmitted}
                                  className="h-5 w-5"
                                />
                                <span className="flex-1">{opt}</span>
                                {quizSubmitted && opt === q.correct_answer && (
                                  <CheckCircle className="text-green-600" size={20} />
                                )}
                                {quizSubmitted && userAnswer === opt && userAnswer !== q.correct_answer && (
                                  <XCircle className="text-red-600" size={20} />
                                )}
                              </label>
                            ))}
                          </div>
                          {quizSubmitted && (
                            <div className="p-4 bg-blue-50 rounded-lg">
                              <p className="font-semibold text-blue-900">Penjelasan:</p>
                              <p className="text-gray-800">{q.explanation}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex gap-4 mt-8">
                    <button
                      onClick={submitQuiz}
                      disabled={quizSubmitted || Object.keys(quizAnswers).length !== payload.quiz_exam.length}
                      className="px-6 py-3 bg-green-600 text-white font-semibold rounded-full hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Submit Jawaban
                    </button>
                    <button
                      onClick={resetQuiz}
                      className="px-6 py-3 bg-gray-200 text-gray-800 font-semibold rounded-full hover:bg-gray-300"
                    >
                      Reset Kuis
                    </button>
                  </div>
                  <div className="mt-4 text-sm text-gray-600">
                    {quizSubmitted ? (
                      <p>
                        Skor:{' '}
                        <strong>
                          {payload.quiz_exam.filter(q => quizAnswers[q.id] === q.correct_answer).length} / {payload.quiz_exam.length}
                        </strong>
                      </p>
                    ) : (
                      <p>
                        Terjawab {Object.keys(quizAnswers).length} dari {payload.quiz_exam.length} soal.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Socratic Tutor */}
              {activeTab === 'tutor' && (
                <div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-6">🤖 Socratic AI Tutor</h3>
                  <div className="border border-gray-200 rounded-xl overflow-hidden flex flex-col h-[500px]">
                    {/* Chat messages */}
                    <div className="flex-1 p-4 overflow-y-auto bg-gray-50 space-y-4">
                      {messages.map((m, idx) => (
                        <div
                          key={idx}
                          className={`max-w-[80%] p-4 rounded-2xl ${m.role === 'user'
                              ? 'bg-blue-600 text-white self-end ml-auto'
                              : 'bg-white border border-gray-200 self-start'
                            }`}
                        >
                          <div className="font-semibold mb-1">{m.role === 'user' ? 'Anda' : 'Tutor Socrates'}</div>
                          <div className="whitespace-pre-wrap">{m.content}</div>
                        </div>
                      ))}
                      {chatLoading && (
                        <div className="max-w-[80%] p-4 rounded-2xl bg-white border border-gray-200 self-start">
                          <div className="flex gap-2">
                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                          </div>
                        </div>
                      )}
                      <div ref={messagesEndRef} />
                    </div>

                    {/* Input form */}
                    <form onSubmit={handleChatSubmit} className="border-t border-gray-200 p-4 bg-white">
                      <div className="flex gap-2">
                        <input
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          placeholder="Tanya tutor Socrates (misalnya: 'Bagaimana cara memahami konsep ini?')"
                          className="flex-1 border border-gray-300 rounded-full px-5 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button
                          type="submit"
                          disabled={chatLoading}
                          className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-semibold rounded-full hover:opacity-90 disabled:opacity-50"
                        >
                          Kirim
                        </button>
                      </div>
                      <p className="text-sm text-gray-500 mt-2">
                        Tutor akan membimbing dengan pertanyaan, bukan memberi jawaban langsung.
                      </p>
                    </form>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="max-w-6xl mx-auto mt-12 text-center text-gray-500 text-sm">
        <p>
          BikinPaham.ai — Personalisasi belajar dengan AI. Powered by Gemini 2.0 Flash & Groq Llama 3.
        </p>
        <p className="mt-2">
          Pastikan environment variables <code className="bg-gray-100 px-1 rounded">GEMINI_API_KEY</code> dan{' '}
          <code className="bg-gray-100 px-1 rounded">GROQ_API_KEY</code> sudah diisi di <code className="bg-gray-100 px-1 rounded">.env.local</code>.
        </p>
      </footer>
    </div>
  );
}