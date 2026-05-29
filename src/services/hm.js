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
  /\/captcha\b/i,
];

const BLOCK_TITLE_PATTERNS = [
  /just a moment/i,
  /access denied/i,
  /403 forbidden/i,
  /robot/i,
];

const GENERIC_TITLE_PATTERNS = [
  /^h&m\b/i,
];

// H&M URL locale segment → market + locale
const MARKET_MAP = {
  pt_pt: { market: "pt", locale: "pt-PT" },
  en_gb: { market: "gb", locale: "en-GB" },
  en_us: { market: "us", locale: "en-US" },
  de_de: { market: "de", locale: "de-DE" },
  fr_fr: { market: "fr", locale: "fr-FR" },
  es_es: { market: "es", locale: "es-ES" },
  it_it: { market: "it", locale: "it-IT" },
  nl_nl: { market: "nl", locale: "nl-NL" },
  pl_pl: { market: "pl", locale: "pl-PL" },
  at_at: { market: "at", locale: "de-AT" },
  ch_de: { market: "ch", locale: "de-CH" },
  ch_fr: { market: "ch", locale: "fr-CH" },
  be_fr: { market: "be", locale: "fr-BE" },
  be_nl: { market: "be", locale: "nl-BE" },
  dk_da: { market: "dk", locale: "da-DK" },
  fi_fi: { market: "fi", locale: "fi-FI" },
  se_sv: { market: "se", locale: "sv-SE" },
  no_no: { market: "no", locale: "nb-NO" },
  ro_ro: { market: "ro", locale: "ro-RO" },
  cz_cs: { market: "cz", locale: "cs-CZ" },
  hu_hu: { market: "hu", locale: "hu-HU" },
  sk_sk: { market: "sk", locale: "sk-SK" },
};

const MARKET_CURRENCY = {
  pt: "€", de: "€", fr: "€", es: "€", it: "€", nl: "€",
  be: "€", at: "€", fi: "€", ro: "lei",
  gb: "£", no: "kr", se: "kr", dk: "kr",
  ch: "CHF", us: "$", pl: "zł", cz: "Kč", hu: "Ft", sk: "€",
};

const PRODUCT_CACHE_FILE = "hm-product-cache.json";

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
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const normalizeImageUrl = (value) => {
  if (!value || typeof value !== "string") return null;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://")) return `https://${value.slice(7)}`;
  return value;
};

const normalizeVariant = (variant) => {
  if (!variant || typeof variant !== "object") return null;
  return {
    sku: firstNonEmpty(variant.sku),
    size: firstNonEmpty(variant.size),
    color: firstNonEmpty(variant.color),
    price: firstNonEmpty(variant.price),
    availability: firstNonEmpty(variant.availability),
    url: firstNonEmpty(variant.url),
  };
};

const formatPrice = (amount, market) => {
  if (!amount) return null;
  const symbol = MARKET_CURRENCY[market] || "€";
  const num = parseFloat(amount);
  if (isNaN(num)) return null;
  return ["gb", "us"].includes(market)
    ? `${symbol}${num.toFixed(2)}`
    : `${num.toFixed(2)} ${symbol}`;
};

// ─── Cache ────────────────────────────────────────────────────────────────────

const getProductCachePath = () =>
  path.join(resolveProjectPath(config.sessionStateDir), PRODUCT_CACHE_FILE);

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
  if (!productData?.articleCode) return;
  const cachePath = getProductCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const cache = await readProductCache();
  cache[productData.articleCode] = { ...productData, cachedAt: new Date().toISOString() };
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
};

const buildCachedResponse = (cachedData, productContext, attempts, failureHistory) => ({
  ...cachedData,
  url: productContext.productUrl,
  market: productContext.market,
  sourceChain: unique([...(cachedData.sourceChain || []), "local-cache"]),
  antiBot: {
    attempt: null, round: null, proxy: null, proxyTarget: null, sessionProfile: null,
    totalAttempts: attempts.length,
    attemptsTried: attempts.length,
    attemptHistory: failureHistory,
    proxyMetrics: getProxyMetrics(),
    cacheHit: true,
  },
});

// ─── URL parsing ──────────────────────────────────────────────────────────────

