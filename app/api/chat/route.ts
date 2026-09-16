import { NextRequest } from 'next/server';
import { streamText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import type { TargetLevel } from '@/types/payload';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const TONE_LABEL: Record<TargetLevel, string> = {
  SD_SMP:    'elementary/middle school student (simple words, fun tone)',
  SMA_SMK:   'high school student (exam-focused, clear and concise)',
  MAHASISWA: 'university student (academic, analytical)',
};

export async function POST(request: NextRequest) {
  try {
    const {
      messages,
      summaryContext,
      target_level,
    }: {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      summaryContext?: string;
      target_level?: TargetLevel;
    } = await request.json();

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY not set');

    const groq = createGroq({ apiKey });

    const level     = target_level ?? 'SMA_SMK';
    const toneLabel = TONE_LABEL[level];
    const context   = summaryContext?.trim() || 'general learning material';

    const systemPrompt =
      `You are BikinPaham Socratic AI Tutor.\n` +
      `Rule 1: NEVER give direct answers to questions or homework.\n` +
      `Rule 2: Ask short, guiding questions (max 2-3 sentences) based on the provided material context to help the student think.\n` +
      `Rule 3: Adapt your tone to a ${toneLabel}.\n` +
      `Context: ${context}`;

    const result = streamText({
      model: groq('llama-3.3-70b-versatile'),
      system: systemPrompt,
      messages,
      temperature: 0.7,
      maxOutputTokens: 512,
    });

    return result.toTextStreamResponse();
  } catch (error) {
    console.error('Chat error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown chat error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
