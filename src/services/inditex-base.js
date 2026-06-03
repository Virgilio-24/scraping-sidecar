import fs from "fs/promises";
import path from "path";
import { config, resolveProjectPath } from "../config.js";
import { withPage } from "./browser.js";
import {
  getAttemptPlan,
  buildRequestAttemptPlan,
  getProxyMetrics,
  recordCandidateFailure,
  recordCandidateSuccess,
} from "./proxy-pool.js";

export class UpstreamBlockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UpstreamBlockError";
    this.details = details;
  }
}

const BLOCK_URL_PATTERNS = [/\/error\b/i, /\/unavailable\b/i];
const BLOCK_TITLE_PATTERNS = [/error/i, /unavailable/i];

const LOCALE_MAP = {
  pt: "pt-PT",
  es: "es-ES",
  uk: "en-GB",
  de: "de-DE",
  fr: "fr-FR",
  it: "it-IT",
  ww: "en-US",
};

const CURRENCY_MAP = {
  pt: "€",
  es: "€",
  de: "€",
  fr: "€",
  it: "€",
  uk: "£",
  ww: "€",
};

const DEFAULT_SELECTORS = {
  title: "h1.product-detail-info__header-name",
  price: ".price-current__amount, .price-current.price__amount, .price__amount-wrapper",
  color: ".product-detail-color-selector__selected-color-name",
  colorOptions:
    ".product-detail-color-selector__color-list a, .product-detail-color-selector__color-list li, [class*='color-selector__colors'] a, [class*='color-selector__colors'] li",
  sizeButtons:
    ".size-selector-sizes li button, .size-selector-sizes-size__button, .size-selector-sizes__size button",
  addToCart: "[data-qa-action='add-to-cart']",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const firstNonEmpty = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value !== null && value !== undefined && value !== "") return value;
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
  if (value.startsWith("http://")) return `https://${value.slice("http://".length)}`;
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

const normalizeCentPrice = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 100) return String(value / 100);
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    const num = Number(value.trim());
    if (Number.isFinite(num) && num > 100) return String(num / 100);
    return value.trim();
  }
  return null;
};

const buildCdnImageUrl = (rawPath, ts, cdnHostname) => {
  if (!rawPath) return null;
  if (rawPath.startsWith("//")) return `https:${rawPath}`;
  if (rawPath.startsWith("http")) return rawPath;
  if (ts) return `https://${cdnHostname}/photos/${rawPath}/w/750/${ts}.jpg?ts=${ts}`;
  return `https://${cdnHostname}/photos/${rawPath}`;
};

