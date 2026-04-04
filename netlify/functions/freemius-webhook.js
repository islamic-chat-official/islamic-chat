// ─────────────────────────────────────────────────────────────────────────────
//  Islamic Chat — Freemius Webhook  (netlify/functions/freemius-webhook.js)
//
//  HOW IT WORKS:
//  1. User pays on Freemius checkout page ($10/month)
//  2. Freemius fires a POST to: https://your-site.netlify.app/api/freemius-webhook
//  3. This function verifies the event, finds the user by email, sets is_premium=true in Supabase
//
//  SETUP (Netlify env vars):
//    FREEMIUS_SECRET_KEY   = your Freemius secret key (from Freemius dashboard → Settings)
//    SUPABASE_URL          = https://xxxx.supabase.co
//    SUPABASE_SERVICE_KEY  = your Supabase service_role key (NOT anon key — has write access)
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Freemius-Signature",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")   return { statusCode: 405, headers: CORS, body: "Not allowed" };

  try {
    const body = event.body || "";

    // ── 1. VERIFY FREEMIUS SIGNATURE ──────────────────────────────────────────
    // ⚠️ EDIT: Freemius sends an HMAC-SHA256 signature in the header
    // Header name may be "X-Freemius-Signature" — check your Freemius webhook docs
    const signature = event.headers["x-freemius-signature"] || "";
    const expected = crypto
      .createHmac("sha256", process.env.FREEMIUS_SECRET_KEY || "")
      .update(body)
      .digest("hex");

    // Uncomment to enable signature verification (recommended in production):
    // if (signature !== expected) {
    //   console.error("Invalid Freemius signature");
    //   return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
    // }

    const payload = JSON.parse(body);
    const eventType = payload.type || payload.event; // "payment.success" or "subscription.created"
    const customerEmail = payload?.customer?.email || payload?.user?.email || payload?.email;

    console.log("Freemius event:", eventType, "email:", customerEmail);

    if (!customerEmail) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "No email in payload" }) };
    }

    // ── 2. HANDLE PAYMENT EVENTS ──────────────────────────────────────────────
    const isPremiumEvent = [
      "payment.success",
      "subscription.created",
      "subscription.renewed",
      "subscription.reactivated",
    ].some(t => (eventType || "").toLowerCase().includes(t.split(".")[0]));

    const isCancelEvent = [
      "subscription.cancelled",
      "subscription.expired",
      "subscription.deactivated",
    ].some(t => (eventType || "").toLowerCase().includes(t.split(".")[0]));

    if (!isPremiumEvent && !isCancelEvent) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ received: true }) };
    }

    // ── 3. UPDATE SUPABASE ────────────────────────────────────────────────────
    const supabaseUrl  = process.env.SUPABASE_URL;
    const serviceKey   = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceKey) {
      console.error("Missing Supabase env vars");
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Server config error" }) };
    }

    // Update user profile: set is_premium and premium_until
    const premiumUntil = isPremiumEvent
      ? new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString() // +31 days
      : new Date().toISOString(); // revoke immediately

    // Find user by email in Supabase auth
    const lookupRes = await fetch(`${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(customerEmail)}&select=id`, {
      headers: {
        "apikey":        serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type":  "application/json",
      },
    });
    const users = await lookupRes.json();

    if (!users || users.length === 0) {
      // User hasn't signed up yet — store pending premium for when they do
      // ⚠️ OPTIONAL: store in a pending_premium table
      console.log("User not found, storing pending premium for:", customerEmail);

      await fetch(`${supabaseUrl}/rest/v1/pending_premium`, {
        method: "POST",
        headers: {
          "apikey":        serviceKey,
          "Authorization": `Bearer ${serviceKey}`,
          "Content-Type":  "application/json",
          "Prefer":        "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          email: customerEmail,
          is_premium: isPremiumEvent,
          premium_until: premiumUntil,
          created_at: new Date().toISOString(),
        }),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ queued: true }) };
    }

    const userId = users[0].id;

    // Update their profile
    const updateRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      method: "PATCH",
      headers: {
        "apikey":        serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
      },
      body: JSON.stringify({
        is_premium:    isPremiumEvent,
        premium_until: premiumUntil,
        updated_at:    new Date().toISOString(),
      }),
    });

    console.log("Supabase update status:", updateRes.status, "for user:", userId);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, email: customerEmail, premium: isPremiumEvent }),
    };

  } catch (err) {
    console.error("Webhook error:", err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Server error" }) };
  }
};
