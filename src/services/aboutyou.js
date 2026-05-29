import fs from "fs/promises";
import path from "path";
import { config, resolveProjectPath } from "../config.js";
import { withPage } from "./browser.js";
import {
  getAttemptPlan,
  getProxyMetrics,
  recordCandidateFailure,
  recordCandidateSuccess,
} from "./proxy-pool.js";

const BLOCK_URL_PATTERNS = [
  /\/error\b/i,
  /\/blocked\b/i,
  /\/challenge\b/i,
];

const BLOCK_TITLE_PATTERNS = [
  /just a moment/i,
  /access denied/i,
  /403 forbidden/i,
];

const GENERIC_TITLE_PATTERNS = [
  /^about you\b/i,
];

const MARKET_MAP = {
  "aboutyou.de": { market: "de", locale: "de-DE" },
  "aboutyou.at": { market: "at", locale: "de-AT" },
  "aboutyou.ch": { market: "ch", locale: "de-CH" },
  "aboutyou.com": { market: "com", locale: "en-US" },
  "aboutyou.pt": { market: "pt", locale: "pt-PT" },
  "aboutyou.es": { market: "es", locale: "es-ES" },
  "aboutyou.fr": { market: "fr", locale: "fr-FR" },
  "aboutyou.it": { market: "it", locale: "it-IT" },
  "aboutyou.pl": { market: "pl", locale: "pl-PL" },
  "aboutyou.nl": { market: "nl", locale: "nl-NL" },
  "aboutyou.be": { market: "be", locale: "fr-BE" },
  "aboutyou.ro": { market: "ro", locale: "ro-RO" },
  "aboutyou.cz": { market: "cz", locale: "cs-CZ" },
  "aboutyou.se": { market: "se", locale: "sv-SE" },
  "aboutyou.dk": { market: "dk", locale: "da-DK" },
  "aboutyou.fi": { market: "fi", locale: "fi-FI" },
  "aboutyou.sk": { market: "sk", locale: "sk-SK" },
  "aboutyou.hu": { market: "hu", locale: "hu-HU" },
};

const MARKET_CURRENCY = {
  de: "€", at: "€", ch: "CHF", com: "€", pt: "€",
  es: "€", fr: "€", it: "€", nl: "€", be: "€",
  ro: "lei", cz: "Kč", se: "kr", dk: "kr", fi: "€",
  pl: "zł", sk: "€", hu: "Ft",
};

const PRODUCT_CACHE_FILE = "aboutyou-product-cache.json";

export class UpstreamBlockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UpstreamBlockError";
    this.details = details;
  }
}

const createAttemptMetadata = (attempt) => ({
  attempt: attempt.attemptNumber,
  round: attempt.round,
  proxy: attempt.label,
  proxyTarget: attempt.proxyDisplay || null,
  sessionProfile: attempt.profileKey,
});

