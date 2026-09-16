import { NextRequest } from 'next/server';
import Groq from 'groq-sdk';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '',
});

export async function POST(request: NextRequest) {
  try {
    const { messages, context, summaryContext, target_level = 'SMA_SMK' } = await request.json();

    if (!groq.apiKey) {
      throw new Error('GROQ_API_KEY environment variable not set');
    }

    const learningContext = context || summaryContext || 'general learning';

    // System prompt for Socratic tutor enforcing Bahasa Indonesia
    const systemPrompt = `You are BikinPaham Socratic AI Tutor.
- MANDATE: You MUST communicate ONLY in BAHASA INDONESIA.
- Adapt your tone to the student's level (${target_level}) using natural Indonesian.
- NEVER give direct answers to questions, homework, or exam problems.
- Ask short, guiding questions (max 2-3 sentences) in Bahasa Indonesia to prompt the student to think.
- Base your guidance on this learning context: ${learningContext}.
- One step at a time. Help students discover answers themselves.`;

    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
    });

    // Convert Groq stream to ReadableStream
    const encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              controller.enqueue(encoder.encode(content));
            }
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Chat error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown chat error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}