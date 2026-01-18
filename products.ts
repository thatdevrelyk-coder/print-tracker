export async function onRequestGet({ env }: { env: any }) {
  const { results } = await env.DB.prepare(
    `SELECT id,name,description,price_cents,currency,image_url
     FROM products
     WHERE active=1
     ORDER BY created_at DESC`
  ).all();

  return new Response(JSON.stringify({ products: results }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
