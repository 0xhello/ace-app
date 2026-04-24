import { NextRequest, NextResponse } from "next/server";

const DEMO_RESPONSES: Record<string, string> = {
  default: "I'm analyzing the current board for high-confidence edges. Based on line movement and sharp action indicators, the best value right now appears to be on totals where the market hasn't fully adjusted to recent injuries. Look for unders in games with key offensive players listed questionable.",
  parlay: "For parlay construction, I'd focus on correlated legs — pair a team ML with the game going over if that team is a high-scoring favorite. Avoid mixing unrelated legs as the implied probability compounds against you quickly.",
  value: "Value betting means finding lines where your estimated probability exceeds the implied odds. A -110 line implies ~52.4% win probability. If you think a team wins 58% of the time, that's a +EV bet worth tracking over time.",
  sharp: "Sharp money moves are detected when line movement goes opposite to public betting percentages. When 70% of tickets are on one side but the line moves the other way, that's a sign books are respecting big-money action on the other side.",
};

function demoResponse(question: string): string {
  const q = question.toLowerCase();
  if (q.includes("parlay")) return DEMO_RESPONSES.parlay;
  if (q.includes("value") || q.includes("ev") || q.includes("edge")) return DEMO_RESPONSES.value;
  if (q.includes("sharp") || q.includes("line movement")) return DEMO_RESPONSES.sharp;
  return DEMO_RESPONSES.default;
}

export async function POST(req: NextRequest) {
  const { question } = await req.json();
  if (!question?.trim()) {
    return NextResponse.json({ error: "No question provided" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ answer: demoResponse(question), demo: true });
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
      return NextResponse.json({ answer: demoResponse(question), demo: true });
    }

    const data = await res.json();
    const answer = data.content?.[0]?.text ?? demoResponse(question);
    return NextResponse.json({ answer });
  } catch (e) {
    console.error("ask-ace error:", e);
    return NextResponse.json({ answer: demoResponse(question), demo: true });
  }
}
