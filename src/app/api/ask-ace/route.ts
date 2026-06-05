import { NextRequest, NextResponse } from "next/server";

const UNAVAILABLE_ANSWER = "Ask ACE is temporarily unavailable because the live AI service could not be reached. I’m not going to show a fallback betting read that could be mistaken for real analysis.";

export async function POST(req: NextRequest) {
  const { question } = await req.json();
  if (!question?.trim()) {
    return NextResponse.json({ error: "No question provided" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ answer: UNAVAILABLE_ANSWER, unavailable: true }, { status: 503 });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system:
          "You are ACE, a sharp sports betting intelligence assistant. You give concise, confident analysis on betting markets, line movement, edges, and parlay construction. Keep answers under 3 sentences unless detail is essential. Never recommend chasing losses or irresponsible gambling. Always remind users to bet responsibly.",
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Anthropic API error:", err);
      return NextResponse.json({ answer: UNAVAILABLE_ANSWER, unavailable: true }, { status: 503 });
    }

    const data = await res.json();
    const answer = data.content?.[0]?.text;
    if (!answer) {
      return NextResponse.json({ answer: UNAVAILABLE_ANSWER, unavailable: true }, { status: 503 });
    }
    return NextResponse.json({ answer });
  } catch (e) {
    console.error("ask-ace error:", e);
    return NextResponse.json({ answer: UNAVAILABLE_ANSWER, unavailable: true }, { status: 503 });
  }
}
