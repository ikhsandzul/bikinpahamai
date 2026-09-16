import { NextRequest } from 'next/server';
import Groq from 'groq-sdk';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '',
});

export async function POST(request: NextRequest) {
  try {
    const { messages, context } = await request.json();

    if (!groq.apiKey) {
      throw new Error('GROQ_API_KEY environment variable not set');
    }

    // System prompt for Socratic tutor
    const systemPrompt = `
You are a Socratic AI Tutor for BikinPaham.ai. Your role is to guide students through understanding, NOT to give direct answers.

Rules:
1. NEVER provide direct answers to quiz questions, homework problems, or exact solutions.
2. Always respond with guiding questions, hints, analogies, and encouragement.
3. Base your guidance on the provided learning context: ${context || 'general learning'}.
4. Ask one step at a time. Help students discover answers themselves.
5. Use positive reinforcement and celebrate small wins.

Example:
Student: "What's the answer to question 3?"
You: "Let's break it down. What concept from the material do you think this question is testing? Can you recall the key points about that topic?"

Student: "I don't understand this formula."
You: "Great question! Let's start with what each variable represents. Which part of the formula feels most confusing?"

Now begin the session.`;

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