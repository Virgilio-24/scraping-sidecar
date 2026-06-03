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

const BLOCK_URL_PATTERNS = [
  /\/error\b/i,
  /\/unavailable\b/i,
];

const BLOCK_TITLE_PATTERNS = [
  /error/i,
  /unavailable/i,
];

const GENERIC_TITLE_PATTERNS = [
  /^zara\b/i,
];

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

const PRODUCT_CACHE_FILE = "zara-product-cache.json";

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

const buildZaraImageUrl = (colorEntry) => {
  const mediaList =
    (Array.isArray(colorEntry?.xmedia) && colorEntry.xmedia.length > 0
      ? colorEntry.xmedia
      : colorEntry?.media) || [];

  return unique(
    mediaList
      .map((item) => {
        if (!item) {
          return null;
        }

        const rawPath = item.path || item.url || "";
        const ts = item.timestamp || item.ts || "";

        if (!rawPath) {
          return null;
        }

        if (rawPath.startsWith("//")) {
          return `https:${rawPath}`;
        }

        if (rawPath.startsWith("http")) {
          return rawPath;
        }

        if (ts) {
          return `https://static.zara.net/photos/${rawPath}/w/750/${ts}.jpg?ts=${ts}`;
        }

        return `https://static.zara.net/photos/${rawPath}`;
      })
      .filter(Boolean)
  );
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

  return {
    productId,
    locale,
    market,
    country,
    lang,
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

const buildAttempts = (productContext, proxyUrls) => {
  const plan = proxyUrls?.length
    ? buildRequestAttemptPlan(proxyUrls, config.retryAttempts)
    : getAttemptPlan(config.retryAttempts);
  return plan.map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey:
      candidate.label === "direct"
        ? `zara-${productContext.market}-direct`
        : `zara-${productContext.market}-${candidate.label}`,
  }));
};

const looksLikeZaraProduct = (obj) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return false;
  }

  const keys = new Set(Object.keys(obj));
  const hasName = keys.has("name");
  const hasDetail = keys.has("detail");
  const hasPrice = keys.has("price");
  const hasColors = keys.has("colors");

  return hasName && (hasDetail || hasPrice || hasColors);
};

const extractColorsFromZaraApi = (apiData) => {
  const colorsArray =
    (apiData.detail?.colors) ||
    apiData.colors ||
    [];

  return Array.isArray(colorsArray) ? colorsArray : [];
};

