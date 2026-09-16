import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { parseOffice } from 'officeparser';
import Groq from 'groq-sdk';
import { supabase } from '@/lib/supabase';
import type { BikinPahamPayload, TargetLevel, SummaryTopic, FlashcardItem, QuizQuestion } from '@/types/payload';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// --- Tone instructions per target level ---
const TONE: Record<TargetLevel, string> = {
  SD_SMP: 'elementary/middle school students — use simple vocabulary, cartoon and daily-life analogies, child-friendly tone, short sentences.',
  SMA_SMK: 'high school students (UTBK exam level) — key formulas, quick tricks, exam-focused explanations, concise but complete.',
  MAHASISWA: 'university students — academic tone, deep theoretical reasoning, cite related concepts, comprehensive explanations.',
};

/** Truncate extracted text to keep prompt within model limits */
function truncateText(text: string, maxChars = 15000): string {
  return text.length > maxChars
    ? text.slice(0, maxChars) + '\n[...content truncated for processing...]'
    : text;
}

/** Extract plain text from PPT/PPTX buffer */
async function extractPptText(buffer: Buffer): Promise<string> {
  const ast = await parseOffice(buffer as unknown as Parameters<typeof parseOffice>[0]);
  return (ast as unknown as { toText: () => string }).toText() ?? '';
}

/** Extract plain text from PDF buffer */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return result.text ?? '';
  } catch {
    return '';
  }
}

