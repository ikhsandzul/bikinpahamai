import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { messages, context, targetLevel } = await req.json();

    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    const systemPrompt = `Anda adalah Tutor AI Socrates dari BikinPaham.ai.
MANDAT UTAMA:
1. Wajib 100% menggunakan Bahasa Indonesia yang ramah, komunikatif, dan sesuai level: ${targetLevel || 'SMA_SMK'}.
2. DILARANG KERAS memberikan jawaban langsung atas pertanyaan/soal murid!
3. Jawab HANYA dengan 1-2 pertanyaan pemandu yang memancing pemikiran kritis murid berdasarkan konteks materi ini.

MATHEMATICAL FORMULA & SYMBOL FORMATTING RULE:
- ALL mathematical formulas, variables, equations, set symbols, fractions, powers, roots, and inequalities MUST be formatted in LaTeX syntax enclosed in single dollar signs '$...$' for inline or '$$...$$' for block formulas.
- EXAMPLES:
  - Write '$\\sqrt{2}$' instead of 'akar(2)'
  - Write '$\\frac{a}{b}$' instead of 'a/b'
  - Write '$x \\ge -6$' instead of 'x >= -6'
  - Write '$\\mathbb{R}$', '$\\in$', '$\\neq 0$' for sets and relations.
- NEVER write raw plain text math like 'akar(x)', '>=', or 'x^2'. Always wrap in LaTeX dollar signs ($...$).

Konteks Materi Upload:
${typeof context === 'string' ? context : JSON.stringify(context || 'Materi Umum')}`;

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m: { role: string; content: string }) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    // 1. Try Groq Primary
    if (groqKey) {
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: formattedMessages,
            stream: true,
            temperature: 0.6,
          }),
        });

        if (groqRes.ok && groqRes.body) {
          return new Response(groqRes.body, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            },
          });
        }

        const errText = await groqRes.text();
        console.error('Groq returned error, falling back to Gemini:', groqRes.status, errText);
      } catch (groqErr) {
        console.error('Groq fetch failed, attempting fallback:', groqErr);
      }
    }

    // 2. Fallback: Google Gemini
    if (geminiKey) {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      // Transform messages to Gemini contents format
      const historyContents = messages.slice(0, -1).map((m: { role: string; content: string }) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const lastUserMsg = messages[messages.length - 1]?.content || 'Halo';

      const chat = model.startChat({
        history: [
          { role: 'user', parts: [{ text: `System instruction:\n${systemPrompt}` }] },
          { role: 'model', parts: [{ text: 'Paham. Saya akan bertindak sebagai Tutor AI Socrates dalam Bahasa Indonesia.' }] },
          ...historyContents,
        ],
      });

      const geminiStream = await chat.sendMessageStream(lastUserMsg);
      const encoder = new TextEncoder();

      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of geminiStream.stream) {
              const text = chunk.text();
              if (text) {
                // Format chunk as OpenAI SSE compatible format
                const sseData = JSON.stringify({
                  choices: [{ delta: { content: text } }],
                });
                controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
              }
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    return NextResponse.json({ error: 'Tidak ada API Key yang valid (Groq / Gemini)' }, { status: 500 });
  } catch (err: any) {
    console.error('Route error in /api/chat:', err);
    return NextResponse.json({ error: err.message || 'Server Error' }, { status: 500 });
  }
}

