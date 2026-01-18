function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

async function randomToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formEncode(obj: Record<string, string>) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestPost({ request, env }: { request: Request; env: any }) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500);
  if (!env.APP_URL) return json({ error: "Missing APP_URL" }, 500);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const productId = String(body.productId ?? "");
  const quantity = Number(body.quantity ?? 1);
  const customerEmail = body.customerEmail ? String(body.customerEmail) : "";

  if (!productId) return json({ error: "productId required" }, 400);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    return json({ error: "quantity must be an integer 1..10" }, 400);
  }

  const product = await env.DB.prepare(
    "SELECT id,name,description,price_cents,currency FROM products WHERE id=? AND active=1"
  )
    .bind(productId)
    .first();

  if (!product) return json({ error: "Product not found" }, 404);

  const statusToken = await randomToken(24);

  // Stripe expects application/x-www-form-urlencoded
  // We use price_data so you don't need to create Stripe Products/Prices manually.
  const params: Record<string, string> = {
    "mode": "payment",
    "success_url": `${env.APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    "cancel_url": `${env.APP_URL}/index.html?canceled=1`,

    "line_items[0][quantity]": String(quantity),
    "line_items[0][price_data][currency]": String((product as any).currency ?? "usd"),
    "line_items[0][price_data][unit_amount]": String((product as any).price_cents),
    "line_items[0][price_data][product_data][name]": String((product as any).name),
    "line_items[0][price_data][product_data][description]": String((product as any).description),

    "metadata[product_id]": productId,
    "metadata[quantity]": String(quantity),
    "metadata[status_token]": statusToken,
  };

  if (customerEmail) params["customer_email"] = customerEmail;

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(params),
  });

  const data = await resp.json();
  if (!resp.ok) {
    return json({ error: "Stripe error", details: data }, 400);
  }

  return json({ checkoutUrl: data.url });
}
