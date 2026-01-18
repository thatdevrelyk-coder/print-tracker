function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function randId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function hmacSha256Hex(secret: string, msg: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  const bytes = new Uint8Array(sig);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function parseStripeSignatureHeader(sigHeader: string) {
  // Example: "t=1700000000,v1=abc...,v0=..."
  const parts = sigHeader.split(",").map((p) => p.trim());
  const out: Record<string, string[]> = {};
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (!k || !v) continue;
    out[k] = out[k] || [];
    out[k].push(v);
  }
  return {
    t: out["t"]?.[0] ?? "",
    v1: out["v1"] ?? [],
  };
}

export async function onRequestPost({ request, env }: { request: Request; env: any }) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, 500);

  const sigHeader = request.headers.get("stripe-signature");
  if (!sigHeader) return json({ error: "Missing stripe-signature header" }, 400);

  const raw = await request.text(); // IMPORTANT: must be raw string
  const { t, v1 } = parseStripeSignatureHeader(sigHeader);
  if (!t || v1.length === 0) return json({ error: "Invalid stripe-signature header" }, 400);

  // Stripe signs: `${timestamp}.${payload}`
  const signedPayload = `${t}.${raw}`;
  const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, signedPayload);

  const ok = v1.some((sig) => timingSafeEqual(sig, expected));
  if (!ok) return json({ error: "Signature verification failed" }, 400);

  const event = JSON.parse(raw);

  // Dedupe by event id
  const already = await env.DB.prepare("SELECT id FROM stripe_events_processed WHERE id=?")
    .bind(event.id)
    .first();
  if (already) return json({ received: true, deduped: true });

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;

    if (session?.payment_status !== "paid") {
      await env.DB.prepare("INSERT INTO stripe_events_processed (id) VALUES (?)").bind(event.id).run();
      return json({ received: true, ignored: "not_paid" });
    }

    const md = session.metadata || {};
    const productId = md.product_id;
    const quantity = parseInt(md.quantity || "1", 10);
    const statusToken = md.status_token;

    if (!productId || !statusToken) {
      return json({ error: "Missing required metadata on session" }, 400);
    }

    const orderId = randId("ord");
    const email =
      session.customer_details?.email ||
      session.customer_email ||
      "unknown@example.com";

    // Insert order (unique by checkout session id)
    try {
      await env.DB.prepare(
        `INSERT INTO orders
          (id, product_id, customer_email, quantity, status_current, status_token, stripe_checkout_session_id, stripe_payment_intent_id, paid_at)
         VALUES (?, ?, ?, ?, 'PAID', ?, ?, ?, datetime('now'))`
      )
        .bind(
          orderId,
          productId,
          email,
          quantity,
          statusToken,
          session.id,
          typeof session.payment_intent === "string" ? session.payment_intent : null
        )
        .run();

      await env.DB.prepare(
        `INSERT INTO order_status_events (id, order_id, status, note, created_by)
         VALUES (?, ?, 'PAID', 'Payment received', 'system')`
      )
        .bind(randId("evt"), orderId)
        .run();
    } catch (e) {
      // If session already exists, treat as idempotent success
    }
  }

  await env.DB.prepare("INSERT INTO stripe_events_processed (id) VALUES (?)")
    .bind(event.id)
    .run();

  return json({ received: true });
}
