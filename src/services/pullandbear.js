import { createInditexFetcher, UpstreamBlockError } from "./inditex-base.js";

// Pull&Bear URL format: /pt/slug-l03232500?cS=500&pelement=745302586
// Unlike Zara there is no lang segment and the product ref is -l{digits}
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

  // Matches -l followed by digits at the end of the last path segment
  const productIdMatch = parsedUrl.pathname.match(/-l(\d+)/i);
  if (!productIdMatch) {
    const error = new TypeError("Unable to extract product ID from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const productId = productIdMatch[1];
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const country = pathSegments[0] || "ww";
  const locale = LOCALE_MAP[country] || "en-US";

  // Keep cS param if present (it controls color/variant on the page)
  const cS = parsedUrl.searchParams.get("cS");
  const cleanUrl = cS
    ? `${parsedUrl.origin}${parsedUrl.pathname}?cS=${cS}`
    : `${parsedUrl.origin}${parsedUrl.pathname}`;

  return { productId, locale, market: country, country, lang: country, origin: parsedUrl.origin, productUrl: cleanUrl };
};

const fetchProductDetails = createInditexFetcher({
  brand: "Pull&Bear",
  hostname: "www.pullandbear.com",
  cdnHostname: "static.pullandbear.net",
  cacheFile: "pullandbear-product-cache.json",
  profileKeyPrefix: "pullandbear",
  genericTitlePattern: /^pull\s*&?\s*bear\b/i,
  parseProductUrl,
  selectors: {
    // Pull&Bear shares the Inditex platform but may have slightly different class names.
    // Keeping Zara defaults and adding generic fallbacks via the DOM fallback broadening.
    addToCart: "[data-qa-action='add-to-cart'], button[class*='add-to-cart'], button[class*='addToCart']",
  },
});

export { fetchProductDetails, UpstreamBlockError };
