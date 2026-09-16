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

MATHEMATICAL FORMULA & SYMBOL FORMATTING RULE:
- ALL mathematical formulas, variables, equations, set symbols, fractions, powers, roots, and inequalities MUST be formatted in LaTeX syntax enclosed in single dollar signs '$...$' for inline or '$$...$$' for block formulas.
- EXAMPLES:
  - Write '$\\sqrt{2}$' instead of 'akar(2)'
  - Write '$\\frac{a}{b}$' instead of 'a/b'
  - Write '$x \\ge -6$' instead of 'x >= -6'
  - Write '$\\mathbb{R}$', '$\\in$', '$\\neq 0$' for sets and relations.
- NEVER write raw plain text math like 'akar(x)', '>=', or 'x^2'. Always wrap in LaTeX dollar signs ($...$).

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
  let text = rawResponse.trim();

  // 1. Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 2. Direct parse attempt
  try {
    return JSON.parse(text);
  } catch {
    // continue to repair
  }

  // 3. Extract outermost JSON object { ... }
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    text = text.slice(firstBrace);
  }

  // 4. Handle truncated response or malformed trailing tokens
  // If JSON was cut off in the middle of a string or array/object:
  let repaired = text;

  // If last open quote not closed, close it
  const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    repaired += '"';
  }

  // Remove incomplete trailing key-values like `"correct_answer":` or dangling comma
  repaired = repaired.replace(/,\s*"[^"]*":\s*$/g, '');
  repaired = repaired.replace(/,\s*$/g, '');

  // Balance brackets and braces
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    const prev = i > 0 ? repaired[i - 1] : '';

    if (char === '"' && prev !== '\\') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') openBraces++;
      else if (char === '}') openBraces = Math.max(0, openBraces - 1);
      else if (char === '[') openBrackets++;
      else if (char === ']') openBrackets = Math.max(0, openBrackets - 1);
    }
  }

  // Close open brackets and braces
  while (openBrackets > 0) {
    repaired += ']';
    openBrackets--;
  }
  while (openBraces > 0) {
    repaired += '}';
    openBraces--;
  }

  try {
    return JSON.parse(repaired);
  } catch {
    // 5. Aggressive regex-based fallback: slice back to last known complete item
    // Try rolling back to the last valid closing curly brace or bracket
    const lastValidClosing = Math.max(repaired.lastIndexOf('},'), repaired.lastIndexOf('}]'));
    if (lastValidClosing !== -1) {
      let trimmed = repaired.slice(0, lastValidClosing + 1);
      if (trimmed.includes('"quiz_exam":') && !trimmed.endsWith(']}')) {
        trimmed += ']}';
      } else if (!trimmed.endsWith('}')) {
        trimmed += '}';
      }
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        console.error('Aggressive JSON rollback failed:', e);
      }
    }

    throw new Error(`JSON response from AI was truncated or invalid: ${rawResponse.slice(-150)}`);
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
    const contentType = request.headers.get('content-type') || '';
    let documentText = '';
    let targetLevel: TargetLevel = 'SMA_SMK';
    let isImageData = false;
    let imageBase64 = '';
    let mimeType = '';
    let fileHashInput = '';
    let docTitle = 'Materi';

    if (contentType.includes('application/json')) {
      const body = await request.json();
      documentText = body.textContent || '';
      targetLevel = body.targetLevel || body.target_level || 'SMA_SMK';
      docTitle = body.fileName || 'Materi';
      fileHashInput = documentText;

      if (!documentText.trim()) {
        return NextResponse.json({ error: 'Teks dokumen kosong atau gagal diekstrak.' }, { status: 400 });
      }
    } else {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      targetLevel = ((formData.get('targetLevel') || formData.get('target_level')) as TargetLevel) || 'SMA_SMK';

      if (!file) {
        return NextResponse.json({ error: 'File is required' }, { status: 400 });
      }

      docTitle = file.name;
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const fileName = file.name.toLowerCase();
      const isPpt = fileName.endsWith('.ppt') || fileName.endsWith('.pptx');
      const isPdf = fileName.endsWith('.pdf') || file.type === 'application/pdf';
      const isImage = file.type.startsWith('image/');

      if (isImage) {
        isImageData = true;
        imageBase64 = buffer.toString('base64');
        mimeType = file.type;
        fileHashInput = imageBase64;
      } else if (isPpt) {
        documentText = await extractPptText(buffer);
        fileHashInput = buffer.toString('binary');
      } else if (isPdf) {
        const text = await extractPdfText(buffer);
        if (text.trim().length > 200) {
          documentText = text;
        } else {
          // Scanned PDF fallback
          isImageData = true;
          imageBase64 = buffer.toString('base64');
          mimeType = 'application/pdf';
        }
        fileHashInput = buffer.toString('binary');
      } else {
        documentText = buffer.toString('utf-8');
        fileHashInput = documentText;
      }
    }

    if (!['SD_SMP', 'SMA_SMK', 'MAHASISWA'].includes(targetLevel)) {
      return NextResponse.json({ error: 'Valid target_level required' }, { status: 400 });
    }

    // ── SHA-256 hash for cache ────────────────────────────────────────────────
    const hash = createHash('sha256').update(fileHashInput).update(targetLevel).digest('hex');

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

    const genAI = new GoogleGenerativeAI(apiKey);
    const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const model = genAI.getGenerativeModel(
      { model: modelName },
      { apiVersion: 'v1beta' },
    );

    const generationConfig = {
      temperature: 0.4,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json' as const,
    };

    const systemPrompt = SYSTEM_PROMPT(TONE[targetLevel]);
    let result;

    if (isImageData) {
      result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: systemPrompt },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        }],
        generationConfig,
      });
    } else {
      if (!documentText.trim()) throw new Error('No text extracted from document');

      result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\nDocument content:\n${truncateText(documentText)}` }],
        }],
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