const parseProductUrl = (productUrl) => {
  let parsedUrl;

  try {
    parsedUrl = new URL(productUrl);
  } catch {
    const error = new TypeError("The provided URL is invalid.");
    error.name = "InvalidUrlError";
    throw error;
  }

  // e.g. /pt_pt/productpage.1234567001.html
  const localeMatch = parsedUrl.pathname.match(/\/([a-z]{2}_[a-z]{2})\//i);
  const localeKey = localeMatch ? localeMatch[1].toLowerCase() : "en_gb";
  const { market, locale } = MARKET_MAP[localeKey] || { market: "gb", locale: "en-GB" };

  const articleMatch = parsedUrl.pathname.match(/productpage\.(\d+)\.html/i);
  if (!articleMatch) {
    const error = new TypeError("Unable to extract article code from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const articleCode = articleMatch[1];
  const cleanUrl = `${parsedUrl.origin}/${localeKey}/productpage.${articleCode}.html`;

  return {
    articleCode,
    locale,
    market,
    localeKey,
    origin: parsedUrl.origin,
    productUrl: cleanUrl,
  };
};

const buildAcceptLanguage = (locale) => {
  const [lang, region] = locale.split("-");
  return region ? `${locale},${lang};q=0.9,en;q=0.8` : `${locale};q=0.9,en;q=0.8`;
};

const buildAttempts = (productContext) =>
  getAttemptPlan(config.retryAttempts).map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey:
      candidate.label === "direct"
        ? `hm-${productContext.market}-direct`
        : `hm-${productContext.market}-${candidate.label}`,
  }));

// ─── Network collector ────────────────────────────────────────────────────────

const attachNetworkCollector = (page) => {
  const payloads = [];

  const handler = async (response) => {
    const url = response.url();
    const contentType = response.headers()["content-type"] || "";
    if (!contentType.includes("application/json")) return;
    if (!url.includes("hm.com") && !url.includes("hm-group")) return;

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
  return { getPayloads: () => payloads, detach: () => page.off("response", handler) };
};

// ─── Network layer extractor ──────────────────────────────────────────────────

const extractNetworkLayer = (payloads, productContext) => {
  for (const { payload } of payloads) {
    const result = tryParseHmApiPayload(payload, productContext);
    if (result) return result;
  }
  return null;
};

const tryParseHmApiPayload = (payload, productContext) => {
  if (!payload || typeof payload !== "object") return null;

  // H&M product API payload can be nested; walk top-level keys
  const candidates = [
    payload,
    payload.product,
    payload.data?.product,
    payload.entity,
  ].filter(Boolean);

  for (const p of candidates) {
    const result = parseHmProduct(p, productContext);
    if (result) return result;
  }

  return null;
};

const parseHmProduct = (p, productContext) => {
  if (!p || typeof p !== "object") return null;

  const name = firstNonEmpty(p.name, p.title, p.displayName);
  if (!name) return null;

  const brand = firstNonEmpty(p.brand?.name, p.brandName, "H&M");

  // Colors — H&M API exposes them as colors[], swatchColors[], or colorList[]
  const colorList = p.colors || p.swatchColors || p.colorList || p.articleColorGroups || [];
  const colors = unique(
    (Array.isArray(colorList) ? colorList : [])
      .map((c) => firstNonEmpty(c.text, c.colorName, c.name, c.label))
      .filter(Boolean)
  );

  // Current color
  const color = firstNonEmpty(
    p.color?.text,
    p.selectedColor,
    p.colorText,
    colors[0] ?? null
  );

  // Sizes & variants
  const variantList = p.variants || p.sizes || p.articleVariants || [];
  const sizes = unique(
    (Array.isArray(variantList) ? variantList : [])
      .map((v) => firstNonEmpty(v.sizeName, v.size, v.sizeText))
      .filter(Boolean)
  );

  const variants = uniqueBy(
    (Array.isArray(variantList) ? variantList : [])
      .map((v) =>
        normalizeVariant({
          sku: firstNonEmpty(v.variantCode, v.code, v.sku),
          size: firstNonEmpty(v.sizeName, v.size),
          color: firstNonEmpty(v.colorName, v.color, color),
          price: v.price?.value != null ? String(v.price.value) : null,
          availability: v.stockState === "IN_STOCK" || v.available === true
            ? "InStock"
            : v.stockState != null || v.available != null
            ? "OutOfStock"
            : null,
          url: null,
        })
      )
      .filter(Boolean),
    (v) => v.sku || `${v.size}-${v.color}`
  );

  // Price
  const rawPrice =
    p.whitePrice?.price ??
    p.price?.value ??
    p.price?.current?.value ??
    (variants.length > 0
      ? variants.map((v) => parseFloat(v.price || "0")).find((n) => !isNaN(n) && n > 0) ?? null
      : null);
  const priceAmount = rawPrice != null ? String(rawPrice) : null;

  const retailRaw = p.redPrice?.price ?? p.price?.original?.value ?? null;
  const retailAmount = retailRaw != null ? String(retailRaw) : null;

  // Images
  const imageList = p.images || p.galleryImages || p.productImages || [];
  const images = unique(
    (Array.isArray(imageList) ? imageList : [])
      .map((img) => {
        const raw = img.url || img.src || img.imageUrl || (typeof img === "string" ? img : null);
        return normalizeImageUrl(raw);
      })
      .filter(Boolean)
  );

  return {
    articleCode: productContext.articleCode,
    title: name,
    brand,
    color,
    colors: colors.length > 0 ? colors : (color ? [color] : []),
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
    sourceStage: "network-json",
  };
};

// ─── JSON-LD ──────────────────────────────────────────────────────────────────

const parseJsonLdBlocks = (html) => {
  const blocks = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const source = match[1]?.trim();
    if (!source) continue;
    try { blocks.push(JSON.parse(source)); } catch { continue; }
  }
  return blocks;
};

