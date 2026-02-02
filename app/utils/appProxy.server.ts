import crypto from "crypto";

export function verifyAppProxySignature(requestUrl: string, appSecret: string) {
  const url = new URL(requestUrl);

  const signature = url.searchParams.get("signature");
  if (!signature) return { ok: false as const, shop: null as string | null };

  const keys = Array.from(url.searchParams.keys())
    .filter((k) => k !== "signature")
    .sort();

  let message = "";
  for (const k of keys) {
    message += `${k}=${url.searchParams.get(k) ?? ""}`;
  }

  const digest = crypto.createHmac("sha256", appSecret).update(message).digest("hex");

  const ok =
    digest.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(signature, "utf8"));

  const shop = url.searchParams.get("shop");
  return { ok, shop };
}