const extractNetworkLayer = (networkPayload, productContext) => {
  if (!networkPayload || typeof networkPayload !== "object") {
    return null;
  }

  let product = null;

  if (looksLikeZaraProduct(networkPayload)) {
    product = networkPayload;
  } else {
    const queue = [networkPayload];
    const seen = new Set();

    while (queue.length > 0 && !product) {
      const current = queue.shift();

      if (!current || typeof current !== "object" || seen.has(current)) {
        continue;
      }

      seen.add(current);

      if (Array.isArray(current)) {
        queue.push(...current.slice(0, 30));
        continue;
      }

      if (looksLikeZaraProduct(current)) {
        product = current;
        break;
      }

      for (const value of Object.values(current)) {
        if (value && typeof value === "object") {
          queue.push(value);
        }
      }
    }
  }

  if (!product) {
    return null;
  }

  const colorsData = extractColorsFromZaraApi(product);
  const firstColor = colorsData[0] || {};

  const colorNames = unique(colorsData.map((c) => firstNonEmpty(c.name)).filter(Boolean));
  const selectedColor = firstNonEmpty(firstColor.name);

  const sizesRaw = Array.isArray(firstColor.sizes) ? firstColor.sizes : [];
  const sizes = unique(sizesRaw.map((s) => firstNonEmpty(s?.name)).filter(Boolean));

  const images = buildZaraImageUrl(firstColor);

  const priceObj = product.price || firstColor.price || sizesRaw[0]?.price || {};
  const priceAmount = normalizeCentPrice(priceObj.value ?? priceObj.amount ?? null);
  const currency = CURRENCY_MAP[productContext.market] || "€";
  const formattedPrice = priceAmount ? `${priceAmount} ${currency}` : null;

  return {
    productId: productContext.productId,
    title: firstNonEmpty(product.name),
    brand: firstNonEmpty(product.brand, "Zara"),
    color: selectedColor,
    colors: colorNames,
    sizes,
    variants: [],
    price: {
      amount: priceAmount,
      formatted: formattedPrice,
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
    images,
    sourceStage: "network-json",
  };
};

const attachNetworkCollector = (page, productId) => {
  const payloads = [];
  const allPayloads = [];

  const handler = async (response) => {
    const url = response.url();

    if (!url.includes("www.zara.com")) {
      return;
    }

    const contentType = response.headers()["content-type"] || "";

    if (!contentType.includes("application/json")) {
      return;
    }

    try {
      const body = await response.json();
      allPayloads.push({ url, payload: body });

      const urlMatchesProduct =
        url.includes(productId) ||
        /\/catalog\/store\/\d+\/product\/\d+\/detail/i.test(url) ||
        /\/api\/products\//i.test(url);

      if (urlMatchesProduct) {
        payloads.push(body);
      }
    } catch {
      // malformed JSON — skip
    }
  };

  page.on("response", handler);

  return {
    getPayloads: () => payloads,
    getAllPayloads: () => allPayloads,
    detach: () => page.off("response", handler),
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

const extractInlineJsonLayer = (html, productContext) => {
  const colorJsonMatch = html.match(
    /"colorsSizesImagesJSON"\s*:\s*(\[[\s\S]*?\])(?:,|\s*\})/
  );

  if (!colorJsonMatch) {
    return null;
  }

  let colorsData;

  try {
    colorsData = JSON.parse(colorJsonMatch[1]);
  } catch {
    return null;
  }

  if (!Array.isArray(colorsData) || colorsData.length === 0) {
    return null;
  }

  const firstColor = colorsData[0] || {};
  const colorNames = unique(colorsData.map((c) => firstNonEmpty(c.name)).filter(Boolean));
  const selectedColor = firstNonEmpty(firstColor.name);
  const sizesRaw = Array.isArray(firstColor.sizes) ? firstColor.sizes : [];
  const sizes = unique(sizesRaw.map((s) => firstNonEmpty(s?.name)).filter(Boolean));
  const images = buildZaraImageUrl(firstColor);
  const priceObj = firstColor.price || sizesRaw[0]?.price || {};
  const priceAmount = normalizeCentPrice(priceObj.value ?? priceObj.amount ?? null);
  const currency = CURRENCY_MAP[productContext.market] || "€";
  const formattedPrice = priceAmount ? `${priceAmount} ${currency}` : null;

  return {
    productId: productContext.productId,
    title: null,
    brand: "Zara",
    color: selectedColor,
    colors: colorNames,
    sizes,
    variants: [],
    price: {
      amount: priceAmount,
      formatted: formattedPrice,
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
    images,
    sourceStage: "inline-json",
  };
};

const extractImagesFromHtml = (html, productId) => {
  const pattern = /https:\/\/static\.zara\.net\/assets\/public\/[^"'\s\\]+\.(?:jpg|webp|jpeg)/gi;
  return unique(
    [...html.matchAll(pattern)]
      .map(m => m[0])
      .filter(url =>
        url.includes(productId) &&
        !url.includes("transparent-background") &&
        !url.includes("stdstatic")
      )
      .map(url => url.replace(/\?[^"'\s]*$/, "") + "?w=750")
  ).slice(0, 12);
};

const extractImagesFromNetwork = (allPayloads, productId) => {
  const zaraImagePattern = /https:\/\/static\.zara\.net\/[^"'\s\\]+\.(?:jpg|webp|jpeg)/i;
  const found = [];

  const scan = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 8) return;
    if (Array.isArray(obj)) {
      obj.forEach(item => scan(item, depth + 1));
      return;
    }
    for (const [, val] of Object.entries(obj)) {
      if (typeof val === "string" && zaraImagePattern.test(val) && val.includes(productId)) {
        found.push(val.replace(/\?[^"'\s]*$/, "") + "?w=750");
      } else if (val && typeof val === "object") {
        scan(val, depth + 1);
      }
    }
  };

  for (const { payload } of allPayloads) {
    scan(payload);
  }

  return unique(found).slice(0, 12);
};

const extractJsonLdLayer = (html) => {
  const jsonLdBlocks = parseJsonLdBlocks(html);
  const product = findProductJsonLd(jsonLdBlocks);

  if (!product) {
    return null;
  }

  // Zara uses @type:"Product" with direct fields (no hasVariant)
  const offer = product.offers && !Array.isArray(product.offers) ? product.offers : null;
  const priceAmount = firstNonEmpty(
    offer?.price != null ? String(offer.price) : null,
    product.offers?.price != null ? String(product.offers.price) : null
  );

  // Sizes from additionalProperty or direct size field
  const additionalSizes = Array.isArray(product.additionalProperty)
    ? unique(
        product.additionalProperty
          .filter((p) => /size|tamanho|taille|talla|größe/i.test(p?.name || ""))
          .map((p) => firstNonEmpty(p?.value))
          .filter(Boolean)
      )
    : [];
  const directSize = firstNonEmpty(product.size);
  const sizes = unique([...additionalSizes, directSize].filter(Boolean));

  // Zara has a single image per page in JSON-LD
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
    brand: firstNonEmpty(product.brand?.name, "Zara"),
    description: firstNonEmpty(product.description) || null,
    color: firstNonEmpty(product.color),
    colors: unique([product.color].filter(Boolean)),
    sizes,
    variants: [],
    details,
    price: {
      amount: priceAmount,
      formatted: null,
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
    images,
    sourceStage: "json-ld",
  };
};

const extractDomFallback = async (page) => {
  try {
    const domData = await page.evaluate(() => {
      const compact = (v) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
      const unique = (arr) => [...new Set(arr.filter(Boolean))];

      const titleEl = document.querySelector("h1.product-detail-info__header-name");
      const title = titleEl ? compact(titleEl.textContent) : null;

      const priceEl = document.querySelector(".price-current__amount, .price-current.price__amount, .price__amount-wrapper");
      const priceText = priceEl ? compact(priceEl.textContent) : null;
      const priceMatch = priceText ? priceText.match(/[\d.,]+/) : null;
      const priceAmount = priceMatch ? priceMatch[0].replace(/,(?=\d{3})/g, "") : null;

      const colorEl = document.querySelector(".product-detail-color-selector__selected-color-name");
      const rawColor = colorEl ? compact(colorEl.textContent) : null;
      const color = rawColor ? rawColor.replace(/\s*\d{2,}\/\d{2,}(\/\d+)*.*$/, "").trim() || rawColor : null;

      // All color options
      const colorOptionEls = Array.from(document.querySelectorAll(
        ".product-detail-color-selector__color-list a, .product-detail-color-selector__color-list li, [class*='color-selector__colors'] a, [class*='color-selector__colors'] li"
      ));
      const allColors = unique(colorOptionEls.map(el => compact(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent)).filter(v => v && v.length > 1 && v.length <= 40));
      const colors = allColors.length > 0 ? allColors : (color ? [color] : []);

      // Sizes come from the modal — extracted separately after clicking add-to-cart
      const sizes = [];

      // Images — only static.zara.net product images with -p. suffix
      const images = unique(
        Array.from(document.querySelectorAll("img[src*='static.zara.net'][src*='-p.']"))
          .map(el => (el.getAttribute("src") || "").replace(/([?&]w=)\d+/, "$1750"))
          .filter(Boolean)
      ).slice(0, 8);

      if (!title && !priceAmount) return null;


      return { title, color, colors, sizes, images, priceText, priceAmount };
    });

    if (!domData) return null;

    return {
      productId: null,
      title: domData.title,
      brand: "Zara",
      color: domData.color,
      colors: domData.colors,
      sizes: domData.sizes,
      variants: [],
      images: domData.images,
      price: {
        amount: domData.priceAmount,
        formatted: domData.priceText,
        retailAmount: null,
        retailFormatted: null,
        discountPercent: null,
      },
      sourceStage: "dom-live",
    };
  } catch {
    return null;
  }
};

const extractSizesViaModal = async (page) => {
  try {
    const addToCartBtn = page.locator("[data-qa-action='add-to-cart']").first();
    if ((await addToCartBtn.count()) === 0) return [];

    // Dismiss cookie consent overlay if blocking
    await page.evaluate(() => {
      const sdk = document.getElementById("onetrust-consent-sdk");
      if (sdk) sdk.style.display = "none";
      document.querySelectorAll(".onetrust-pc-dark-filter, #onetrust-pc-sdk").forEach(el => {
        el.style.display = "none";
      });
    }).catch(() => {});

    await addToCartBtn.click({ timeout: 3000, force: true });
    await page.waitForTimeout(2000);

    const sizes = await page.evaluate(() => {
      const compact = (v) => typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
      const unique = (arr) => [...new Set(arr.filter(Boolean))];

      const sizeEls = Array.from(document.querySelectorAll(
        ".size-selector-sizes li button, .size-selector-sizes-size__button, .size-selector-sizes__size button"
      )).filter(el => {
        const t = compact(el.getAttribute("aria-label") || el.textContent);
        return t && t.length <= 20 && !/guia|guide|adicionar|add to|apple|paypal|fechar|close/i.test(t);
      });
      return unique(sizeEls.map(el => compact(el.getAttribute("aria-label") || el.textContent)));
    });

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);

    return sizes;
  } catch {
    return [];
  }
};

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
    description: null,
    color: null,
    colors: [],
    sizes: [],
    variants: [],
    details: [],
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

    if (!merged.description && layer.description) {
      merged.description = layer.description;
      if (layer.sourceStage) merged.fieldSources.description = layer.sourceStage;
    }

    if ((layer.details || []).length > 0 && merged.details.length === 0) {
      merged.details = layer.details;
      if (layer.sourceStage) merged.fieldSources.details = layer.sourceStage;
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

  if (!merged.brand) {
    merged.brand = "Zara";
  }

  return merged;
};

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

export const fetchProductDetails = async (productUrl, options = {}) => {
  const productContext = parseProductUrl(productUrl);
  const attempts = buildAttempts(productContext, options.proxyUrls);
  const failureHistory = [];
  const cachedProducts = await readProductCache();

  for (const attempt of attempts) {
    try {
      const merged = await withPage(
        async (page) => {
          const collector = attachNetworkCollector(page, productContext.productId);

          try {
            await prewarmSession(page, productContext);
            await page.goto(productContext.productUrl, {
              waitUntil: "domcontentloaded",
              timeout: config.navigationTimeoutMs,
            });
            await page.waitForTimeout(config.pageWaitMs);

            // Wait for product title to confirm SPA has rendered
            await page.waitForSelector("h1.product-detail-info__header-name", {
              timeout: 8000,
            }).catch(() => {});
            // Scroll to trigger lazy-loaded images
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
            await page.waitForTimeout(1500);

            const snapshot = await readPageSnapshot(page);

            if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
              throw new UpstreamBlockError(
                "Zara blocked the request (error or unavailable page)."
              );
            }

            const networkPayloads = collector.getPayloads();
            let networkLayer = null;

            for (const payload of networkPayloads) {
              const candidate = extractNetworkLayer(payload, productContext);

              if (candidate && hasUsefulProductData(candidate)) {
                networkLayer = candidate;
                break;
              }

              if (candidate && !networkLayer) {
                networkLayer = candidate;
              }
            }

            const inlineJsonLayer = extractInlineJsonLayer(snapshot.html, productContext);
            const jsonLdLayer = extractJsonLdLayer(snapshot.html);
            const domLayer = await extractDomFallback(page);

            // Images from network responses (most reliable if captured)
            const networkImages = extractImagesFromNetwork(collector.getAllPayloads(), productContext.productId);

            // Images from raw HTML (CDN URLs filtered by productId)
            const htmlImages = extractImagesFromHtml(snapshot.html, productContext.productId);
            const modalSizes = await extractSizesViaModal(page);

            const mergedData = mergeProductData(productContext, [
              networkLayer,
              inlineJsonLayer,
              jsonLdLayer,
              domLayer,
            ]);

            if (modalSizes.length > 0 && mergedData.sizes.length <= 1) {
              mergedData.sizes = modalSizes;
              mergedData.fieldSources.sizes = "dom-modal";
              if (!mergedData.sourceChain.includes("dom-modal")) mergedData.sourceChain.push("dom-modal");
            }

            // Prefer network images > html-scan > json-ld (all filtered by productId)
            if (networkImages.length > mergedData.images.length) {
              mergedData.images = networkImages;
              mergedData.fieldSources.images = "network-images";
              if (!mergedData.sourceChain.includes("network-images")) mergedData.sourceChain.push("network-images");
            } else if (htmlImages.length > mergedData.images.length) {
              mergedData.images = htmlImages;
              mergedData.fieldSources.images = "html-scan";
              if (!mergedData.sourceChain.includes("html-scan")) mergedData.sourceChain.push("html-scan");
            }

            if (hasUsefulProductData(mergedData)) {
              return mergedData;
            }

            if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
              throw new UpstreamBlockError(
                "Zara blocked the request (error or unavailable page)."
              );
            }

            throw new UpstreamBlockError(
              "Zara did not expose enough product data for this request."
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
