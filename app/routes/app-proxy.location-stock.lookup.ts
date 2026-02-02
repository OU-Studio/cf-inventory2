import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyAppProxySignature } from "../utils/appProxy.server";

const ADMIN_API_VERSION = "2026-01"; // match your webhooks api_version or whichever you want
const ALLOW_ORIGIN = "*"; // with App Proxy, origin is your shop; you usually can omit CORS entirely

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Optional: App proxy calls are typically GET; you can implement loader for GET if you prefer.
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  return json({ error: "Method not allowed" }, 405);
}

// Prefer OFFLINE token; fallback newest (same as your existing code).
async function getShopAccessToken(shopDomain: string) {
  const offline = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    select: { accessToken: true },
  });
  if (offline?.accessToken) return offline.accessToken;

  const any = await prisma.session.findFirst({
    where: { shop: shopDomain },
    select: { accessToken: true },
    orderBy: { expires: "desc" },
  });
  return any?.accessToken ?? null;
}

function normalizeGid(id: string, kind: "Product" | "ProductVariant") {
  if (!id) return null;
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/${kind}/${id}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  // App proxy requests are commonly GET; but POST is fine too.
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { ok, shop } = verifyAppProxySignature(request.url, process.env.SHOPIFY_API_SECRET!);
  if (!ok || !shop) return json({ error: "Unauthorized" }, 401);

  const accessToken = await getShopAccessToken(shop);
  if (!accessToken) return json({ error: "Missing offline access token for shop" }, 500);

  const body = await request.json().catch(() => ({}));

  const productIdsIn = Array.isArray((body as any).productIds) ? (body as any).productIds : [];
  const variantIdsIn = Array.isArray((body as any).variantIds) ? (body as any).variantIds : [];

  const productIds = productIdsIn
    .map((id: string) => normalizeGid(String(id || ""), "Product"))
    .filter(Boolean);

  const variantIds = variantIdsIn
    .map((id: string) => normalizeGid(String(id || ""), "ProductVariant"))
    .filter(Boolean);

  if (!productIds.length && !variantIds.length) {
    return json({ productMap: {}, variantMap: {} }, 200, { "Access-Control-Allow-Origin": ALLOW_ORIGIN });
  }

  const gql = `#graphql
    query Lookup($productIds: [ID!]!, $variantIds: [ID!]!) {
      shop { currencyCode }

      products: nodes(ids: $productIds) {
        ... on Product {
          id
          title
          handle
          status
          totalInventory
          featuredImage { url altText }
        }
      }

      variants: nodes(ids: $variantIds) {
        ... on ProductVariant {
          id
          title
          sku
          product { id title handle }
          inventoryQuantity
        }
      }
    }
  `;

  const resp = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: gql, variables: { productIds, variantIds } }),
  });

  const payload: any = await resp.json().catch(() => null);
  if (!resp.ok) {
    return json(
      {
        error: "Admin API error",
        status: resp.status,
        shop,
        body: payload,
      },
      502
    );
  }

  if (payload?.errors?.length) {
    return json({ error: "GraphQL error", errors: payload.errors }, 400);
  }

  const productMap: Record<string, any> = {};
  const variantMap: Record<string, any> = {};

  const products = Array.isArray(payload?.data?.products) ? payload.data.products : [];
  const variants = Array.isArray(payload?.data?.variants) ? payload.data.variants : [];

  for (const p of products) if (p?.id) productMap[p.id] = p;
  for (const v of variants) if (v?.id) variantMap[v.id] = v;

  return json(
    { productMap, variantMap },
    200,
    { "Access-Control-Allow-Origin": ALLOW_ORIGIN }
  );
}