const findProductJsonLd = (blocks) => {
  const queue = [...blocks];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (Array.isArray(current)) { queue.push(...current); continue; }
    if (current["@type"] === "ProductGroup" || current["@type"] === "Product") return current;
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
};

const extractJsonLdLayer = (html, market) => {
  const product = findProductJsonLd(parseJsonLdBlocks(html));
  if (!product) return null;

  const firstVariant = Array.isArray(product.hasVariant) ? product.hasVariant[0] : null;
  const variants = Array.isArray(product.hasVariant)
    ? uniqueBy(
        product.hasVariant
          .filter((v) => v.color || v.size || v.sku)
          .map((v) =>
            normalizeVariant({
              sku: v.sku,
              size: v.size,
              color: v.color || product.color,
              price: v.offers?.price != null ? String(v.offers.price) : null,
              availability: v.offers?.availability,
              url: v.offers?.url,
            })
          )
          .filter(Boolean),
        (v) => v.sku || `${v.size}-${v.color}`
      )
    : [];

  const variantColors = unique(variants.map((v) => v.color).filter(Boolean));
  const derivedColor = firstNonEmpty(product.color, variantColors[0] ?? null);
  const priceAmount = firstNonEmpty(
    firstVariant?.offers?.price != null ? String(firstVariant.offers.price) : null,
    product.offers?.price != null ? String(product.offers.price) : null
  );

  return {
    articleCode: null,
    title: firstNonEmpty(product.name, firstVariant?.name),
    brand: firstNonEmpty(product.brand?.name, "H&M"),
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
  };
};

// ─── DOM fallback ─────────────────────────────────────────────────────────────

