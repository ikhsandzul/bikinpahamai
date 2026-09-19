import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { GoogleGenerativeAI, type GenerateContentRequest } from '@google/generative-ai';
import { parseOffice } from 'officeparser';
import { supabase } from '@/lib/supabase';
import type { BikinPahamPayload, TargetLevel, SummaryTopic, FlashcardItem, QuizQuestion } from '@/types/payload';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// ─── Tone presets ─────────────────────────────────────────────────────────────
const TONE: Record<TargetLevel, string> = {
  SD_SMP:    'elementary/middle school — simple vocabulary, daily-life analogies, child-friendly, short sentences.',
  SMA_SMK:   'high school (UTBK level) — key concepts, exam-focused, concise.',
  MAHASISWA: 'university — academic tone, precise, cite related concepts.',
};

// ─── Two separate prompts (each ~half the output) ─────────────────────────────

const PROMPT_A = (tone: string, content: string) => `
You are a curriculum expert for BikinPaham.ai.
Target audience: ${tone}

Output a single JSON object (no markdown, no extra text, stop immediately after the closing brace):
{"document_meta":{"title":"...","target_level":"..."},"summary_module":[{"topic":"...","key_points":["...","...","..."],"explanation":"..."}],"flashcards":[{"id":1,"front":"...","back":"..."}]}

Rules:
- summary_module: exactly 3 topics, each with exactly 3 key_points (max 10 words each), explanation max 1 sentence.
- flashcards: exactly 5 items, front max 8 words, back max 12 words.
- Write math in plain text: use "x^2", "sqrt(x)" — NO LaTeX backslashes or dollar signs.
- DO NOT add any text outside the JSON object.

Document:
${content}
`.trim();

const PROMPT_B = (tone: string, content: string) => `
You are a curriculum expert for BikinPaham.ai.
Target audience: ${tone}

Output a single JSON object (no markdown, no extra text, stop immediately after the closing brace):
{"quiz_exam":[{"id":1,"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"correct_answer":"A. ...","explanation":"..."}]}

Rules:
- quiz_exam: exactly 5 questions, 4 options each (prefix A. B. C. D.).
- correct_answer must exactly match one option string.
- explanation: 1 short sentence.
- Write math in plain text — NO LaTeX.
- DO NOT add any text outside the JSON object.

Document:
${content}
`.trim();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateText(text: string, maxChars = 2000): string {
  return text.length > maxChars
    ? text.slice(0, maxChars) + '\n[...truncated]'
    : text;
}

function sanitizeForGemini(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, '[formula]')
    .replace(/\$[^$\n]+\$/g, '[formula]')
    .replace(/\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g, '[formula]')
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeParseJSON<T>(raw: string): T {
  // Strip markdown fences
  let text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Direct parse
  try { return JSON.parse(text); } catch { /* fall through */ }

  // Find outermost { ... }
  const start = text.indexOf('{');
  if (start !== -1) text = text.slice(start);

  // Close unterminated string
  const quotes = (text.match(/(?<!\\)"/g) ?? []).length;
  if (quotes % 2 !== 0) text += '"';

  // Remove dangling key or comma at end
  text = text.replace(/,\s*"[^"]*":\s*$/g, '').replace(/,\s*$/g, '');

  // Balance { } [ ]
  let inStr = false;
  let ob = 0, ob2 = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], p = i > 0 ? text[i - 1] : '';
    if (c === '"' && p !== '\\') { inStr = !inStr; continue; }
    if (!inStr) {
      if (c === '{') ob++;
      else if (c === '}') ob = Math.max(0, ob - 1);
      else if (c === '[') ob2++;
      else if (c === ']') ob2 = Math.max(0, ob2 - 1);
    }
  }
  while (ob2-- > 0) text += ']';
  while (ob-- > 0)  text += '}';

  try { return JSON.parse(text); } catch {
    // Last resort: rollback to last complete item boundary
    const last = Math.max(text.lastIndexOf('},'), text.lastIndexOf('}]'));
    if (last !== -1) {
      let t = text.slice(0, last + 1);
      if (!t.endsWith('}')) t += '}';
      try { return JSON.parse(t); } catch { /* give up */ }
    }
    throw new Error(`JSON truncated/invalid. Tail: ${raw.slice(-120)}`);
  }
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
    return (await pdfParse(buffer)).text ?? '';
  } catch { return ''; }
}