const buildInditexImageUrls = (colorEntry, cdnHostname) => {
  const mediaList =
    (Array.isArray(colorEntry?.xmedia) && colorEntry.xmedia.length > 0
      ? colorEntry.xmedia
      : colorEntry?.media) || [];

  return unique(
    mediaList
      .map((item) => {
        if (!item) return null;
        const rawPath = item.path || item.url || "";
        const ts = item.timestamp || item.ts || "";
        return buildCdnImageUrl(rawPath, ts, cdnHostname);
      })
      .filter(Boolean)
  );
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const getProductCachePath = (cacheFile) => {
  const dir = resolveProjectPath(config.sessionStateDir);
  return path.join(dir, cacheFile);
};

const readProductCache = async (cacheFile) => {
  try {
    const raw = await fs.readFile(getProductCachePath(cacheFile), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeProductCacheEntry = async (productData, cacheFile) => {
  if (!productData?.productId) return;
  const cachePath = getProductCachePath(cacheFile);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const cache = await readProductCache(cacheFile);
  cache[productData.productId] = { ...productData, cachedAt: new Date().toISOString() };
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

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

const parseProductUrl = (productUrl) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(productUrl);
  } catch {
    const error = new TypeError("The provided URL is invalid.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const productIdMatch = parsedUrl.pathname.match(/-p(\d+)\.html/i);
  if (!productIdMatch) {
    const error = new TypeError("Unable to extract product ID from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const productId = productIdMatch[1];
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const country = pathSegments[0] || "ww";
  const lang = pathSegments[1] || "en";
  const slug = pathSegments.slice(2).join("/").replace(/\?.*$/, "");
  const locale = LOCALE_MAP[country] || "en-US";
  const market = country;
  const v1 = parsedUrl.searchParams.get("v1");
  const cleanUrl = v1
    ? `${parsedUrl.origin}/${country}/${lang}/${slug}?v1=${v1}`
    : `${parsedUrl.origin}/${country}/${lang}/${slug}`;

  return { productId, locale, market, country, lang, origin: parsedUrl.origin, productUrl: cleanUrl };
};

const buildAcceptLanguage = (locale) => {
  const [lang, region] = locale.split("-");
  if (region) return `${locale},${lang};q=0.9,en;q=0.8`;
  return `${locale};q=0.9,en;q=0.8`;
};

// ---------------------------------------------------------------------------
// Network layer
// ---------------------------------------------------------------------------

const looksLikeInditexProduct = (obj) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = new Set(Object.keys(obj));
  return keys.has("name") && (keys.has("detail") || keys.has("price") || keys.has("colors"));
};

const extractColorsFromApi = (apiData) => {
  const colorsArray = apiData.detail?.colors || apiData.colors || [];
  return Array.isArray(colorsArray) ? colorsArray : [];
};

const extractNetworkLayer = (networkPayload, productContext, cdnHostname) => {
  if (!networkPayload || typeof networkPayload !== "object") return null;

  let product = null;

  if (looksLikeInditexProduct(networkPayload)) {
    product = networkPayload;
  } else {
    const queue = [networkPayload];
    const seen = new Set();
    while (queue.length > 0 && !product) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) { queue.push(...current.slice(0, 30)); continue; }
      if (looksLikeInditexProduct(current)) { product = current; break; }
      for (const value of Object.values(current)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
  }

  if (!product) return null;

  const colorsData = extractColorsFromApi(product);
  const firstColor = colorsData[0] || {};
  const colorNames = unique(colorsData.map((c) => firstNonEmpty(c.name)).filter(Boolean));
  const selectedColor = firstNonEmpty(firstColor.name);
  const sizesRaw = Array.isArray(firstColor.sizes) ? firstColor.sizes : [];
  const sizes = unique(sizesRaw.map((s) => firstNonEmpty(s?.name)).filter(Boolean));
  const images = buildInditexImageUrls(firstColor, cdnHostname);
  const priceObj = product.price || firstColor.price || sizesRaw[0]?.price || {};
  const priceAmount = normalizeCentPrice(priceObj.value ?? priceObj.amount ?? null);
  const currency = CURRENCY_MAP[productContext.market] || "€";
  const formattedPrice = priceAmount ? `${priceAmount} ${currency}` : null;

  return {
    productId: productContext.productId,
    title: firstNonEmpty(product.name),
    brand: null,
    color: selectedColor,
    colors: colorNames,
    sizes,
    variants: [],
    price: { amount: priceAmount, formatted: formattedPrice, retailAmount: null, retailFormatted: null, discountPercent: null },
    images,
    sourceStage: "network-json",
  };
};

const attachNetworkCollector = (page, productId, hostname) => {
  const payloads = [];
  const allPayloads = [];

  const handler = async (response) => {
    const url = response.url();
    if (!url.includes(hostname)) return;
    const contentType = response.headers()["content-type"] || "";
    if (!contentType.includes("application/json")) return;
    try {
      const body = await response.json();
      allPayloads.push({ url, payload: body });
      const urlMatchesProduct =
        url.includes(productId) ||
        /\/catalog\/store\/\d+\/product\/\d+\/detail/i.test(url) ||
        /\/api\/products\//i.test(url);
      if (urlMatchesProduct) payloads.push(body);
    } catch { /* malformed JSON */ }
  };

  page.on("response", handler);
  return {
    getPayloads: () => payloads,
    getAllPayloads: () => allPayloads,
    detach: () => page.off("response", handler),
  };
};

// ---------------------------------------------------------------------------
// HTML extraction layers
// ---------------------------------------------------------------------------

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

const extractJsonLdLayer = (html, brandName) => {
  const product = findProductJsonLd(parseJsonLdBlocks(html));
  if (!product) return null;

  const offer = product.offers && !Array.isArray(product.offers) ? product.offers : null;
  const priceAmount = firstNonEmpty(
    offer?.price != null ? String(offer.price) : null,
    product.offers?.price != null ? String(product.offers.price) : null
  );

  const additionalSizes = Array.isArray(product.additionalProperty)
    ? unique(
        product.additionalProperty
          .filter((p) => /size|tamanho|taille|talla|größe/i.test(p?.name || ""))
          .map((p) => firstNonEmpty(p?.value))
          .filter(Boolean)
      )
    : [];
  const sizes = unique([...additionalSizes, firstNonEmpty(product.size)].filter(Boolean));

  const images = unique(
    [product.image]
      .flat()
      .filter(Boolean)
      .map(normalizeImageUrl)
      .filter((url) => url && !url.includes("transparent-background"))
      .map((url) => url.replace(/([?&]w=)\d+/, "$1750"))
  );

  const details = Array.isArray(product.additionalProperty)
    ? product.additionalProperty
        .map((p) => ({ name: firstNonEmpty(p?.name), value: firstNonEmpty(p?.value) }))
        .filter((p) => p.name && p.value)
    : [];

  return {
    productId: null,
    title: firstNonEmpty(product.name),
    brand: firstNonEmpty(product.brand?.name, brandName),
    description: firstNonEmpty(product.description) || null,
    color: firstNonEmpty(product.color),
    colors: unique([product.color].filter(Boolean)),
    sizes,
    variants: [],
    details,
    price: { amount: priceAmount, formatted: null, retailAmount: null, retailFormatted: null, discountPercent: null },
    images,
    sourceStage: "json-ld",
  };
};

const extractInlineJsonLayer = (html, productContext, cdnHostname) => {
  const colorJsonMatch = html.match(/"colorsSizesImagesJSON"\s*:\s*(\[[\s\S]*?\])(?:,|\s*\})/);
  if (!colorJsonMatch) return null;

  let colorsData;
  try { colorsData = JSON.parse(colorJsonMatch[1]); } catch { return null; }
  if (!Array.isArray(colorsData) || colorsData.length === 0) return null;

  const firstColor = colorsData[0] || {};
  const colorNames = unique(colorsData.map((c) => firstNonEmpty(c.name)).filter(Boolean));
  const selectedColor = firstNonEmpty(firstColor.name);
  const sizesRaw = Array.isArray(firstColor.sizes) ? firstColor.sizes : [];
  const sizes = unique(sizesRaw.map((s) => firstNonEmpty(s?.name)).filter(Boolean));
  const images = buildInditexImageUrls(firstColor, cdnHostname);
  const priceObj = firstColor.price || sizesRaw[0]?.price || {};
  const priceAmount = normalizeCentPrice(priceObj.value ?? priceObj.amount ?? null);
  const currency = CURRENCY_MAP[productContext.market] || "€";
  const formattedPrice = priceAmount ? `${priceAmount} ${currency}` : null;

  return {
    productId: productContext.productId,
    title: null,
    brand: null,
    color: selectedColor,
    colors: colorNames,
    sizes,
    variants: [],
    price: { amount: priceAmount, formatted: formattedPrice, retailAmount: null, retailFormatted: null, discountPercent: null },
    images,
    sourceStage: "inline-json",
  };
};

const extractImagesFromHtml = (html, productId, cdnHostname) => {
  const escaped = cdnHostname.replace(/\./g, "\\.");
  const pattern = new RegExp(
    `https://${escaped}/assets/public/[^"'\\s\\\\]+\\.(?:jpg|webp|jpeg)`,
    "gi"
  );
  return unique(
    [...html.matchAll(pattern)]
      .map((m) => m[0])
      .filter((url) => url.includes(productId) && !url.includes("transparent-background") && !url.includes("stdstatic"))
      .map((url) => url.replace(/\?[^"'\s]*$/, "") + "?w=750")
  ).slice(0, 12);
};

const extractImagesFromNetwork = (allPayloads, productId, cdnHostname) => {
  const escaped = cdnHostname.replace(/\./g, "\\.");
  const cdnPattern = new RegExp(`https://${escaped}/[^"'\\s\\\\]+\\.(?:jpg|webp|jpeg)`, "i");
  const found = [];

  const scan = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 8) return;
    if (Array.isArray(obj)) { obj.forEach((item) => scan(item, depth + 1)); return; }
    for (const [, val] of Object.entries(obj)) {
      if (typeof val === "string" && cdnPattern.test(val) && val.includes(productId)) {
        found.push(val.replace(/\?[^"'\s]*$/, "") + "?w=750");
      } else if (val && typeof val === "object") {
        scan(val, depth + 1);
      }
    }
  };

  for (const { payload } of allPayloads) scan(payload);
  return unique(found).slice(0, 12);
};

// ---------------------------------------------------------------------------
// Generic HTML pattern layer
// Last-resort extraction directly from rendered DOM when JSON layers miss colors/sizes.
// Works without knowing brand-specific class names.
// ---------------------------------------------------------------------------

const extractHtmlPatternLayer = async (page) => {
  try {
    return await page.evaluate(() => {
      const compact = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
      const unique = (arr) => [...new Set(arr.filter(Boolean))];

      // Size patterns: XS/S/M/L/XL/XXL, EU numeric (28–54), US numeric (0–20), inch pairs (28/30)
      const SIZE_RE = /^(?:x{0,3}s|x{0,3}l|m|x{1,3}s|xs|s|m|l|xl|xxl|xxxl|\d{2}(?:[.,]\d)?|\d{2}\/\d{2})$/i;

      // Collect all interactive leaf elements
      const allInteractive = Array.from(
        document.querySelectorAll('button, li[role="option"], option, [role="radio"], [role="button"]')
      );

      // Sizes: interactive elements whose visible text matches a size pattern
      const sizes = unique(
        allInteractive
          .map((el) => compact(el.getAttribute("aria-label") || el.textContent))
          .filter((t) => SIZE_RE.test(t))
      );

      // Colors: elements that have aria-label AND sit inside a container with "color" or "colour" in its class/id
      const colorContainerEls = Array.from(
        document.querySelectorAll(
          '[class*="color"] [aria-label], [class*="colour"] [aria-label], ' +
          '[id*="color"] [aria-label], [class*="swatch"] [aria-label]'
        )
      );
      const colorsFromAriaLabel = unique(
        colorContainerEls
          .map((el) => compact(el.getAttribute("aria-label")))
          .filter((v) => v && v.length > 1 && v.length <= 50 && !/^\d+$/.test(v))
      );

      // Also try data-name / title attributes on elements near color swatches
      const swatchEls = Array.from(
        document.querySelectorAll('[class*="color"], [class*="colour"], [class*="swatch"]')
      ).flatMap((el) => Array.from(el.querySelectorAll("[data-name], [title]")));
      const colorsFromData = unique(
        swatchEls
          .map((el) => compact(el.getAttribute("data-name") || el.getAttribute("title") || ""))
          .filter((v) => v && v.length > 1 && v.length <= 50 && !/^\d+$/.test(v))
      );

      const colors = unique([...colorsFromAriaLabel, ...colorsFromData]);

      if (sizes.length === 0 && colors.length === 0) return null;
      return { sizes, colors };
    });
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// DOM fallback
// ---------------------------------------------------------------------------

const extractDomFallback = async (page, selectors, brandName, cdnHostname) => {
  try {
    const domData = await page.evaluate(
      ({ sel, cdnHostname }) => {
        const compact = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
        const unique = (arr) => [...new Set(arr.filter(Boolean))];

        // Title — try configured selector, then any h1 on the page
        const titleEl = document.querySelector(sel.title) || document.querySelector("h1");
        const title = titleEl ? compact(titleEl.textContent) : null;

        // Price — try configured selector, then any element with a price-like class
        const priceEl =
          document.querySelector(sel.price) ||
          document.querySelector("[class*='price']");
        const priceText = priceEl ? compact(priceEl.textContent) : null;
        const priceMatch = priceText ? priceText.match(/[\d.,]+/) : null;
        const priceAmount = priceMatch ? priceMatch[0].replace(/,(?=\d{3})/g, "") : null;

        // Color — configured selector first, then aria-label/data attrs on color swatches
        const colorEl = document.querySelector(sel.color);
        const rawColor = colorEl ? compact(colorEl.textContent) : null;
        const color = rawColor ? rawColor.replace(/\s*\d{2,}\/\d{2,}(\/\d+)*.*$/, "").trim() || rawColor : null;

        // Color options — configured selector + generic fallback for color swatches
        const colorOptionEls = Array.from(
          document.querySelectorAll(
            sel.colorOptions + ", [class*='color'][aria-label], [class*='swatch'][aria-label]"
          )
        );
        const allColors = unique(
          colorOptionEls
            .map((el) => compact(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent))
            .filter((v) => v && v.length > 1 && v.length <= 40)
        );
        const colors = allColors.length > 0 ? allColors : color ? [color] : [];

        // Images — CDN hostname match
        const images = unique(
          Array.from(document.querySelectorAll(`img[src*='${cdnHostname}']`))
            .map((el) => (el.getAttribute("src") || "").replace(/([?&]w=)\d+/, "$1750"))
            .filter(Boolean)
        ).slice(0, 8);

        // Only skip if nothing at all was found
        if (!title && !priceAmount && colors.length === 0 && images.length === 0) return null;
        return { title, color, colors, sizes: [], images, priceText, priceAmount };
      },
      { sel: selectors, cdnHostname }
    );

    if (!domData) return null;

    return {
      productId: null,
      title: domData.title,
      brand: brandName,
      color: domData.color,
      colors: domData.colors,
      sizes: domData.sizes,
      variants: [],
      images: domData.images,
      price: { amount: domData.priceAmount, formatted: domData.priceText, retailAmount: null, retailFormatted: null, discountPercent: null },
      sourceStage: "dom-live",
    };
  } catch {
    return null;
  }
};

const extractSizesViaModal = async (page, selectors) => {
  try {
    const addToCartBtn = page.locator(selectors.addToCart).first();
    if ((await addToCartBtn.count()) === 0) return [];

    await page.evaluate(() => {
      const sdk = document.getElementById("onetrust-consent-sdk");
      if (sdk) sdk.style.display = "none";
      document.querySelectorAll(".onetrust-pc-dark-filter, #onetrust-pc-sdk").forEach((el) => {
        el.style.display = "none";
      });
    }).catch(() => {});

    await addToCartBtn.click({ timeout: 3000, force: true });
    await page.waitForTimeout(2000);

    const sizeSelector = selectors.sizeButtons;
    const sizes = await page.evaluate((sel) => {
      const compact = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
      const unique = (arr) => [...new Set(arr.filter(Boolean))];
      const sizeEls = Array.from(document.querySelectorAll(sel)).filter((el) => {
        const t = compact(el.getAttribute("aria-label") || el.textContent);
        return t && t.length <= 20 && !/guia|guide|adicionar|add to|apple|paypal|fechar|close/i.test(t);
      });
      return unique(sizeEls.map((el) => compact(el.getAttribute("aria-label") || el.textContent)));
    }, sizeSelector);

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
    return sizes;
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Data merging
// ---------------------------------------------------------------------------

const isGenericTitle = (title, genericTitlePattern) => {
  if (!title || typeof title !== "string") return true;
  return genericTitlePattern.test(title.trim());
};

const isBlocked = (url, pageTitle) =>
  BLOCK_URL_PATTERNS.some((p) => p.test(url || "")) ||
  BLOCK_TITLE_PATTERNS.some((p) => p.test(pageTitle || ""));

const hasUsefulProductData = (data) =>
  Boolean(data.price.amount || data.images.length > 0 || (data.title && data.title.length > 2));

const mergeProductData = (productContext, layers, brandName, genericTitlePattern) => {
  const sourceChain = [];
  const merged = {
    productId: productContext.productId,
    title: null, brand: null, description: null, color: null,
    colors: [], sizes: [], variants: [], details: [],
    price: { amount: null, formatted: null, retailAmount: null, retailFormatted: null, discountPercent: null },
    images: [],
    url: productContext.productUrl,
    market: productContext.market,
    sourceChain,
    fieldSources: {},
  };

  for (const layer of layers) {
    if (!layer) continue;

    if (layer.productId && !merged.productId) merged.productId = layer.productId;

    if (!merged.description && layer.description) {
      merged.description = layer.description;
      if (layer.sourceStage) merged.fieldSources.description = layer.sourceStage;
    }

    if ((layer.details || []).length > 0 && merged.details.length === 0) {
      merged.details = layer.details;
      if (layer.sourceStage) merged.fieldSources.details = layer.sourceStage;
    }

    const prevTitle = merged.title;
    merged.title =
      merged.title && !isGenericTitle(merged.title, genericTitlePattern)
        ? merged.title
        : firstNonEmpty(layer.title, merged.title);
    if ((!prevTitle || isGenericTitle(prevTitle, genericTitlePattern)) && merged.title && layer.sourceStage && !merged.fieldSources.title) {
      merged.fieldSources.title = layer.sourceStage;
    }

    const prevBrand = merged.brand;
    merged.brand = firstNonEmpty(merged.brand, layer.brand);
    if (!prevBrand && merged.brand && layer.sourceStage && !merged.fieldSources.brand) {
      merged.fieldSources.brand = layer.sourceStage;
    }

    const shouldPreferDomColor = layer.sourceStage === "dom-live" && layer.color;
    merged.color = shouldPreferDomColor ? layer.color : firstNonEmpty(merged.color, layer.color);
    if (shouldPreferDomColor || (!merged.fieldSources.color && merged.color)) {
      if (layer.sourceStage) merged.fieldSources.color = layer.sourceStage;
    }

    const prevColorsLen = merged.colors.length;
    merged.colors =
      layer.sourceStage === "dom-live" && (layer.colors || []).length > 0
        ? unique([...(layer.colors || []), ...merged.colors, layer.color])
        : unique([...merged.colors, ...(layer.colors || []), layer.color]);
    if (merged.colors.length > prevColorsLen && layer.sourceStage && !merged.fieldSources.colors) {
      merged.fieldSources.colors = layer.sourceStage;
    }

    const prevSizesLen = merged.sizes.length;
    if (!(layer.sourceStage === "dom-live" && merged.sizes.length > 0)) {
      merged.sizes = unique([...merged.sizes, ...(layer.sizes || [])]);
    }
    if (merged.sizes.length > prevSizesLen && layer.sourceStage && !merged.fieldSources.sizes) {
      merged.fieldSources.sizes = layer.sourceStage;
    }

    const prevVariantsLen = merged.variants.length;
    merged.variants = uniqueBy(
      [...merged.variants, ...((layer.variants || []).map(normalizeVariant).filter(Boolean))],
      (v) => v.sku || `${v.size}-${v.color}`
    );
    if (merged.variants.length > prevVariantsLen && layer.sourceStage && !merged.fieldSources.variants) {
      merged.fieldSources.variants = layer.sourceStage;
    }

    const prevPriceAmount = merged.price.amount;
    merged.price.amount = firstNonEmpty(merged.price.amount, layer.price?.amount);
    merged.price.formatted = firstNonEmpty(merged.price.formatted, layer.price?.formatted);
    merged.price.retailAmount = firstNonEmpty(merged.price.retailAmount, layer.price?.retailAmount);
    merged.price.retailFormatted = firstNonEmpty(merged.price.retailFormatted, layer.price?.retailFormatted);
    merged.price.discountPercent = firstNonEmpty(merged.price.discountPercent, layer.price?.discountPercent);
    if (!prevPriceAmount && merged.price.amount && layer.sourceStage && !merged.fieldSources.price) {
      merged.fieldSources.price = layer.sourceStage;
    }

    const prevImagesLen = merged.images.length;
    merged.images = unique([...merged.images, ...(layer.images || [])]);
    if (merged.images.length > prevImagesLen && layer.sourceStage && !merged.fieldSources.images) {
      merged.fieldSources.images = layer.sourceStage;
    }

    if (layer.sourceStage) sourceChain.push(layer.sourceStage);
  }

  if (merged.color && merged.colors.length === 0) {
    merged.colors = [merged.color];
    if (!merged.fieldSources.colors && merged.fieldSources.color) {
      merged.fieldSources.colors = merged.fieldSources.color;
    }
  }

  if (!merged.brand) merged.brand = brandName;

  return merged;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fetchProductDetails function for any Inditex brand.
 *
 * @param {object} brandConfig
 * @param {string} brandConfig.brand             - Brand display name, e.g. "Pull&Bear"
 * @param {string} brandConfig.hostname          - Main hostname for network filter, e.g. "www.pullandbear.com"
 * @param {string} brandConfig.cdnHostname       - CDN hostname for images, e.g. "static.pullandbear.net"
 * @param {string} brandConfig.cacheFile         - Cache filename, e.g. "pullandbear-product-cache.json"
 * @param {string} brandConfig.profileKeyPrefix  - Prefix for session profile keys, e.g. "pullandbear"
 * @param {RegExp} brandConfig.genericTitlePattern - Regex that matches a generic/brand-only page title
 * @param {object} [brandConfig.selectors]       - Optional DOM selector overrides
 */
export const createInditexFetcher = (brandConfig) => {
  const {
    brand,
    hostname,
    cdnHostname,
    cacheFile,
    profileKeyPrefix,
    genericTitlePattern,
  } = brandConfig;

  const selectors = { ...DEFAULT_SELECTORS, ...(brandConfig.selectors || {}) };

  const buildAttempts = (productContext, proxyUrls) => {
    const plan = proxyUrls?.length
      ? buildRequestAttemptPlan(proxyUrls, config.retryAttempts)
      : getAttemptPlan(config.retryAttempts);
    return plan.map((candidate, index) => ({
      ...candidate,
      attemptNumber: index + 1,
      profileKey:
        candidate.label === "direct"
          ? `${profileKeyPrefix}-${productContext.market}-direct`
          : `${profileKeyPrefix}-${productContext.market}-${candidate.label}`,
    }));
  };

  const createAttemptMetadata = (attempt) => ({
    attempt: attempt.attemptNumber,
    round: attempt.round,
    proxy: attempt.label,
    proxyTarget: attempt.proxyDisplay || null,
    sessionProfile: attempt.profileKey,
  });

  const classifyAttemptError = (error) => {
    if (error instanceof UpstreamBlockError) {
      return { message: error.message, code: error.name, retryable: true };
    }
    const message =
      typeof error?.message === "string" && error.message.trim()
        ? error.message.trim()
        : "Unknown candidate failure.";
    return { message, code: error?.name || "Error", retryable: true };
  };

  const fetchProductDetails = async (productUrl, options = {}) => {
    const productContext = (brandConfig.parseProductUrl ?? parseProductUrl)(productUrl);
    const attempts = buildAttempts(productContext, options.proxyUrls);
    const failureHistory = [];
    const cachedProducts = await readProductCache(cacheFile);

    for (const attempt of attempts) {
      try {
        const merged = await withPage(
          async (page) => {
            const collector = attachNetworkCollector(page, productContext.productId, hostname);

            try {
              if (config.prewarmHomeMs > 0) {
                await page.goto(`${productContext.origin}/`, {
                  waitUntil: "domcontentloaded",
                  timeout: config.navigationTimeoutMs,
                });
                await page.waitForTimeout(config.prewarmHomeMs);
              }

              await page.goto(productContext.productUrl, {
                waitUntil: "domcontentloaded",
                timeout: config.navigationTimeoutMs,
              });
              await page.waitForTimeout(config.pageWaitMs);

              await page.waitForSelector(selectors.title, { timeout: 8000 }).catch(() => {});
              await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
              await page.waitForTimeout(1500);

              const snapshot = {
                pageTitle: await page.title(),
                html: await page.content(),
                currentUrl: page.url(),
              };

              if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
                throw new UpstreamBlockError(`${brand} blocked the request (error or unavailable page).`);
              }

              const networkPayloads = collector.getPayloads();
              let networkLayer = null;

              for (const payload of networkPayloads) {
                const candidate = extractNetworkLayer(payload, productContext, cdnHostname);
                if (candidate && hasUsefulProductData(candidate)) { networkLayer = candidate; break; }
                if (candidate && !networkLayer) networkLayer = candidate;
              }

              // If URL-matched payloads didn't yield colors/sizes, scan ALL captured JSON responses.
              // This handles brands where the API URL doesn't contain the product ID.
              const needsBroaderScan = !networkLayer || (!(networkLayer.colors?.length) && !(networkLayer.sizes?.length));
              if (needsBroaderScan) {
                for (const { payload } of collector.getAllPayloads()) {
                  const candidate = extractNetworkLayer(payload, productContext, cdnHostname);
                  if (candidate && (candidate.colors?.length > 0 || candidate.sizes?.length > 0)) {
                    networkLayer = candidate;
                    break;
                  }
                  if (candidate && !networkLayer) networkLayer = candidate;
                }
              }

              const inlineJsonLayer = extractInlineJsonLayer(snapshot.html, productContext, cdnHostname);
              const jsonLdLayer = extractJsonLdLayer(snapshot.html, brand);
              const domLayer = await extractDomFallback(page, selectors, brand, cdnHostname);
              const networkImages = extractImagesFromNetwork(collector.getAllPayloads(), productContext.productId, cdnHostname);
              const htmlImages = extractImagesFromHtml(snapshot.html, productContext.productId, cdnHostname);
              const modalSizes = await extractSizesViaModal(page, selectors);

              const mergedData = mergeProductData(
                productContext,
                [networkLayer, inlineJsonLayer, jsonLdLayer, domLayer],
                brand,
                genericTitlePattern
              );

              if (modalSizes.length > 0 && mergedData.sizes.length <= 1) {
                mergedData.sizes = modalSizes;
                mergedData.fieldSources.sizes = "dom-modal";
                if (!mergedData.sourceChain.includes("dom-modal")) mergedData.sourceChain.push("dom-modal");
              }

              // Last resort: generic HTML pattern extraction for colors/sizes
              if (mergedData.colors.length === 0 || mergedData.sizes.length === 0) {
                const htmlPatterns = await extractHtmlPatternLayer(page);
                if (htmlPatterns) {
                  if (mergedData.colors.length === 0 && htmlPatterns.colors.length > 0) {
                    mergedData.colors = htmlPatterns.colors;
                    mergedData.fieldSources.colors = "html-pattern";
                    if (!mergedData.sourceChain.includes("html-pattern")) mergedData.sourceChain.push("html-pattern");
                  }
                  if (mergedData.sizes.length === 0 && htmlPatterns.sizes.length > 0) {
                    mergedData.sizes = htmlPatterns.sizes;
                    mergedData.fieldSources.sizes = "html-pattern";
                    if (!mergedData.sourceChain.includes("html-pattern")) mergedData.sourceChain.push("html-pattern");
                  }
                }
              }

              if (networkImages.length > mergedData.images.length) {
                mergedData.images = networkImages;
                mergedData.fieldSources.images = "network-images";
                if (!mergedData.sourceChain.includes("network-images")) mergedData.sourceChain.push("network-images");
              } else if (htmlImages.length > mergedData.images.length) {
                mergedData.images = htmlImages;
                mergedData.fieldSources.images = "html-scan";
                if (!mergedData.sourceChain.includes("html-scan")) mergedData.sourceChain.push("html-scan");
              }

              if (hasUsefulProductData(mergedData)) return mergedData;

              if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
                throw new UpstreamBlockError(`${brand} blocked the request (error or unavailable page).`);
              }

              throw new UpstreamBlockError(`${brand} did not expose enough product data for this request.`);
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
        await writeProductCacheEntry(merged, cacheFile);

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
        recordCandidateFailure(attempt, { outcome: classifiedError.code, error: classifiedError.message });
        if (!classifiedError.retryable) throw error;
      }
    }

    if (cachedProducts[productContext.productId]) {
      return buildCachedResponse(cachedProducts[productContext.productId], productContext, attempts, failureHistory);
    }

    throw new UpstreamBlockError(
      `Unable to fetch product data after ${attempts.length} attempts.`,
      { attemptsTried: attempts.length, attemptHistory: failureHistory, proxyMetrics: getProxyMetrics() }
    );
  };

  return fetchProductDetails;
};