const extractDomFallback = async (page) => {
  try {
    const domData = await page.evaluate(() => {
      const compact = (v) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
      const unique = (arr) => [...new Set(arr.filter(Boolean))];
      const normalizeUrl = (v) => {
        if (!v || typeof v !== "string") return null;
        if (v.startsWith("//")) return `https:${v}`;
        if (v.startsWith("http://")) return `https://${v.slice(7)}`;
        return v;
      };

      // Title
      const titleEl =
        document.querySelector("h1[data-testid='product-name']") ||
        document.querySelector("h1.product-name") ||
        document.querySelector("h1.product-item-headline") ||
        document.querySelector("h1[class*='ProductName']") ||
        document.querySelector("h1");
      const title = titleEl ? compact(titleEl.textContent) : null;

      // Brand
      const brandEl =
        document.querySelector("[data-testid='brand-name']") ||
        document.querySelector(".product-item-brand") ||
        document.querySelector("[class*='ProductBrand']");
      const brand = brandEl ? compact(brandEl.textContent) : null;

      // Price
      const priceEl =
        document.querySelector("[data-testid='price']") ||
        document.querySelector(".product-item-price") ||
        document.querySelector("[class*='ProductPrice'] [class*='current']") ||
        document.querySelector("[class*='price-value']");
      const priceText = priceEl ? compact(priceEl.textContent) : null;
      const priceMatch = priceText ? priceText.match(/[\d.,]+/) : null;
      const priceAmount = priceMatch ? priceMatch[0].replace(/,(?=\d{3})/g, "") : null;

      // Retail price
      const retailEl =
        document.querySelector("[data-testid='original-price']") ||
        document.querySelector("[class*='ProductPrice'] s") ||
        document.querySelector("s[class*='price']") ||
        document.querySelector("del[class*='price']");
      const retailText = retailEl ? compact(retailEl.textContent) : null;
      const retailMatch = retailText ? retailText.match(/[\d.,]+/) : null;
      const retailAmount = retailMatch ? retailMatch[0].replace(/,(?=\d{3})/g, "") : null;

      // Color — H&M shows selected color as a label near the swatches
      const colorEl =
        document.querySelector("[data-testid='selected-color']") ||
        document.querySelector(".product-colors-header span") ||
        document.querySelector("[class*='ColorName']") ||
        document.querySelector("[class*='selectedColor']") ||
        document.querySelector("[class*='color-name']");
      const color = colorEl ? compact(colorEl.textContent.replace(/^cor[:\s]*/i, "")) : null;

      // All colors — H&M swatches have aria-label with color name
      const swatchEls = Array.from(
        document.querySelectorAll(
          [
            "[data-testid='color-swatch'][aria-label]",
            ".mini-swatch[aria-label]",
            "[class*='ColorSwatch'][aria-label]",
            "[class*='Swatch'][aria-label]",
            "li[class*='color'] [aria-label]",
            "ul[class*='color'] li a[aria-label]",
          ].join(", ")
        )
      );
      const looksLikeColor = (t) => t && t.length >= 2 && t.length <= 40 && !/^\d+$/.test(t);
      const allColors = unique(
        swatchEls.map((el) => compact(el.getAttribute("aria-label"))).filter(looksLikeColor)
      );
      const colors = allColors.length > 0 ? allColors : (color ? [color] : []);

      // Sizes
      const sizeEls = Array.from(
        document.querySelectorAll(
          [
            "[data-testid='size-selector'] button",
            "[data-testid='size-option']",
            ".size-selector-item",
            "[class*='SizeOption']",
            "ul[class*='size'] li button",
          ].join(", ")
        )
      ).filter((el) => !el.disabled || el.getAttribute("aria-disabled") !== "true");
      const looksLikeSize = (t) => t && t.length <= 15 && !/[a-z]{5,}\s[a-z]{4,}/i.test(t);
      const sizes = unique(
        sizeEls.map((el) => compact(el.getAttribute("aria-label") || el.textContent)).filter(looksLikeSize)
      );

      // Images — collect src + srcset + data-src across all gallery images
      const imgEls = Array.from(
        document.querySelectorAll(
          [
            "[data-testid='product-image'] img",
            ".product-gallery img",
            "img[src*='image.hm.com']",
            "img[src*='lp2.hm.com']",
            "img[data-src*='image.hm.com']",
            "[class*='ProductImage'] img",
            "[class*='productImage'] img",
            "[class*='gallery'] img",
          ].join(", ")
        )
      );
      const extractBestSrc = (el) => {
        // Pick highest-resolution from srcset if present
        const srcset = el.getAttribute("srcset") || el.getAttribute("data-srcset") || "";
        if (srcset) {
          const parts = srcset.split(",").map((s) => s.trim()).filter(Boolean);
          const last = parts[parts.length - 1]?.split(/\s+/)[0];
          if (last) return last;
        }
        return el.getAttribute("src") || el.getAttribute("data-src") || null;
      };
      const images = unique(
        imgEls
          .map((el) => normalizeUrl(extractBestSrc(el)))
          .filter((url) => url && (url.includes("image.hm.com") || url.includes("lp2.hm")))
          .map((url) => url.replace(/([?&]imwidth=)\d+/, "$12160"))
      ).slice(0, 12);

      if (!title && !priceAmount && images.length === 0) return null;

      return { title, brand, color, colors, sizes, images, price: { amount: priceAmount, formatted: priceText, retailAmount, retailFormatted: retailText, discountPercent: null } };
    });

    if (!domData) return null;

    return { ...domData, articleCode: null, variants: [], sourceStage: "dom-live" };
  } catch {
    return null;
  }
};

