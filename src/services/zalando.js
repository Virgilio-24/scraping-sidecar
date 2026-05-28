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
  /\/login\b/i,
  /\/challenge\b/i,
];

const BLOCK_TITLE_PATTERNS = [
  /acesso negado/i,
  /access denied/i,
  /just a moment/i,
];

const GENERIC_TITLE_PATTERNS = [
  /^zalando\b/i,
];

const MARKET_MAP = {
  "zalando.pt": { market: "pt", locale: "pt-PT" },
  "zalando.es": { market: "es", locale: "es-ES" },
  "zalando.de": { market: "de", locale: "de-DE" },
  "zalando.fr": { market: "fr", locale: "fr-FR" },
  "zalando.co.uk": { market: "uk", locale: "en-GB" },
  "zalando.it": { market: "it", locale: "it-IT" },
  "zalando.nl": { market: "nl", locale: "nl-NL" },
  "zalando.be": { market: "be", locale: "fr-BE" },
  "zalando.at": { market: "at", locale: "de-AT" },
  "zalando.pl": { market: "pl", locale: "pl-PL" },
};

const PRODUCT_CACHE_FILE = "zalando-product-cache.json";

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

const upgradeImageResolution = (url) => {
  if (!url) return url;
  return url.replace(/([?&])imwidth=\d+/, "$1imwidth=2000");
};

const MARKET_CURRENCY = {
  pt: "€", es: "€", de: "€", fr: "€", it: "€",
  nl: "€", be: "€", at: "€", pl: "zł",
  uk: "£", ch: "CHF", se: "kr", no: "kr", dk: "kr",
};

const formatPrice = (amount, market) => {
  if (!amount) return null;
  const symbol = MARKET_CURRENCY[market] || "€";
  const num = parseFloat(amount);
  if (isNaN(num)) return null;
  return ["uk", "ch"].includes(market)
    ? `${symbol} ${num.toFixed(2)}`
    : `${num.toFixed(2)} ${symbol}`;
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
  if (!productData?.articleId) {
    return;
  }

  const cachePath = getProductCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const cache = await readProductCache();
  cache[productData.articleId] = {
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
  const { market, locale } = marketEntry || { market: "en", locale: "en-US" };

  const slugMatch = parsedUrl.pathname.match(/([a-z0-9]+-[a-z][0-9]{2,4})\.html$/i);
  const articleId = slugMatch ? slugMatch[1].toUpperCase() : parsedUrl.pathname.replace(/\//g, "-").replace(/\.html$/, "");

  const slug = parsedUrl.pathname.replace(/^\//, "").replace(/\?.*$/, "");
  const cleanUrl = `${parsedUrl.origin}/${slug}`;

  return {
    articleId,
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
        ? `zalando-${productContext.market}-direct`
        : `zalando-${productContext.market}-${candidate.label}`,
  }));
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
          .map((variant) =>
            normalizeVariant({
              sku: variant.sku,
              size: variant.size,
              color: variant.color || product.color,
              price: variant.offers?.price,
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

  return {
    articleId: null,
    title: firstNonEmpty(product.name, firstVariant?.name),
    brand: firstNonEmpty(product.brand?.name),
    color: firstNonEmpty(product.color),
    colors: unique([product.color, ...variants.map((v) => v.color)]),
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
        .map((url) => upgradeImageResolution(normalizeImageUrl(url)))
    ),
    sourceStage: "json-ld",
  };
};

const extractDomFallback = async (page) => {
  try {
    const domData = await page.evaluate(() => {
      const compact = (value) =>
        typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      const unique = (values) => [...new Set(values.filter(Boolean))];
      const normalizeUrl = (value) => {
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

      const titleEl = document.querySelector("h1.EKabf7, [data-testid='product-name'], h1");
      const title = titleEl ? compact(titleEl.textContent) : null;

      const brandEl = document.querySelector("[data-testid='brand-name'], .OysyzV, h3.OysyzV");
      const brand = brandEl ? compact(brandEl.textContent) : null;

      const priceEl = document.querySelector("[data-testid='price'], .u-6V88, .dgII7d span");
      const priceText = priceEl ? compact(priceEl.textContent) : null;
      const priceMatch = priceText ? priceText.match(/[\d.,]+/) : null;
      const priceAmount = priceMatch ? priceMatch[0].replace(/,(?=\d{3})/g, "") : null;

      const retailEl = document.querySelector(
        "[data-testid='original-price'], [data-testid='price'] s, [data-testid='price'] del, s.VBDlI, del.VBDlI"
      );
      const retailText = retailEl ? compact(retailEl.textContent) : null;
      const retailMatch = retailText ? retailText.match(/[\d.,]+/) : null;
      const retailAmount = retailMatch ? retailMatch[0].replace(/,(?=\d{3})/g, "") : null;

      const colorEl = document.querySelector("[data-testid='color'], .lystZ1");
      const color = colorEl ? compact(colorEl.textContent) : null;

      const sizeEls = Array.from(
        document.querySelectorAll([
          "[data-testid='size-picker'] button",
          "[data-testid='pdp-size-picker'] button",
          "[data-testid='size-option']",
          "[data-testid='size-picker-option']",
        ].join(", "))
      );
      const looksLikeSize = (text) =>
        Boolean(text) &&
        text.length <= 12 &&
        !/[a-z]{4,}\s[a-z]{3,}/i.test(text);
      const sizes = unique(
        sizeEls
          .map((el) => compact(el.getAttribute("aria-label") || el.textContent))
          .filter(looksLikeSize)
      );

      const imgEls = Array.from(
        document.querySelectorAll("[data-testid='image'] img[src], .KxHAYs img[src]")
      );
      const images = unique(
        imgEls.map((el) => normalizeUrl(el.getAttribute("src"))).filter(Boolean)
      );

      if (!title && !priceAmount && images.length === 0) {
        return null;
      }

      return {
        title,
        brand,
        color,
        colors: color ? [color] : [],
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
      articleId: null,
      variants: [],
      sourceStage: "dom-live",
    };
  } catch {
    return null;
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
    articleId: productContext.articleId,
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

    if (layer.articleId && !merged.articleId) {
      merged.articleId = layer.articleId;
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

export const fetchProductDetails = async (productUrl) => {
  const productContext = parseProductUrl(productUrl);
  const attempts = buildAttempts(productContext);
  const failureHistory = [];
  const cachedProducts = await readProductCache();

  for (const attempt of attempts) {
    try {
      const merged = await withPage(
        async (page) => {
          await prewarmSession(page, productContext);
          await page.goto(productContext.productUrl, {
            waitUntil: "domcontentloaded",
            timeout: config.navigationTimeoutMs,
          });
          await page.waitForTimeout(config.pageWaitMs);
          const snapshot = await readPageSnapshot(page);

          if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
            throw new UpstreamBlockError(
              "Zalando blocked the request (login/challenge redirect or access denied page)."
            );
          }

          const jsonLdLayer = extractJsonLdLayer(snapshot.html, productContext.market);
          const domLayer = await extractDomFallback(page);
          const mergedData = mergeProductData(productContext, [jsonLdLayer, domLayer]);

          if (hasUsefulProductData(mergedData)) {
            return mergedData;
          }

          if (isBlocked(snapshot.currentUrl, snapshot.pageTitle)) {
            throw new UpstreamBlockError(
              "Zalando blocked the request (login/challenge redirect or access denied page)."
            );
          }

          throw new UpstreamBlockError(
            "Zalando did not expose enough product data for this request."
          );
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

  if (cachedProducts[productContext.articleId]) {
    return buildCachedResponse(
      cachedProducts[productContext.articleId],
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
