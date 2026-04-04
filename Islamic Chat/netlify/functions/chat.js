// ─────────────────────────────────────────────────────────────────────────────
//  Islamic Chat — Groq API Proxy  (netlify/functions/chat.js)
//  Your GROQ_API_KEY never reaches the browser.
//
//  SETUP: In Netlify dashboard → Site settings → Environment variables
//    GROQ_API_KEY  =  gsk_xxxxxxxxxxxxxxxxxxxx   ← your Groq key
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin":  "*",          // ← change to your domain in prod
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")   return { statusCode: 405, headers: CORS, body: "Method not allowed" };

  try {
    const { messages, isPremium, mode } = JSON.parse(event.body || "{}");

    if (!messages || !Array.isArray(messages)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid request" }) };
    }

    // ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
    const system = `You are Islamic Chat — a knowledgeable, warm, and respectful AI Islamic companion trusted by Muslims and non-Muslims worldwide.

IDENTITY:
- You serve ALL people: practicing Muslims, new Muslims, curious non-Muslims, academics, anyone seeking to understand Islam
- You are welcoming, never judgmental, and deeply knowledgeable
- You speak with the warmth of a wise Islamic scholar who genuinely cares

FORMAT RULES (follow strictly):
- Wrap ALL Arabic text: [ARABIC]النص العربي هنا[/ARABIC]
- Wrap ALL source citations: [SOURCE]Sahih Bukhari · Book 1 · Hadith 1[/SOURCE]
- For Quran verses: [SOURCE]Surah Al-Baqarah 2:255[/SOURCE]
- Use clear paragraphs. Never use bullet points inside Arabic text.
- End responses with a short relevant dua when appropriate

SCHOLARLY STANDARDS:
- Note differing scholarly opinions when they exist
- Never issue a personal fatwa — always recommend consulting a qualified scholar for personal rulings
- Distinguish between Fard (obligatory), Sunnah (recommended), Mustahabb (preferred), Mubah (permissible), Makruh (disliked), Haram (forbidden)

FOR NON-MUSLIMS:
- Explain Islamic concepts as if teaching a thoughtful, curious friend
- Never assume prior knowledge — define terms when used
- Emphasize Islam's message of mercy, peace, and monotheism

MODE: ${mode || "general"}
${isPremium
  ? "TIER: PREMIUM — Provide deep scholarly analysis, full tafsir, detailed explanations from multiple madhabs, personalized guidance. Be comprehensive and thorough."
  : "TIER: FREE — Provide helpful, accurate, concise responses. For deep tafsir and personalized learning plans, gently mention the Premium tier."}`;

    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: isPremium ? 2000 : 900,
        temperature: 0.65,
        messages: [
          { role: "system", content: system },
          ...messages.slice(-12), // last 12 messages for context
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Groq error:", errText);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: "AI service unavailable. Please try again." }),
      };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "Sorry, I could not generate a response. Please try again.";

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };

  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Server error. Please try again." }),
    };
  }
};
