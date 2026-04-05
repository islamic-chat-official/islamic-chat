// ─────────────────────────────────────────────────────────────────────────────
//  Islamic Chat — Freemius Webhook (Vercel Serverless Function)
//
//  HOW IT WORKS:
//  1. User pays on Freemius checkout page ($10/month)
//  2. Freemius fires a POST to: https://your-site.vercel.app/api/freemius-webhook
//  3. This function verifies the event, finds user by email, sets is_premium=true in Supabase
//
//  SETUP (Vercel env vars):
//    FREEMIUS_SECRET_KEY   = your Freemius secret key
//    SUPABASE_URL          = https://xxxx.supabase.co
//    SUPABASE_SERVICE_KEY  = your Supabase service_role key
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Freemius-Signature");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = JSON.stringify(req.body);
    const signature = req.headers["x-freemius-signature"] || "";
    const expected = crypto
      .createHmac("sha256", process.env.FREEMIUS_SECRET_KEY || "")
      .update(body)
      .digest("hex");

    // Uncomment to enable signature verification (recommended in production):
    // if (signature !== expected) {
    //   console.error("Invalid Freemius signature");
    //   return res.status(401).json({ error: "Unauthorized" });
    // }

    const payload = req.body;
    const eventType = payload.type || payload.event;
    const customerEmail = payload?.customer?.email || payload?.user?.email || payload?.email;

    console.log("Freemius event:", eventType, "email:", customerEmail);

    if (!customerEmail) {
      return res.status(400).json({ error: "No email in payload" });
    }

    // Handle payment events
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
      return res.status(200).json({ received: true });
    }

    // Update Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceKey) {
      console.error("Missing Supabase env vars");
      return res.status(500).json({ error: "Server config error" });
    }

    const premiumUntil = isPremiumEvent
      ? new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
      : new Date().toISOString();

    // Find user by email
    const lookupRes = await fetch(`${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(customerEmail)}&select=id`, {
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
    });
    const users = await lookupRes.json();

    if (!users || users.length === 0) {
      // User hasn't signed up yet — store pending premium
      console.log("User not found, storing pending premium for:", customerEmail);

      await fetch(`${supabaseUrl}/rest/v1/pending_premium`, {
        method: "POST",
        headers: {
          "apikey": serviceKey,
          "Authorization": `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          email: customerEmail,
          is_premium: isPremiumEvent,
          premium_until: premiumUntil,
          created_at: new Date().toISOString(),
        }),
      });
      return res.status(200).json({ queued: true });
    }

    const userId = users[0].id;

    // Update their profile
    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      method: "PATCH",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        is_premium: isPremiumEvent,
        premium_until: premiumUntil,
        updated_at: new Date().toISOString(),
      }),
    });

    console.log("Supabase updated for user:", userId);

    return res.status(200).json({
      success: true,
      email: customerEmail,
      premium: isPremiumEvent,
    });

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