// Scan raw HTML for H&M image CDN URLs — works even when DOM lazy-loading hasn't fired
const extractImagesFromHtml = (html) => {
  const pattern = /https:\/\/image\.hm\.com\/assets\/hm\/[^"'\s\\]+\.(?:jpg|jpeg|webp|png)/gi;
  return unique(
    [...html.matchAll(pattern)]
      .map((m) => m[0].replace(/([?&]imwidth=)\d+/, "$12160"))
      .filter((url) => !url.includes("/thumbnail/") && !url.includes("/icon/"))
  ).slice(0, 12);
};

// ─── Merge ────────────────────────────────────────────────────────────────────

const isGenericTitle = (title) => {
  if (!title || typeof title !== "string") return true;
  return GENERIC_TITLE_PATTERNS.some((p) => p.test(title.trim()));
};

const isBlocked = (url, pageTitle) =>
  BLOCK_URL_PATTERNS.some((p) => p.test(url || "")) ||
  BLOCK_TITLE_PATTERNS.some((p) => p.test(pageTitle || ""));

const hasUsefulProductData = (data) =>
  Boolean(data.price.amount || data.images.length > 0 || (data.title && !isGenericTitle(data.title)));

const mergeProductData = (productContext, layers) => {
  const sourceChain = [];
  const merged = {
    articleCode: productContext.articleCode,
    title: null, brand: null, color: null,
    colors: [], sizes: [], variants: [],
    price: { amount: null, formatted: null, retailAmount: null, retailFormatted: null, discountPercent: null },
    images: [],
    url: productContext.productUrl,
    market: productContext.market,
    sourceChain,
    fieldSources: {},
  };

  for (const layer of layers) {
    if (!layer) continue;

    if (layer.articleCode && !merged.articleCode) merged.articleCode = layer.articleCode;

    const prevTitle = merged.title;
    merged.title = merged.title && !isGenericTitle(merged.title)
      ? merged.title
      : firstNonEmpty(layer.title, merged.title);
    if ((!prevTitle || isGenericTitle(prevTitle)) && merged.title && layer.sourceStage && !merged.fieldSources.title)
      merged.fieldSources.title = layer.sourceStage;

    const prevBrand = merged.brand;
    merged.brand = firstNonEmpty(merged.brand, layer.brand);
    if (!prevBrand && merged.brand && layer.sourceStage && !merged.fieldSources.brand)
      merged.fieldSources.brand = layer.sourceStage;

    const prevColor = merged.color;
    const domPreferred = layer.sourceStage === "dom-live" && layer.color;
    merged.color = domPreferred ? layer.color : firstNonEmpty(merged.color, layer.color);
    if (((domPreferred && merged.color) || (!prevColor && merged.color)) && layer.sourceStage)
      merged.fieldSources.color = layer.sourceStage;

    const prevColorsLen = merged.colors.length;
    merged.colors = layer.sourceStage === "dom-live" && (layer.colors || []).length > 0
      ? unique([...(layer.colors || []), ...merged.colors, layer.color])
      : unique([...merged.colors, ...(layer.colors || []), layer.color]);
    if (layer.sourceStage && (merged.colors.length > prevColorsLen || (layer.sourceStage === "dom-live" && (layer.colors || []).length > 0)) && !merged.fieldSources.colors)
      merged.fieldSources.colors = layer.sourceStage;

    const prevSizesLen = merged.sizes.length;
    if (!(layer.sourceStage === "dom-live" && merged.sizes.length > 0))
      merged.sizes = unique([...merged.sizes, ...(layer.sizes || [])]);
    if (merged.sizes.length > prevSizesLen && layer.sourceStage && !merged.fieldSources.sizes)
      merged.fieldSources.sizes = layer.sourceStage;

    const prevVariantsLen = merged.variants.length;
    merged.variants = uniqueBy(
      [...merged.variants, ...((layer.variants || []).map(normalizeVariant).filter(Boolean))],
      (v) => v.sku || `${v.size}-${v.color}`
    );
    if (merged.variants.length > prevVariantsLen && layer.sourceStage && !merged.fieldSources.variants)
      merged.fieldSources.variants = layer.sourceStage;

    const prevPrice = merged.price.amount;
    merged.price.amount = firstNonEmpty(merged.price.amount, layer.price?.amount);
    merged.price.formatted = firstNonEmpty(merged.price.formatted, layer.price?.formatted);
    merged.price.retailAmount = firstNonEmpty(merged.price.retailAmount, layer.price?.retailAmount);
    merged.price.retailFormatted = firstNonEmpty(merged.price.retailFormatted, layer.price?.retailFormatted);
    merged.price.discountPercent = firstNonEmpty(merged.price.discountPercent, layer.price?.discountPercent);
    if (!prevPrice && merged.price.amount && layer.sourceStage && !merged.fieldSources.price)
      merged.fieldSources.price = layer.sourceStage;

    const prevImagesLen = merged.images.length;
    merged.images = unique([...merged.images, ...(layer.images || [])]);
    if (merged.images.length > prevImagesLen && layer.sourceStage && !merged.fieldSources.images)
      merged.fieldSources.images = layer.sourceStage;

    if (layer.sourceStage) sourceChain.push(layer.sourceStage);
  }

  if (merged.color && merged.colors.length === 0) {
    merged.colors = [merged.color];
    if (!merged.fieldSources.colors && merged.fieldSources.color)
      merged.fieldSources.colors = merged.fieldSources.color;
  }

  if (!merged.color && merged.colors.length > 0) {
    merged.color = merged.colors[0];
    if (!merged.fieldSources.color && merged.fieldSources.colors)
      merged.fieldSources.color = merged.fieldSources.colors;
  }

  if (!merged.brand) merged.brand = "H&M";

  return merged;
};

// ─── Page helpers ─────────────────────────────────────────────────────────────

const prewarmSession = async (page, productContext) => {
  if (config.prewarmHomeMs <= 0) return;
  await page.goto(`${productContext.origin}/${productContext.localeKey}/`, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });
  await page.waitForTimeout(config.prewarmHomeMs);
};

