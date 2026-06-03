import { createInditexFetcher, UpstreamBlockError } from "./inditex-base.js";

// Bershka URL format: /pt/product-name-c0p180124680.html?colorId=250
const LOCALE_MAP = {
  pt: "pt-PT", es: "es-ES", uk: "en-GB", de: "de-DE",
  fr: "fr-FR", it: "it-IT", ww: "en-US",
};

const parseProductUrl = (productUrl) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(productUrl);
  } catch {
    const error = new TypeError("The provided URL is invalid.");
    error.name = "InvalidUrlError";
    throw error;
  }

  // Matches c0p followed by digits before .html
  const productIdMatch = parsedUrl.pathname.match(/c0p(\d+)\.html/i);
  if (!productIdMatch) {
    const error = new TypeError("Unable to extract product ID from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const productId = productIdMatch[1];
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const country = pathSegments[0] || "ww";
  const locale = LOCALE_MAP[country] || "en-US";

  // Keep colorId if present — it selects the specific color variant
  const colorId = parsedUrl.searchParams.get("colorId");
  const cleanUrl = colorId
    ? `${parsedUrl.origin}${parsedUrl.pathname}?colorId=${colorId}`
    : `${parsedUrl.origin}${parsedUrl.pathname}`;

  return { productId, locale, market: country, country, lang: country, origin: parsedUrl.origin, productUrl: cleanUrl };
};

const fetchProductDetails = createInditexFetcher({
  brand: "Bershka",
  hostname: "www.bershka.com",
  cdnHostname: "static.bershka.net",
  cacheFile: "bershka-product-cache.json",
  profileKeyPrefix: "bershka",
  genericTitlePattern: /^bershka\b/i,
  parseProductUrl,
});

export { fetchProductDetails, UpstreamBlockError };