/** Clean & safely parse JSON string */
function cleanAndParseJSON<T>(rawResponse: string): T {
  const cleaned = rawResponse
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

// ─── Phase 1: Text / Vision Extraction ──────────────────────────────────────────
async function extractDocumentText(
  file: File,
  buffer: Buffer,
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>
): Promise<string> {
  const fileName = file.name.toLowerCase();
  const isPpt = fileName.endsWith('.ppt') || fileName.endsWith('.pptx');
  const isPdf = fileName.endsWith('.pdf') || file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (isPpt) {
    const text = await extractPptText(buffer);
    if (text.trim()) return text;
  }

  if (isPdf) {
    const text = await extractPdfText(buffer);
    if (text.trim().length > 200) return text;
  }

  // Fallback / Vision extraction via Gemini 1.5 Flash (for scanned PDFs, images, or failed local parse)
  const mimeType = isPdf ? 'application/pdf' : (file.type || 'application/octet-stream');
  if (isPdf || isImage) {
    const visionResult = await model.generateContent([
      'Extract all readable text, main ideas, concepts, equations, and tables from this document verbatim and thoroughly. Provide raw structured text content only.',
      {
        inlineData: {
          mimeType,
          data: buffer.toString('base64'),
        },
      },
    ]);
    const text = visionResult.response.text();
    if (text.trim()) return text;
  }

  const rawUtf8 = buffer.toString('utf-8');
  if (rawUtf8.trim()) return rawUtf8;

  throw new Error('Unable to extract readable text from document');
}

// ─── Phase 2 Prompts & Types ───────────────────────────────────────────────────
interface SummaryResult {
  title?: string;
  summary_module: SummaryTopic[];
}

interface FlashcardResult {
  flashcards: FlashcardItem[];
}

interface QuizResult {
  quiz_exam: QuizQuestion[];
}

function getLanguageMandate(targetLevel: TargetLevel): string {
  return `CRITICAL LANGUAGE MANDATE:
- ALL generated text (topic names, key points, detailed explanations, flashcard fronts & backs, quiz questions, multiple-choice options, and quiz explanations) MUST be written strictly in BAHASA INDONESIA.
- Even if the input document contains English text, technical terms, or academic standards (e.g., ACM, KKNI, Information Systems), translate and explain everything in clear, natural BAHASA INDONESIA tailored for ${targetLevel}.
- DO NOT return English summaries, key points, or explanations under any circumstances.`;
}

function getSummaryPrompt(docText: string, tone: string, targetLevel: TargetLevel): string {
  return `${getLanguageMandate(targetLevel)}

You are an educational curriculum expert.
Tone/Target level: ${tone}.
Analyze the document text and produce a JSON object with:
1. "title": A concise descriptive title of the document in Bahasa Indonesia.
2. "summary_module": Array of 5 to 8 detailed sub-topics covering the full document.
   Each item must have:
   - "topic": Name of the sub-topic (Bahasa Indonesia).
   - "key_points": Array of 3-5 comprehensive key bullet points (Bahasa Indonesia).
   - "explanation": Detailed multi-sentence explanation (minimum 80-100 words in Bahasa Indonesia) tailored to the target audience.

Output format (strictly valid JSON object):
{
  "title": "Judul Dokumen",
  "summary_module": [
    { "topic": "string", "key_points": ["poin 1", "poin 2"], "explanation": "string" }
  ]
}

Document text:
${truncateText(docText)}`;
}

function getFlashcardPrompt(docText: string, tone: string, targetLevel: TargetLevel): string {
  return `${getLanguageMandate(targetLevel)}

You are an educational study expert.
Tone/Target level: ${tone}.
Generate 12 to 15 comprehensive flashcards covering all definitions, formulas, key concepts, and critical facts from the document, written strictly in Bahasa Indonesia.
Each flashcard must have:
- "id": number (starting from 1)
- "front": Clear question, term, or prompt in Bahasa Indonesia
- "back": Precise, thorough answer or explanation in Bahasa Indonesia

Output format (strictly valid JSON object):
{
  "flashcards": [
    { "id": 1, "front": "string", "back": "string" }
  ]
}

Document text:
${truncateText(docText)}`;
}

function getQuizPrompt(docText: string, tone: string, targetLevel: TargetLevel): string {
  return `${getLanguageMandate(targetLevel)}

You are an exam and assessment expert.
Tone/Target level: ${tone}.
Generate 8 to 10 high-quality multiple-choice questions testing understanding of the document, written strictly in Bahasa Indonesia.
Each item must have:
- "id": number (starting from 1)
- "question": Challenging, well-phrased question in Bahasa Indonesia
- "options": Exactly 4 distinct answer choices in Bahasa Indonesia
- "correct_answer": Exact matching text of the correct option
- "explanation": In-depth explanation explaining WHY the correct answer is right and why alternatives are wrong in Bahasa Indonesia (2-3 sentences).

Output format (strictly valid JSON object):
{
  "quiz_exam": [
    {
      "id": 1,
      "question": "string",
      "options": ["A", "B", "C", "D"],
      "correct_answer": "A",
      "explanation": "string"
    }
  ]
}

Document text:
${truncateText(docText)}`;
}

// ─── Parallel Generation via Groq API ──────────────────────────────────────────
async function runGroqTask<T>(groq: Groq, prompt: string, modelName: string): Promise<T> {
  const completion = await groq.chat.completions.create({
    model: modelName,
    messages: [
      {
        role: 'system',
        content: 'You are an AI that outputs valid JSON only. Never output markdown fences or explanatory text outside the JSON object.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from Groq');
  return cleanAndParseJSON<T>(content);
}

// ─── Fallback Generation via Gemini API ─────────────────────────────────────────
async function runGeminiTask<T>(
  geminiModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  prompt: string
): Promise<T> {
  const result = await geminiModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
    },
  });

  const text = result.response.text();
  if (!text) throw new Error('Empty response from Gemini');
  return cleanAndParseJSON<T>(text);
}

// ─── Route Handler ─────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const targetLevel = formData.get('target_level') as TargetLevel | null;

    if (!file) {
      return NextResponse.json({ error: 'File is required' }, { status: 400 });
    }

    if (!targetLevel || !['SD_SMP', 'SMA_SMK', 'MAHASISWA'].includes(targetLevel)) {
      return NextResponse.json(
        { error: 'Valid target_level required: SD_SMP, SMA_SMK, or MAHASISWA' },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // ── Cache Lookup ────────────────────────────────────────────────────────────
    const hash = createHash('sha256').update(buffer).update(targetLevel).digest('hex');

    const { data: cached, error: dbError } = await supabase
      .from('materials')
      .select('payload')
      .eq('file_hash', hash)
      .eq('target_level', targetLevel)
      .maybeSingle();

    if (dbError) console.warn('Supabase cache lookup error:', dbError.message);
    if (cached?.payload) {
      return NextResponse.json({ cached: true, payload: cached.payload as BikinPahamPayload });
    }

    // ── Gemini Client Setup ─────────────────────────────────────────────────────
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY environment variable not set');
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const geminiModelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const geminiModel = genAI.getGenerativeModel({ model: geminiModelName });

    // ── Phase 1: Fast Text/Vision Extraction ────────────────────────────────────
    const documentText = await extractDocumentText(file, buffer, geminiModel);

    // ── Phase 2: Parallel Tasks Generation ──────────────────────────────────────
    const tone = TONE[targetLevel];
    const summaryPrompt = getSummaryPrompt(documentText, tone, targetLevel);
    const flashcardPrompt = getFlashcardPrompt(documentText, tone, targetLevel);
    const quizPrompt = getQuizPrompt(documentText, tone, targetLevel);

    const groqApiKey = process.env.GROQ_API_KEY;
    const groqModelName = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

    let summaryData: SummaryResult;
    let flashcardData: FlashcardResult;
    let quizData: QuizResult;

    if (groqApiKey) {
      try {
        const groq = new Groq({ apiKey: groqApiKey });
        [summaryData, flashcardData, quizData] = await Promise.all([
          runGroqTask<SummaryResult>(groq, summaryPrompt, groqModelName),
          runGroqTask<FlashcardResult>(groq, flashcardPrompt, groqModelName),
          runGroqTask<QuizResult>(groq, quizPrompt, groqModelName),
        ]);
      } catch (groqError) {
        console.warn('Groq parallel pipeline failed/rate-limited, falling back to Gemini:', groqError);
        [summaryData, flashcardData, quizData] = await Promise.all([
          runGeminiTask<SummaryResult>(geminiModel, summaryPrompt),
          runGeminiTask<FlashcardResult>(geminiModel, flashcardPrompt),
          runGeminiTask<QuizResult>(geminiModel, quizPrompt),
        ]);
      }
    } else {
      // Direct Gemini parallel fallback if GROQ_API_KEY is not configured
      [summaryData, flashcardData, quizData] = await Promise.all([
        runGeminiTask<SummaryResult>(geminiModel, summaryPrompt),
        runGeminiTask<FlashcardResult>(geminiModel, flashcardPrompt),
        runGeminiTask<QuizResult>(geminiModel, quizPrompt),
      ]);
    }

    // ── Phase 3: Payload Assembly & Cache ───────────────────────────────────────
    const defaultTitle = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
    const finalPayload: BikinPahamPayload = {
      document_meta: {
        title: summaryData.title || defaultTitle,
        target_level: targetLevel,
      },
      summary_module: summaryData.summary_module || [],
      flashcards: flashcardData.flashcards || [],
      quiz_exam: quizData.quiz_exam || [],
    };

    // Cache to Supabase materials table (non-blocking)
    supabase
      .from('materials')
      .insert({
        file_hash: hash,
        target_level: targetLevel,
        title: finalPayload.document_meta.title,
        payload: finalPayload,
      })
      .then(({ error }) => {
        if (error) console.warn('Supabase cache insert error:', error.message);
      });

    return NextResponse.json({ cached: false, payload: finalPayload });
  } catch (error) {
    console.error('Ingestion error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown ingestion error' },
      { status: 500 }
    );
  }
}