import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyAppProxySignature } from "../utils/appProxy.server";

const ADMIN_API_VERSION = "2026-01";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

export async function loader({ request }: LoaderFunctionArgs) {
  const { ok, shop } = verifyAppProxySignature(request.url, process.env.SHOPIFY_API_SECRET!);
  if (!ok || !shop) return json({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);

  const productIdsIn = (url.searchParams.get("productIds") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const variantIdsIn = (url.searchParams.get("variantIds") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const productIds = productIdsIn
    .map((id) => normalizeGid(id, "Product"))
    .filter(Boolean) as string[];

  const variantIds = variantIdsIn
    .map((id) => normalizeGid(id, "ProductVariant"))
    .filter(Boolean) as string[];

  if (!productIds.length && !variantIds.length) {
    return json({ productMap: {}, variantMap: {} }, 200);
  }

  const accessToken = await getShopAccessToken(shop);
  if (!accessToken) return json({ error: "Missing offline access token for shop" }, 500);

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
        }
      }

      variants: nodes(ids: $variantIds) {
        ... on ProductVariant {
          id
          title
          sku
          inventoryQuantity
          product { id title handle }
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
    body: JSON.stringify({
      query: gql,
      variables: { productIds, variantIds },
    }),
  });

  const payload: any = await resp.json().catch(() => null);

  if (!resp.ok) {
    return json({ error: "Admin API error", status: resp.status, body: payload }, 502);
  }
  if (payload?.errors?.length) {
    return json({ error: "GraphQL error", errors: payload.errors }, 400);
  }

  const productMap: Record<string, any> = {};
  const variantMap: Record<string, any> = {};

  for (const p of payload.data.products ?? []) if (p?.id) productMap[p.id] = p;
  for (const v of payload.data.variants ?? []) if (v?.id) variantMap[v.id] = v;

  return json({ productMap, variantMap }, 200);
}