// ─── Route ────────────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    let documentText = '';
    let targetLevel: TargetLevel = 'SMA_SMK';
    let isImageData = false;
    let imageBase64 = '';
    let mimeType = '';
    let fileHashInput = '';

    // ── Parse request ─────────────────────────────────────────────────────────
    if (contentType.includes('application/json')) {
      const body = await request.json();
      documentText  = body.textContent ?? '';
      targetLevel   = body.targetLevel ?? body.target_level ?? 'SMA_SMK';
      fileHashInput = documentText;
      if (!documentText.trim())
        return NextResponse.json({ error: 'Teks dokumen kosong.' }, { status: 400 });
    } else {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      targetLevel = ((formData.get('targetLevel') ?? formData.get('target_level')) as TargetLevel) ?? 'SMA_SMK';
      if (!file)
        return NextResponse.json({ error: 'File is required' }, { status: 400 });

      const bytes  = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const name   = file.name.toLowerCase();

      if (file.type.startsWith('image/')) {
        isImageData  = true;
        imageBase64  = buffer.toString('base64');
        mimeType     = file.type;
        fileHashInput = imageBase64;
      } else if (name.endsWith('.ppt') || name.endsWith('.pptx')) {
        documentText  = await extractPptText(buffer);
        fileHashInput = buffer.toString('binary');
      } else if (name.endsWith('.pdf') || file.type === 'application/pdf') {
        const t = await extractPdfText(buffer);
        if (t.trim().length > 200) {
          documentText = t;
        } else {
          isImageData = true;
          imageBase64 = buffer.toString('base64');
          mimeType    = 'application/pdf';
        }
        fileHashInput = buffer.toString('binary');
      } else {
        documentText  = buffer.toString('utf-8');
        fileHashInput = documentText;
      }
    }

    if (!['SD_SMP', 'SMA_SMK', 'MAHASISWA'].includes(targetLevel))
      return NextResponse.json({ error: 'Valid target_level required' }, { status: 400 });

    // ── Cache lookup ──────────────────────────────────────────────────────────
    const hash = createHash('sha256').update(fileHashInput).update(targetLevel).digest('hex');
    const { data: cached, error: dbErr } = await supabase
      .from('materials').select('payload')
      .eq('file_hash', hash).eq('target_level', targetLevel).maybeSingle();
    if (dbErr) console.warn('Supabase lookup error:', dbErr.message);
    if (cached?.payload)
      return NextResponse.json({ cached: true, payload: cached.payload as BikinPahamPayload });

    // ── Gemini setup ──────────────────────────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel(
      { model: process.env.GEMINI_MODEL ?? 'gemini-1.5-flash' },
      { apiVersion: 'v1beta' },
    );

    const cfg = {
      temperature:     0.3,
      maxOutputTokens: 2048,
    };

    const tone    = TONE[targetLevel];
    const content = isImageData ? '' : truncateText(sanitizeForGemini(documentText));

    // ── Build requests ────────────────────────────────────────────────────────
    const makeReq = (prompt: string, imgData?: { base64: string; mime: string }): GenerateContentRequest => ({
      contents: [{
        role: 'user',
        parts: imgData
          ? [{ text: prompt }, { inlineData: { mimeType: imgData.mime, data: imgData.base64 } }]
          : [{ text: prompt }],
      }],
      generationConfig: cfg,
    });

    const img = isImageData ? { base64: imageBase64, mime: mimeType } : undefined;

    // ── Fire both calls IN PARALLEL ───────────────────────────────────────────
    const [resA, resB] = await Promise.all([
      model.generateContent(makeReq(PROMPT_A(tone, content), img)),
      model.generateContent(makeReq(PROMPT_B(tone, content), img)),
    ]);

    const rawA = resA.response.text();
    const rawB = resB.response.text();
    if (!rawA) throw new Error('No response from Gemini (call A)');
    if (!rawB) throw new Error('No response from Gemini (call B)');

    // ── Parse & merge ─────────────────────────────────────────────────────────
    type PartA = { document_meta: BikinPahamPayload['document_meta']; summary_module: SummaryTopic[]; flashcards: FlashcardItem[] };
    type PartB = { quiz_exam: QuizQuestion[] };

    const partA = safeParseJSON<PartA>(rawA);
    const partB = safeParseJSON<PartB>(rawB);

    const payload: BikinPahamPayload = {
      document_meta:  partA.document_meta  ?? { title: 'Materi', target_level: targetLevel },
      summary_module: partA.summary_module ?? [],
      flashcards:     partA.flashcards     ?? [],
      quiz_exam:      partB.quiz_exam      ?? [],
    };
    payload.document_meta.target_level = targetLevel;

    // ── Cache (non-blocking) ──────────────────────────────────────────────────
    supabase.from('materials')
      .insert({ file_hash: hash, target_level: targetLevel, title: payload.document_meta.title, payload })
      .then(({ error }) => { if (error) console.warn('Supabase insert error:', error.message); });

    return NextResponse.json({ cached: false, payload });

  } catch (error) {
    console.error('Ingestion error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown ingestion error' },
      { status: 500 },
    );
  }
}