const readPageSnapshot = async (page) => {
  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: config.requestTimeoutMs });
      return { pageTitle: await page.title(), html: await page.content(), currentUrl: page.url() };
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }
  throw lastError;
};

const classifyAttemptError = (error) => {
  if (error instanceof UpstreamBlockError)
    return { message: error.message, code: error.name, retryable: true };
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "Unknown candidate failure.";
  return { message, code: error?.name || "Error", retryable: true };
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

            await page.waitForSelector("h1", { timeout: 8000 }).catch(() => {});

            // Scroll to trigger lazy-loaded gallery images
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(1500);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(500);

            const snapshot = await readPageSnapshot(page);

            if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
              throw new UpstreamBlockError("H&M blocked the request.");
            }

            const networkLayer = extractNetworkLayer(collector.getPayloads(), productContext);
            const jsonLdLayer = extractJsonLdLayer(snapshot.html, productContext.market);
            const domLayer = await extractDomFallback(page);
            const htmlImages = extractImagesFromHtml(snapshot.html);

            const mergedData = mergeProductData(productContext, [networkLayer, jsonLdLayer, domLayer]);

            // Prefer HTML-scanned images if we got more than from the DOM
            if (htmlImages.length > mergedData.images.length) {
              mergedData.images = htmlImages;
              mergedData.fieldSources.images = "html-scan";
              if (!mergedData.sourceChain.includes("html-scan")) mergedData.sourceChain.push("html-scan");
            }

            if (hasUsefulProductData(mergedData)) return mergedData;

            if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
              throw new UpstreamBlockError("H&M blocked the request.");
            }

            throw new UpstreamBlockError("H&M did not expose enough product data for this request.");
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
      failureHistory.push({ ...createAttemptMetadata(attempt), message: classifiedError.message, code: classifiedError.code });
      recordCandidateFailure(attempt, { outcome: classifiedError.code, error: classifiedError.message });
      if (!classifiedError.retryable) throw error;
    }
  }

  if (cachedProducts[productContext.articleCode]) {
    return buildCachedResponse(cachedProducts[productContext.articleCode], productContext, attempts, failureHistory);
  }

  throw new UpstreamBlockError(
    `Unable to fetch product data after ${attempts.length} attempts.`,
    { attemptsTried: attempts.length, attemptHistory: failureHistory, proxyMetrics: getProxyMetrics() }
  );
};
