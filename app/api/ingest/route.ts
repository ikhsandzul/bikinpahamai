import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { parseOffice } from 'officeparser';
import { supabase } from '@/lib/supabase';
import type { BikinPahamPayload, TargetLevel } from '@/types/payload';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// ─── Tone presets per level ───────────────────────────────────────────────────
const TONE: Record<TargetLevel, string> = {
  SD_SMP:    'elementary/middle school students — use simple vocabulary, cartoon and daily-life analogies, child-friendly tone, short sentences.',
  SMA_SMK:   'high school students (UTBK exam level) — key formulas, quick tricks, exam-focused explanations, concise but complete.',
  MAHASISWA: 'university students — academic tone, deep theoretical reasoning, cite related concepts, comprehensive explanations.',
};

// ─── Deep-enforcement system prompt ──────────────────────────────────────────
const SYSTEM_PROMPT = (tone: string) => `
You are the Lead Curriculum Expert for BikinPaham.ai.
Your goal is to transform uploaded educational material into an extremely THOROUGH, DEEP, and EXTENSIVE study suite.
DO NOT give brief, lazy, or truncated summaries. Be comprehensive.

OUTPUT REQUIREMENTS (STRICT QUANTITY & DEPTH):

1. summary_module:
   - Generate 4 to 6 detailed sub-topics covering the ENTIRE document.
   - Each topic MUST have 3-5 comprehensive key_points.
   - The 'explanation' field MUST be a detailed multi-sentence explanation (minimum 100 words per topic), using analogies fitting for level: ${tone}.

2. flashcards:
   - Generate 8 to 10 distinct, high-value flashcards covering definitions, formulas, key concepts, and important facts.
   - Front: Precise concept or question. Back: Clear, actionable definition or answer.

3. quiz_exam:
   - Generate 5 to 8 high-quality multiple-choice questions (options A, B, C, D).
   - The 'explanation' field MUST explain WHY the correct answer is right AND why the other options are wrong (minimum 2-3 sentences).

Output schema (strict — no markdown fences, no extra commentary):
{
  "document_meta": { "title": string, "target_level": string },
  "summary_module": [{ "topic": string, "key_points": string[], "explanation": string }],
  "flashcards":     [{ "id": number, "front": string, "back": string }],
  "quiz_exam":      [{ "id": number, "question": string, "options": string[], "correct_answer": string, "explanation": string }]
}
`.trim();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Truncate extracted text to keep input tokens reasonable (~12k chars max) */
function truncateText(text: string, maxChars = 12000): string {
  return text.length > maxChars
    ? text.slice(0, maxChars) + '\n[...content truncated for processing...]'
    : text;
}

/** Clean, repair, and parse JSON from Gemini response */
function cleanAndParseJSON(rawResponse: string): BikinPahamPayload {
  try {
    // 1. Strip markdown backticks if present
    const cleaned = rawResponse
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    // 2. Attempt standard parse
    return JSON.parse(cleaned);
  } catch {
    // 3. Fallback: attempt soft closing bracket repair
    let repaired = rawResponse.trim();
    if (!repaired.endsWith('}')) {
      if (repaired.includes('"quiz_exam": [') && !repaired.endsWith(']}')) {
        repaired += ']}';
      } else {
        repaired += '}';
      }
    }
    return JSON.parse(repaired);
  }
}

/** Extract plain text from PPT/PPTX buffer */
async function extractPptText(buffer: Buffer): Promise<string> {
  const ast = await parseOffice(buffer as unknown as Parameters<typeof parseOffice>[0]);
  return (ast as unknown as { toText: () => string }).toText() ?? '';
}

/** Extract plain text from PDF buffer (text-based only; returns '' for scanned) */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // Dynamic import avoids pdf-parse@1.1.1 test file load at build time
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return result.text ?? '';
  } catch {
    return '';
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const formData    = await request.formData();
    const file        = formData.get('file') as File | null;
    const targetLevel = formData.get('target_level') as TargetLevel | null;

    if (!file) {
      return NextResponse.json({ error: 'File is required' }, { status: 400 });
    }
    if (!targetLevel || !['SD_SMP', 'SMA_SMK', 'MAHASISWA'].includes(targetLevel)) {
      return NextResponse.json({ error: 'Valid target_level required' }, { status: 400 });
    }

    const bytes  = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const fileName  = file.name.toLowerCase();
    const isPpt     = fileName.endsWith('.ppt') || fileName.endsWith('.pptx');
    const isPdf     = fileName.endsWith('.pdf') || file.type === 'application/pdf';
    const isImage   = file.type.startsWith('image/');

    // ── SHA-256 hash ───────────────────────────────────────────────────────────
    const hash = createHash('sha256').update(buffer).update(targetLevel).digest('hex');

    // ── Cache lookup ───────────────────────────────────────────────────────────
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

    // ── Gemini setup ───────────────────────────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const genAI     = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const model     = genAI.getGenerativeModel(
      { model: modelName },
      { apiVersion: 'v1beta' },
    );

    const generationConfig = {
      temperature:      0.4,
      maxOutputTokens:  8192,
      responseMimeType: 'application/json' as const,
    };

    const systemPrompt = SYSTEM_PROMPT(TONE[targetLevel]);
    let result;

    if (isPpt) {
      // ── PPT/PPTX: extract slide text → plain text prompt ────────────────────
      const text = await extractPptText(buffer);
      if (!text.trim()) throw new Error('No text extracted from presentation file');

      result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nDocument content:\n${truncateText(text)}` }] }],
        generationConfig,
      });

    } else if (isPdf) {
      // ── PDF: try text extraction first (3× faster); fallback to base64 ───────
      const text = await extractPdfText(buffer);

      if (text.trim().length > 200) {
        // Text-based PDF: send as plain text
        result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nDocument content:\n${truncateText(text)}` }] }],
          generationConfig,
        });
      } else {
        // Scanned/image PDF: fallback to base64 inlineData
        result = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { text: systemPrompt },
              { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } },
            ],
          }],
          generationConfig,
        });
      }

    } else if (isImage) {
      // ── Image: base64 inlineData ────────────────────────────────────────────
      result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: systemPrompt },
            { inlineData: { mimeType: file.type, data: buffer.toString('base64') } },
          ],
        }],
        generationConfig,
      });

    } else {
      // ── Unknown: treat as plain text ────────────────────────────────────────
      const text = buffer.toString('utf-8');
      result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nDocument content:\n${truncateText(text)}` }] }],
        generationConfig,
      });
    }

    const raw = result.response.text();
    if (!raw) throw new Error('No content from Gemini');

    const payload: BikinPahamPayload = cleanAndParseJSON(raw);
    payload.document_meta.target_level = targetLevel;

    // ── Persist to cache (non-blocking) ───────────────────────────────────────
    supabase
      .from('materials')
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
