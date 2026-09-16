import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabase } from '@/lib/supabase';
import type { BikinPahamPayload, TargetLevel } from '@/types/payload';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const TONE: Record<TargetLevel, string> = {
  SD_SMP:    'Use simple visual language, cartoon and daily-life analogies, child-friendly tone.',
  SMA_SMK:   'Focus on exam preparation (UTBK level), key formulas, quick tricks, high school tone.',
  MAHASISWA: 'Academic tone, deep reasoning, theoretical context, university level.',
};

const SYSTEM_PROMPT = (tone: string) => `
You are an expert educational content analyzer.
Extract the uploaded document into a structured JSON output strictly following this schema:

{
  "document_meta": { "title": string, "target_level": string },
  "summary_module": [{ "topic": string, "key_points": string[], "explanation": string }],
  "flashcards":     [{ "id": number, "front": string, "back": string }],
  "quiz_exam":      [{ "id": number, "question": string, "options": string[], "correct_answer": string, "explanation": string }]
}

Guidelines:
- 3-5 summary topics covering main sections.
- 8-12 flashcards: front = concept/question, back = answer/explanation.
- 5-10 multiple-choice questions with exactly 4 options each.
- Tone: ${tone}
- Output ONLY valid JSON. No markdown fences, no commentary.
`.trim();

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file        = formData.get('file') as File | null;
    const targetLevel = formData.get('target_level') as TargetLevel | null;

    if (!file) {
      return NextResponse.json({ error: 'File is required' }, { status: 400 });
    }
    if (!targetLevel || !['SD_SMP', 'SMA_SMK', 'MAHASISWA'].includes(targetLevel)) {
      return NextResponse.json({ error: 'Valid target_level required' }, { status: 400 });
    }

    // --- SHA-256 hash (buffer + target_level for level-scoped cache) ---
    const bytes  = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const hash   = createHash('sha256')
      .update(buffer)
      .update(targetLevel)
      .digest('hex');

    // --- Cache lookup ---
    const { data: cached, error: dbError } = await supabase
      .from('materials')
      .select('payload')
      .eq('file_hash', hash)
      .eq('target_level', targetLevel)
      .maybeSingle();

    if (dbError) {
      // Non-fatal: log and fall through to Gemini
      console.warn('Supabase cache lookup error:', dbError.message);
    }

    if (cached?.payload) {
      return NextResponse.json({ cached: true, payload: cached.payload as BikinPahamPayload });
    }

    // --- Cache MISS: call Gemini ---
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const genAI     = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const model     = genAI.getGenerativeModel({ model: modelName });

    const mimeType = file.type || 'application/pdf';
    const b64      = buffer.toString('base64');

    const result = await model.generateContent([
      SYSTEM_PROMPT(TONE[targetLevel]),
      { inlineData: { mimeType, data: b64 } },
    ]);

    const raw = result.response.text();
    if (!raw) throw new Error('No content from Gemini');

    // Strip optional markdown fences
    const jsonStr = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const payload: BikinPahamPayload = JSON.parse(jsonStr);
    payload.document_meta.target_level = targetLevel;

    // --- Persist to cache (non-blocking, non-fatal) ---
    supabase
      .from('materials')
      .insert({
        file_hash:    hash,
        target_level: targetLevel,
        title:        payload.document_meta.title,
        payload,
      })
      .then(({ error }) => {
        if (error) console.warn('Supabase insert error:', error.message);
      });

    return NextResponse.json({ cached: false, payload });
  } catch (error) {
    console.error('Ingestion error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown ingestion error' },
      { status: 500 },
    );
  }
}