const firstNonEmpty = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }

  return null;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const uniqueBy = (values, getKey) => {
  const seen = new Set();

  return values.filter((value) => {
    const key = getKey(value);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const normalizeImageUrl = (value) => {
  if (!value || typeof value !== "string") {
    return null;
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (value.startsWith("http://")) {
    return `https://${value.slice("http://".length)}`;
  }

  return value;
};

const normalizeVariant = (variant) => {
  if (!variant || typeof variant !== "object") {
    return null;
  }

  return {
    sku: firstNonEmpty(variant.sku),
    size: firstNonEmpty(variant.size),
    color: firstNonEmpty(variant.color),
    price: firstNonEmpty(variant.price),
    availability: firstNonEmpty(variant.availability),
    url: firstNonEmpty(variant.url),
  };
};

const normalizeCentPrice = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 100) {
      return String(value / 100);
    }

    return String(value);
  }

  if (typeof value === "string" && value.trim()) {
    const num = Number(value.trim());

    if (Number.isFinite(num) && num > 100) {
      return String(num / 100);
    }

    return value.trim();
  }

  return null;
};

const buildAboutYouImageUrl = (hash, width = 1000) => {
  if (!hash || typeof hash !== "string") {
    return null;
  }

  if (hash.startsWith("http")) {
    return hash.replace(/([?&]width=)\d+/, `$1${width}`);
  }

  return `https://cdn.aboutstatic.com/file/${hash}?quality=75&width=${width}`;
};

const formatPrice = (amount, market) => {
  if (!amount) return null;
  const symbol = MARKET_CURRENCY[market] || "€";
  const num = parseFloat(amount);
  if (isNaN(num)) return null;
  return ["ch", "uk"].includes(market)
    ? `${symbol} ${num.toFixed(2)}`
    : `${num.toFixed(2)} ${symbol}`;
};

const getProductCachePath = () => {
  const directoryPath = resolveProjectPath(config.sessionStateDir);
  return path.join(directoryPath, PRODUCT_CACHE_FILE);
};

const readProductCache = async () => {
  try {
    const raw = await fs.readFile(getProductCachePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeProductCacheEntry = async (productData) => {
  if (!productData?.productId) {
    return;
  }

  const cachePath = getProductCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const cache = await readProductCache();
  cache[productData.productId] = {
    ...productData,
    cachedAt: new Date().toISOString(),
  };

  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
};

const buildCachedResponse = (cachedData, productContext, attempts, failureHistory) => ({
  ...cachedData,
  url: productContext.productUrl,
  market: productContext.market,
  sourceChain: unique([...(cachedData.sourceChain || []), "local-cache"]),
  antiBot: {
    attempt: null,
    round: null,
    proxy: null,
    proxyTarget: null,
    sessionProfile: null,
    totalAttempts: attempts.length,
    attemptsTried: attempts.length,
    attemptHistory: failureHistory,
    proxyMetrics: getProxyMetrics(),
    cacheHit: true,
  },
});

const parseProductUrl = (productUrl) => {
  let parsedUrl;

  try {
    parsedUrl = new URL(productUrl);
  } catch {
    const error = new TypeError("The provided URL is invalid.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const hostname = parsedUrl.hostname.replace(/^www\./, "");
  const marketEntry = MARKET_MAP[hostname];
  const { market, locale } = marketEntry || { market: "de", locale: "de-DE" };

  // URL format: /p/brand-name/product-slug-12345678 or /p/product-slug-12345678
  const idMatch = parsedUrl.pathname.match(/-(\d{6,})(?:[/?#]|$)/);

  if (!idMatch) {
    const error = new TypeError("Unable to extract product ID from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const productId = idMatch[1];
  const cleanPath = parsedUrl.pathname.replace(/\?.*$/, "");
  const cleanUrl = `${parsedUrl.origin}${cleanPath}`;

  return {
    productId,
    locale,
    market,
    origin: parsedUrl.origin,
    productUrl: cleanUrl,
  };
};

const buildAcceptLanguage = (locale) => {
  const [lang, region] = locale.split("-");

  if (region) {
    return `${locale},${lang};q=0.9,en;q=0.8`;
  }

  return `${locale};q=0.9,en;q=0.8`;
};

const buildAttempts = (productContext) => {
  return getAttemptPlan(config.retryAttempts).map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey:
      candidate.label === "direct"
        ? `aboutyou-${productContext.market}-direct`
        : `aboutyou-${productContext.market}-${candidate.label}`,
  }));
};

// ─── Network collector ────────────────────────────────────────────────────────

const attachNetworkCollector = (page) => {
  const payloads = [];

  const handler = async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] || "";

    if (!contentType.includes("application/json")) return;
    // Capture About You API and Next.js ISR JSON files
    if (!url.includes("aboutyou") && !url.includes("aboutstatic") && !url.includes("/_next/data/")) return;

    try {
      const body = await response.json();
      if (body && typeof body === "object") {
        payloads.push({ url, payload: body });
      }
    } catch {
      // malformed JSON — skip
    }
  };

  page.on("response", handler);

  return {
    getPayloads: () => payloads,
    detach: () => page.off("response", handler),
  };
};

const findColorsInNetworkPayload = (payload, depth = 0) => {
  if (!payload || typeof payload !== "object" || depth > 8) return null;

  // Look for known About You color-variant keys
  const colorKeys = ["colorVariations", "colorVariants", "colorOptions", "linkedProducts", "relatedProducts"];
  for (const key of colorKeys) {
    if (Array.isArray(payload[key]) && payload[key].length > 0) {
      return payload[key];
    }
  }

  for (const value of Object.values(payload)) {
    if (value && typeof value === "object") {
      const result = findColorsInNetworkPayload(value, depth + 1);
      if (result) return result;
    }
  }

  return null;
};

const extractNetworkColorLayer = (payloads) => {
  for (const { payload } of payloads) {
    const colorVariants = findColorsInNetworkPayload(payload);

    if (!colorVariants || colorVariants.length === 0) continue;

    const colors = unique(
      colorVariants
        .map((v) =>
          firstNonEmpty(
            v?.colorLabel,
            v?.color?.label,
            v?.attributes?.color?.label,
            v?.name,
          )
        )
        .filter(Boolean)
    );

    if (colors.length > 0) {
      return {
        productId: null,
        title: null,
        brand: null,
        color: colors[0],
        colors,
        sizes: [],
        variants: [],
        price: { amount: null, formatted: null, retailAmount: null, retailFormatted: null, discountPercent: null },
        images: [],
        sourceStage: "network-colors",
      };
    }
  }

  return null;
};

// ─── Extraction layers ────────────────────────────────────────────────────────

const extractNextDataLayer = (html, productContext) => {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);

  if (!match) {
    return null;
  }

  let nextData;

  try {
    nextData = JSON.parse(match[1]);
  } catch {
    return null;
  }

  // About You places product in several possible paths
  const pageProps = nextData?.props?.pageProps;

  if (!pageProps) {
    return null;
  }

  const product =
    pageProps.product ||
    pageProps.data?.product ||
    pageProps.initialData?.product ||
    null;

  if (!product || typeof product !== "object") {
    return null;
  }

  const title = firstNonEmpty(product.name, product.displayName);
  const brand = firstNonEmpty(
    product.brand?.name,
    product.brandName,
    pageProps.brand?.name
  );

  // Color from attributes
  const colorAttr = product.attributes?.color || product.color;
  const color = firstNonEmpty(
    Array.isArray(colorAttr?.values) ? colorAttr.values[0]?.label : null,
    colorAttr?.label,
    typeof colorAttr === "string" ? colorAttr : null
  );

  // All color options
  const colorOptions = Array.isArray(product.variants)
    ? unique(
        product.variants
          .map((v) => {
            const c = v?.attributes?.color || v?.color;
            return firstNonEmpty(
              Array.isArray(c?.values) ? c.values[0]?.label : null,
              c?.label,
              typeof c === "string" ? c : null
            );
          })
          .filter(Boolean)
      )
    : color
    ? [color]
    : [];

  // Sizes from variants
  const sizes = unique(
    (product.variants || [])
      .map((v) => {
        const s = v?.attributes?.size || v?.size;
        return firstNonEmpty(
          Array.isArray(s?.values) ? s.values[0]?.label : null,
          s?.label,
          typeof s === "string" ? s : null
        );
      })
      .filter(Boolean)
  );

  // Variants
  const variants = uniqueBy(
    (product.variants || [])
      .map((v) => {
        const sizeAttr = v?.attributes?.size || v?.size;
        const colorAttrV = v?.attributes?.color || v?.color;
        const sizeLabel = firstNonEmpty(
          Array.isArray(sizeAttr?.values) ? sizeAttr.values[0]?.label : null,
          sizeAttr?.label,
          typeof sizeAttr === "string" ? sizeAttr : null
        );
        const colorLabel = firstNonEmpty(
          Array.isArray(colorAttrV?.values) ? colorAttrV.values[0]?.label : null,
          colorAttrV?.label,
          typeof colorAttrV === "string" ? colorAttrV : null,
          color
        );
        const rawPrice = v?.price?.withTax ?? v?.price?.value ?? v?.price;
        const priceAmount = normalizeCentPrice(rawPrice);
        const available = v?.quantity > 0 || v?.isAvailable !== false;

        return normalizeVariant({
          sku: firstNonEmpty(v?.id != null ? String(v.id) : null, v?.sku),
          size: sizeLabel,
          color: colorLabel,
          price: priceAmount,
          availability: available ? "InStock" : "OutOfStock",
          url: null,
        });
      })
      .filter(Boolean),
    (v) => v.sku || `${v.size}-${v.color}`
  );

  // Price — from cheapest variant or root price object
  const rootPrice =
    product.priceRange?.min ??
    product.price?.withTax ??
    product.price?.value ??
    (variants.length > 0
      ? Math.min(...variants.map((v) => parseFloat(v.price || "0")).filter((n) => !isNaN(n) && n > 0)) || null
      : null);
  const priceAmount = normalizeCentPrice(rootPrice);

  const retailRaw = product.priceRange?.max ?? product.originalPrice?.withTax ?? product.originalPrice?.value ?? null;
  const retailAmount = normalizeCentPrice(retailRaw);

  // Images — prefer hash-based CDN URLs
  const images = unique(
    (product.images || product.media || [])
      .map((img) => {
        if (!img) return null;
        const hash = img.hash || img.id || img.url;
        return buildAboutYouImageUrl(hash);
      })
      .filter(Boolean)
  );

  if (!title && images.length === 0 && !priceAmount) {
    return null;
  }

  return {
    productId: productContext.productId,
    title,
    brand,
    color,
    colors: colorOptions,
    sizes,
    variants,
    price: {
      amount: priceAmount,
      formatted: formatPrice(priceAmount, productContext.market),
      retailAmount,
      retailFormatted: formatPrice(retailAmount, productContext.market),
      discountPercent: null,
    },
    images,
    sourceStage: "next-data",
  };
};

const parseJsonLdBlocks = (html) => {
  const blocks = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    const source = match[1]?.trim();

    if (!source) {
      continue;
    }

    try {
      blocks.push(JSON.parse(source));
    } catch {
      continue;
    }
  }

  return blocks;
};

const findProductJsonLd = (blocks) => {
  const queue = [...blocks];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (current["@type"] === "ProductGroup" || current["@type"] === "Product") {
      return current;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
};

const extractJsonLdLayer = (html, market) => {
  const jsonLdBlocks = parseJsonLdBlocks(html);
  const product = findProductJsonLd(jsonLdBlocks);

  if (!product) {
    return null;
  }

  const firstVariant = Array.isArray(product.hasVariant) ? product.hasVariant[0] : null;
  const variantOffer = firstVariant?.offers;
  const variants = Array.isArray(product.hasVariant)
    ? uniqueBy(
        product.hasVariant
          .filter((variant) => variant.color || variant.size || variant.sku || variant.offers?.sku)
          .map((variant) =>
            normalizeVariant({
              sku: variant.sku ?? variant.offers?.sku,
              size: variant.size,
              color: variant.color || product.color,
              price: variant.offers?.price != null ? String(variant.offers.price) : null,
              availability: variant.offers?.availability,
              url: variant.offers?.url,
            })
          )
          .filter(Boolean),
        (variant) => variant.sku || `${variant.size}-${variant.color}`
      )
    : [];

  const priceAmount = firstNonEmpty(
    variantOffer?.price != null ? String(variantOffer.price) : null,
    product.offers?.price != null ? String(product.offers.price) : null
  );

  const variantColors = unique(variants.map((v) => v.color).filter(Boolean));
  const derivedColor = firstNonEmpty(product.color, variantColors[0] ?? null);

  // Paths to other color variant products (entries with only url, no color/size data)
  const seenColorIds = new Set();
  const colorVariantPaths = Array.isArray(product.hasVariant)
    ? product.hasVariant
        .filter((v) => v.url && !v.color && !v.size)
        .reduce((acc, v) => {
          try {
            const path = new URL(v.url).pathname;
            const idMatch = path.match(/-(\d{5,})/);
            if (idMatch && !seenColorIds.has(idMatch[1])) {
              seenColorIds.add(idMatch[1]);
              acc.push(path);
            }
          } catch { /* skip malformed URLs */ }
          return acc;
        }, [])
    : [];

  return {
    productId: null,
    title: firstNonEmpty(product.name, firstVariant?.name),
    brand: firstNonEmpty(product.brand?.name),
    color: derivedColor,
    colors: variantColors.length > 0 ? variantColors : unique([product.color].filter(Boolean)),
    sizes: unique(variants.map((v) => v.size)),
    variants,
    price: {
      amount: priceAmount,
      formatted: formatPrice(priceAmount, market),
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
    images: unique(
      (Array.isArray(product.image) ? product.image : [product.image])
        .filter(Boolean)
        .map(normalizeImageUrl)
        .filter(Boolean)
    ),
    sourceStage: "json-ld",
    colorVariantPaths,
  };
};

const extractDomFallback = async (page) => {
  try {
    const domData = await page.evaluate(() => {
      const compact = (value) =>
        typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      const unique = (values) => [...new Set(values.filter(Boolean))];
      const normalizeUrl = (value) => {
        if (!value || typeof value !== "string") return null;
        if (value.startsWith("//")) return `https:${value}`;
        if (value.startsWith("http://")) return `https://${value.slice(7)}`;
        return value;
      };

      // Title
      const titleEl =
        document.querySelector("h1[data-testid='product-name']") ||
        document.querySelector("h1[class*='ProductName']") ||
        document.querySelector("h1[class*='productName']") ||
        document.querySelector("h1[class*='product-name']") ||
        document.querySelector("h1");
      const title = titleEl ? compact(titleEl.textContent) : null;

      // Brand
      const brandEl =
        document.querySelector("[data-testid='brand-name']") ||
        document.querySelector("[class*='BrandName']") ||
        document.querySelector("[class*='brandName']") ||
        document.querySelector("a[class*='brand']");
      const brand = brandEl ? compact(brandEl.textContent) : null;

      // Price
      const priceEl =
        document.querySelector("[data-testid='price']") ||
        document.querySelector("[class*='Price_sale']") ||
        document.querySelector("[class*='price_sale']") ||
        document.querySelector("[class*='currentPrice']") ||
        document.querySelector("[class*='salePrice']");
      const priceText = priceEl ? compact(priceEl.textContent) : null;
      const priceMatch = priceText ? priceText.match(/[\d.,]+/) : null;
      const priceAmount = priceMatch ? priceMatch[0].replace(/,(?=\d{3})/g, "") : null;

      // Retail price (struck-through)
      const retailEl =
        document.querySelector("[data-testid='original-price']") ||
        document.querySelector("[class*='Price_base']") ||
        document.querySelector("s[class*='price']") ||
        document.querySelector("del[class*='price']");
      const retailText = retailEl ? compact(retailEl.textContent) : null;
      const retailMatch = retailText ? retailText.match(/[\d.,]+/) : null;
      const retailAmount = retailMatch ? retailMatch[0].replace(/,(?=\d{3})/g, "") : null;

      // ── Color extraction ──────────────────────────────────────────────────
      // On About You each color variant is a SEPARATE product linked by <a href="/p/...">
      // swatches in the color picker. Nav/header buttons link to /cart, /wishlist, etc.
      // Filtering by product-URL href isolates only color swatches.
      const productUrlPattern = /\/p\/[^/?#]+-\d{5,}/;
      const colorSwatchLinks = Array.from(
        document.querySelectorAll("a[aria-label][href]")
      ).filter((el) => productUrlPattern.test(el.getAttribute("href") || ""));

      const looksLikeColorName = (text) => {
        if (!text || text.length < 2 || text.length > 40) return false;
        if (/^(XS|S|M|L|XL|XXL|XXXL|\d+XL|\d{2,3}|\d+\/\d+)$/i.test(text)) return false;
        if (/^\d+$/.test(text)) return false;
        return true;
      };

      const allColors = unique(
        colorSwatchLinks
          .map((el) => compact(el.getAttribute("aria-label")))
          .filter(looksLikeColorName)
      );

      // Selected color: swatch whose href matches the current product ID
      const currentPath = window.location.pathname;
      const currentSwatchEl = colorSwatchLinks.find((el) => {
        const href = el.getAttribute("href") || "";
        return currentPath.endsWith(href.split("?")[0]) || href.includes(currentPath.split("/").pop());
      });
      const color = currentSwatchEl
        ? compact(currentSwatchEl.getAttribute("aria-label"))
        : allColors[0] || null;

      const colors = allColors.length > 0 ? allColors : (color ? [color] : []);

      // Sizes
      const sizeEls = Array.from(
        document.querySelectorAll(
          [
            "button[data-testid='size-button']",
            "[data-testid='size-option']",
            "[class*='SizeButton']",
            "[class*='sizeButton']",
            "button[class*='size']",
          ].join(", ")
        )
      );
      const looksLikeSize = (text) =>
        Boolean(text) && text.length <= 15 && !/[a-z]{5,}\s[a-z]{4,}/i.test(text);
      const sizes = unique(
        sizeEls
          .map((el) => compact(el.getAttribute("aria-label") || el.textContent))
          .filter(looksLikeSize)
      );

      // Images
      const imgEls = Array.from(
        document.querySelectorAll(
          [
            "[data-testid='product-image'] img",
            "[class*='ProductImage'] img",
            "[class*='productImage'] img",
            "[class*='gallery'] img[src*='aboutstatic']",
            "img[src*='aboutstatic.com']",
            "img[src*='cdn.aboutstatic']",
          ].join(", ")
        )
      );
      const images = unique(
        imgEls
          .map((el) => normalizeUrl(el.getAttribute("src") || el.getAttribute("data-src")))
          .filter((url) => url && url.includes("aboutstatic"))
          .map((url) => url.replace(/([?&]width=)\d+/, "$11000"))
      ).slice(0, 10);

      if (!title && !priceAmount && images.length === 0) {
        return null;
      }

      return {
        title,
        brand,
        color,
        colors,
        sizes,
        images,
        price: {
          amount: priceAmount,
          formatted: priceText,
          retailAmount,
          retailFormatted: retailText,
          discountPercent: null,
        },
      };
    });

    if (!domData) {
      return null;
    }

    return {
      ...domData,
      productId: null,
      variants: [],
      sourceStage: "dom-live",
    };
  } catch {
    return null;
  }
};

// ─── Color variant fetcher ────────────────────────────────────────────────────

// About You has each color as a separate product. The JSON-LD ProductGroup lists
// the other color products by URL only (no color name). We fetch their page titles
// in parallel to extract the color name — titles follow "Product em Color | ABOUT YOU".
const fetchVariantColorNames = async (paths, origin, acceptLanguage) => {
  if (paths.length === 0) return [];

  const extractColorFromTitle = (titleText) => {
    if (!titleText) return null;
    // Handles PT "em", DE/IT/NL "in", ES/FR "en", PL skip (pattern won't match)
    const m = titleText.match(/\s+(?:em|in|en|na)\s+([^|]+?)\s*\|/i);
    return m ? m[1].trim().toLowerCase() : null;
  };

  const results = await Promise.allSettled(
    paths.map(async (path) => {
      try {
        const res = await fetch(`${origin}${path}`, {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": acceptLanguage,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(12000),
          redirect: "follow",
        });
        if (!res.ok) return null;
        const html = await res.text();
        const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        return extractColorFromTitle(m?.[1] ?? null);
      } catch {
        return null;
      }
    })
  );

  return unique(
    results
      .filter((r) => r.status === "fulfilled" && r.value)
      .map((r) => r.value)
  );
};

// ─── Merge ────────────────────────────────────────────────────────────────────

const isGenericTitle = (title) => {
  if (!title || typeof title !== "string") {
    return true;
  }

  return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(title.trim()));
};

const isBlocked = (url, pageTitle) => {
  if (BLOCK_URL_PATTERNS.some((p) => p.test(url || ""))) {
    return true;
  }

  if (BLOCK_TITLE_PATTERNS.some((p) => p.test(pageTitle || ""))) {
    return true;
  }

  return false;
};

const hasUsefulProductData = (data) => {
  return Boolean(
    data.price.amount ||
      data.images.length > 0 ||
      (data.title && !isGenericTitle(data.title))
  );
};

const mergeProductData = (productContext, layers) => {
  const sourceChain = [];
  const merged = {
    productId: productContext.productId,
    title: null,
    brand: null,
    color: null,
    colors: [],
    sizes: [],
    variants: [],
    price: {
      amount: null,
      formatted: null,
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
    images: [],
    url: productContext.productUrl,
    market: productContext.market,
    sourceChain,
    fieldSources: {},
  };

  for (const layer of layers) {
    if (!layer) {
      continue;
    }

    if (layer.productId && !merged.productId) {
      merged.productId = layer.productId;
    }

    const previousTitle = merged.title;
    merged.title =
      merged.title && !isGenericTitle(merged.title)
        ? merged.title
        : firstNonEmpty(layer.title, merged.title);
    if (
      (!previousTitle || isGenericTitle(previousTitle)) &&
      merged.title &&
      layer.sourceStage &&
      !merged.fieldSources.title
    ) {
      merged.fieldSources.title = layer.sourceStage;
    }

    const previousBrand = merged.brand;
    merged.brand = firstNonEmpty(merged.brand, layer.brand);
    if (!previousBrand && merged.brand && layer.sourceStage && !merged.fieldSources.brand) {
      merged.fieldSources.brand = layer.sourceStage;
    }

    const previousColor = merged.color;
    const shouldPreferDomColor = layer.sourceStage === "dom-live" && layer.color;
    merged.color = shouldPreferDomColor
      ? layer.color
      : firstNonEmpty(merged.color, layer.color);
    if (
      ((shouldPreferDomColor && merged.color) || (!previousColor && merged.color)) &&
      layer.sourceStage
    ) {
      merged.fieldSources.color = layer.sourceStage;
    }

    const previousColorsLength = merged.colors.length;
    merged.colors =
      layer.sourceStage === "dom-live" && (layer.colors || []).length > 0
        ? unique([...(layer.colors || []), ...merged.colors, layer.color])
        : unique([...merged.colors, ...(layer.colors || []), layer.color]);
    if (
      layer.sourceStage &&
      ((layer.sourceStage === "dom-live" && (layer.colors || []).length > 0) ||
        (merged.colors.length > previousColorsLength && !merged.fieldSources.colors))
    ) {
      merged.fieldSources.colors = layer.sourceStage;
    }

    const previousSizesLength = merged.sizes.length;
    if (!(layer.sourceStage === "dom-live" && merged.sizes.length > 0)) {
      merged.sizes = unique([...merged.sizes, ...(layer.sizes || [])]);
    }
    if (
      merged.sizes.length > previousSizesLength &&
      layer.sourceStage &&
      !merged.fieldSources.sizes
    ) {
      merged.fieldSources.sizes = layer.sourceStage;
    }

    const previousVariantsLength = merged.variants.length;
    merged.variants = uniqueBy(
      [...merged.variants, ...((layer.variants || []).map(normalizeVariant).filter(Boolean))],
      (variant) => variant.sku || `${variant.size}-${variant.color}`
    );
    if (
      merged.variants.length > previousVariantsLength &&
      layer.sourceStage &&
      !merged.fieldSources.variants
    ) {
      merged.fieldSources.variants = layer.sourceStage;
    }

    const previousPriceAmount = merged.price.amount;
    merged.price.amount = firstNonEmpty(merged.price.amount, layer.price?.amount);
    merged.price.formatted = firstNonEmpty(merged.price.formatted, layer.price?.formatted);
    merged.price.retailAmount = firstNonEmpty(
      merged.price.retailAmount,
      layer.price?.retailAmount
    );
    merged.price.retailFormatted = firstNonEmpty(
      merged.price.retailFormatted,
      layer.price?.retailFormatted
    );
    merged.price.discountPercent = firstNonEmpty(
      merged.price.discountPercent,
      layer.price?.discountPercent
    );
    if (
      !previousPriceAmount &&
      merged.price.amount &&
      layer.sourceStage &&
      !merged.fieldSources.price
    ) {
      merged.fieldSources.price = layer.sourceStage;
    }

    const previousImagesLength = merged.images.length;
    merged.images = unique([...merged.images, ...(layer.images || [])]);
    if (
      merged.images.length > previousImagesLength &&
      layer.sourceStage &&
      !merged.fieldSources.images
    ) {
      merged.fieldSources.images = layer.sourceStage;
    }

    if (layer.sourceStage) {
      sourceChain.push(layer.sourceStage);
    }
  }

  if (merged.color && merged.colors.length === 0) {
    merged.colors = [merged.color];
    if (!merged.fieldSources.colors && merged.fieldSources.color) {
      merged.fieldSources.colors = merged.fieldSources.color;
    }
  }

  // Derive color from first entry when only colors[] was populated
  if (!merged.color && merged.colors.length > 0) {
    merged.color = merged.colors[0];
    if (!merged.fieldSources.color && merged.fieldSources.colors) {
      merged.fieldSources.color = merged.fieldSources.colors;
    }
  }

  return merged;
};

// ─── Page helpers ─────────────────────────────────────────────────────────────

const prewarmSession = async (page, productContext) => {
  if (config.prewarmHomeMs <= 0) {
    return;
  }

  await page.goto(`${productContext.origin}/`, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });
  await page.waitForTimeout(config.prewarmHomeMs);
};

const readPageSnapshot = async (page) => {
  let lastError;

  for (let index = 0; index < 3; index += 1) {
    try {
      await page.waitForLoadState("domcontentloaded", {
        timeout: config.requestTimeoutMs,
      });

      return {
        pageTitle: await page.title(),
        html: await page.content(),
        currentUrl: page.url(),
      };
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }

  throw lastError;
};

const classifyAttemptError = (error) => {
  if (error instanceof UpstreamBlockError) {
    return {
      message: error.message,
      code: error.name,
      retryable: true,
    };
  }

  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Unknown candidate failure.";

  return {
    message,
    code: error?.name || "Error",
    retryable: true,
  };
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const fetchProductDetails = async (productUrl) => {
  const productContext = parseProductUrl(productUrl);
  const attempts = buildAttempts(productContext);
  const failureHistory = [];
  const cachedProducts = await readProductCache();

  for (const attempt of attempts) {
    try {
      const merged = await withPage(
        async (page) => {
          const collector = attachNetworkCollector(page);

          try {
            await prewarmSession(page, productContext);
            await page.goto(productContext.productUrl, {
              waitUntil: "domcontentloaded",
              timeout: config.navigationTimeoutMs,
            });
            await page.waitForTimeout(config.pageWaitMs);

            // Wait for the product heading as confirmation the SPA hydrated
            await page
              .waitForSelector("h1", { timeout: 8000 })
              .catch(() => {});

            const snapshot = await readPageSnapshot(page);

            if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
              throw new UpstreamBlockError(
                "About You blocked the request (challenge or error page)."
              );
            }

            const nextDataLayer = extractNextDataLayer(snapshot.html, productContext);
            const networkColorLayer = extractNetworkColorLayer(collector.getPayloads());
            const jsonLdLayer = extractJsonLdLayer(snapshot.html, productContext.market);
            const domLayer = await extractDomFallback(page);

            // Fetch color names from other color variant products listed in the JSON-LD
            const colorVariantPaths = jsonLdLayer?.colorVariantPaths ?? [];
            const extraColors = await fetchVariantColorNames(
              colorVariantPaths,
              productContext.origin,
              buildAcceptLanguage(productContext.locale)
            );

            const mergedData = mergeProductData(productContext, [nextDataLayer, networkColorLayer, jsonLdLayer, domLayer]);

            // Merge extra colors discovered from sibling variant pages
            if (extraColors.length > 0) {
              mergedData.colors = unique([...mergedData.colors, ...extraColors]);
              if (!mergedData.sourceChain.includes("color-variants")) {
                mergedData.sourceChain.push("color-variants");
              }
              mergedData.fieldSources.colors = "color-variants";
            }

            if (hasUsefulProductData(mergedData)) {
              return mergedData;
            }

            if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
              throw new UpstreamBlockError(
                "About You blocked the request (challenge or error page)."
              );
            }

            throw new UpstreamBlockError(
              "About You did not expose enough product data for this request."
            );
          } finally {
            collector.detach();
          }
        },
        {
          locale: productContext.locale,
          profileKey: attempt.profileKey,
          proxyUrl: attempt.proxyUrl,
          acceptLanguage: buildAcceptLanguage(productContext.locale),
        }
      );

      recordCandidateSuccess(attempt, { outcome: "product-data" });
      await writeProductCacheEntry(merged);

      return {
        ...merged,
        antiBot: {
          ...createAttemptMetadata(attempt),
          totalAttempts: attempts.length,
          attemptsTried: failureHistory.length + 1,
          attemptHistory: failureHistory,
          proxyMetrics: getProxyMetrics(),
        },
      };
    } catch (error) {
      const classifiedError = classifyAttemptError(error);

      failureHistory.push({
        ...createAttemptMetadata(attempt),
        message: classifiedError.message,
        code: classifiedError.code,
      });
      recordCandidateFailure(attempt, {
        outcome: classifiedError.code,
        error: classifiedError.message,
      });

      if (!classifiedError.retryable) {
        throw error;
      }
    }
  }

  if (cachedProducts[productContext.productId]) {
    return buildCachedResponse(
      cachedProducts[productContext.productId],
      productContext,
      attempts,
      failureHistory
    );
  }

  throw new UpstreamBlockError(
    `Unable to fetch product data after ${attempts.length} attempts.`,
    {
      attemptsTried: attempts.length,
      attemptHistory: failureHistory,
      proxyMetrics: getProxyMetrics(),
    }
  );
};
