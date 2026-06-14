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

const RESPONSE_TYPES = {
  productDetail: /\/api\/product\/detail\/index\.htm/i,
  pcDetail: /\/api\/pc\/product-detail\//i,
  skuDetail: /\/api\/sku\/detail\//i,
};

const HUMAN_CHECK_PATTERNS = [
  /slide to verify/i,
  /verify.*human/i,
  /security.*check/i,
  /captcha/i,
  /verificação de segurança/i,
  /vérification de sécurité/i,
  /verificación de seguridad/i,
];

const LOGIN_WALL_PATTERNS = [
  /sign in to aliexpress/i,
  /log in.*aliexpress/i,
  /enter your (email|phone)/i,
];

const GENERIC_PAGE_TITLES = [
  /^aliexpress\b/i,
  /online shopping/i,
  /aliexpress.*free shipping/i,
];

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

const cleanTitle = (title) => {
  if (!title) return null;
  return title
    .replace(/\s*-\s*AliExpress\b.*/i, "")
    .replace(/\s*\|\s*AliExpress\b.*/i, "")
    .replace(/,\s*\d{3,}$/i, "")        // trailing numeric codes like ", 004" or ", 200000343"
    .replace(/,\s*[a-z0-9]{1,6}$/i, "") // trailing short codes like ", 004"
    .trim() || null;
};

const cleanImageUrl = (url) => {
  if (!url) return null;
  // Remove thumbnail suffixes like _220x220q75.jpg_.avif or _220x220xz.jpg_.webp
  if (/_\d+x\d+/.test(url)) return null;
  return url;
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

const PRODUCT_CACHE_FILE = "aliexpress-product-cache.json";

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
  if (!productData?.itemId) return;
  const cachePath = getProductCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const cache = await readProductCache();
  cache[productData.itemId] = { ...productData, cachedAt: new Date().toISOString() };
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
};

const buildCachedResponse = (cachedData, productContext, attempts, failureHistory) => ({
  ...cachedData,
  url: productContext.productUrl,
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

  const pathMatch = parsedUrl.pathname.match(/\/item\/(\d+)\.html/i);
  const itemId = pathMatch?.[1] || parsedUrl.searchParams.get("id");

  if (!itemId) {
    const error = new TypeError("Unable to extract itemId from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const cleanUrl = `${parsedUrl.origin}/item/${itemId}.html`;

  return { itemId, productUrl: cleanUrl };
};

const buildAttempts = (proxyUrls) => {
  const plan = proxyUrls?.length
    ? buildRequestAttemptPlan(proxyUrls, config.retryAttempts)
    : getAttemptPlan(config.retryAttempts);
  return plan.map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey: candidate.label === "direct" ? "aliexpress-direct" : `aliexpress-${candidate.label}`,
  }));
};

const createResponseBucket = () => ({ productDetail: [], pcDetail: [], skuDetail: [] });

const resolveResponseType = (url) => {
  for (const [name, pattern] of Object.entries(RESPONSE_TYPES)) {
    if (pattern.test(url)) return name;
  }
  return null;
};

const parseCapturedResponse = async (response) => {
  const contentType = response.headers()["content-type"] || "";
  if (contentType.includes("application/json")) return response.json();
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const attachResponseCollector = (page, bucket) => {
  const handler = async (response) => {
    const responseType = resolveResponseType(response.url());
    if (!responseType) return;
    try {
      const payload = await parseCapturedResponse(response);
      if (!payload) return;
      bucket[responseType].push({ url: response.url(), payload });
    } catch {
      // ignore unrelated or malformed responses
    }
  };
  page.on("response", handler);
  return () => page.off("response", handler);
};

// AliExpress embeds product data in window.runParams in the page HTML
const extractRunParams = (html) => {
  const match = html.match(/window\.runParams\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
};

const parseJsonLdBlocks = (html) => {
  const blocks = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const source = match[1]?.trim();
    if (!source) continue;
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
    if (!current) continue;
    if (Array.isArray(current)) { queue.push(...current); continue; }
    if (current["@type"] === "Product" || current["@type"] === "ProductGroup") return current;
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
};

// Extract from intercepted network API responses
const extractApiData = (bucket, productContext) => {
  const allEntries = [
    ...bucket.productDetail,
    ...bucket.pcDetail,
    ...bucket.skuDetail,
  ];

  if (allEntries.length === 0) return null;

  // Try each captured response for product data
  for (const entry of allEntries) {
    const payload = entry.payload;

    // New PC API format: data.productInfoComponent, data.priceComponent, etc.
    const info = payload?.data?.productInfoComponent ?? payload?.result?.productInfoComponent;
    const priceComp = payload?.data?.priceComponent ?? payload?.result?.priceComponent;
    const imageComp = payload?.data?.imageComponent ?? payload?.result?.imageComponent;
    const skuComp = payload?.data?.skuComponent ?? payload?.result?.skuComponent;

    if (!info && !priceComp && !imageComp) continue;

    const title = firstNonEmpty(info?.subject, payload?.data?.subject);

    const rawPrice = priceComp?.discountPrice?.minActivityAmount?.value
      ?? priceComp?.originalPrice?.minAmount?.value;
    const formattedPrice = priceComp?.discountPrice?.minActivityAmount?.formattedAmount
      ?? priceComp?.originalPrice?.minAmount?.formattedAmount;
    const retailFormatted = priceComp?.originalPrice?.minAmount?.formattedAmount;

    const images = unique(
      (imageComp?.imagePathList ?? []).map(normalizeImageUrl).filter(Boolean)
    );

    const colors = [];
    const sizes = [];
    const variants = [];

    if (skuComp?.skuPropertyList) {
      for (const prop of skuComp.skuPropertyList) {
        const name = prop.skuPropertyName?.toLowerCase() ?? "";
        const values = (prop.skuPropertyValues ?? []).map((v) => v.propertyValueDisplayName).filter(Boolean);
        if (/color|colour|cor/i.test(name)) colors.push(...values);
        else if (/size|tamanho|taille|talla/i.test(name)) sizes.push(...values);
      }
    }

    if (skuComp?.skuList) {
      for (const sku of skuComp.skuList) {
        const propPairs = sku.skuPropIds?.split(",") ?? [];
        variants.push(normalizeVariant({
          sku: firstNonEmpty(String(sku.skuId ?? "")),
          size: null,
          color: null,
          price: sku.skuVal?.skuAmount?.value ? String(sku.skuVal.skuAmount.value) : null,
          availability: sku.skuVal?.availQuantity > 0 ? "InStock" : "OutOfStock",
          url: null,
        }));
      }
    }

    return {
      itemId: productContext.itemId,
      title,
      color: colors[0] || null,
      colors: unique(colors),
      sizes: unique(sizes),
      variants: uniqueBy(variants.filter(Boolean), (v) => v.sku || `${v.size}-${v.color}`),
      brand: firstNonEmpty(info?.brandName),
      price: {
        amount: rawPrice ? String(rawPrice) : null,
        formatted: firstNonEmpty(formattedPrice),
        retailAmount: null,
        retailFormatted: firstNonEmpty(retailFormatted),
        discountPercent: firstNonEmpty(priceComp?.discount),
      },
      images,
      sourceStage: "network-json",
    };
  }

  return null;
};

// Extract from window.runParams embedded in HTML
const extractRunParamsData = (html, productContext) => {
  const runParams = extractRunParams(html);
  if (!runParams) return null;

  // runParams.data contains the product modules
  const data = runParams.data ?? runParams;

  const titleModule = data.titleModule ?? data.productInfoComponent;
  const priceModule = data.priceModule ?? data.priceComponent;
  const imageModule = data.imageModule ?? data.imageComponent;
  const skuModule = data.skuModule ?? data.skuComponent;
  const specsModule = data.specsModule ?? data.specsComponent;

  const title = firstNonEmpty(
    titleModule?.subject,
    titleModule?.title,
    data.subject,
    data.title
  );

  if (!title && !imageModule && !priceModule) return null;

  const rawPrice = priceModule?.formatedActivityPrice
    ?? priceModule?.formatedPrice
    ?? priceModule?.minActivityAmount?.formattedAmount;
  const retailFormatted = priceModule?.formatedPrice ?? priceModule?.originalPrice?.formattedAmount;

  const imageList = imageModule?.imagePathList
    ?? imageModule?.summImages
    ?? [];
  const images = unique(imageList.map(normalizeImageUrl).filter(Boolean));

  const colors = [];
  const sizes = [];
  const variants = [];

  const props = skuModule?.productSKUPropertyList ?? skuModule?.skuPropertyList ?? [];
  for (const prop of props) {
    const name = (prop.skuPropertyName ?? prop.propertyName ?? "").toLowerCase();
    const values = (prop.skuPropertyValues ?? prop.values ?? [])
      .map((v) => firstNonEmpty(v.propertyValueDisplayName, v.displayName, v.value))
      .filter(Boolean);
    if (/color|colour|cor/i.test(name)) colors.push(...values);
    else if (/size|tamanho|taille|talla/i.test(name)) sizes.push(...values);
  }

  const skuList = skuModule?.skuPriceList ?? skuModule?.skuList ?? [];
  for (const sku of skuList) {
    variants.push(normalizeVariant({
      sku: firstNonEmpty(String(sku.skuId ?? sku.id ?? "")),
      size: null,
      color: null,
      price: sku.skuVal?.skuAmount?.value
        ? String(sku.skuVal.skuAmount.value)
        : firstNonEmpty(sku.skuActivityAmount?.value, sku.skuAmount?.value),
      availability: sku.skuVal?.availQuantity > 0 ? "InStock" : "OutOfStock",
      url: null,
    }));
  }

  return {
    itemId: productContext.itemId,
    title,
    color: colors[0] || null,
    colors: unique(colors),
    sizes: unique(sizes),
    variants: uniqueBy(variants.filter(Boolean), (v) => v.sku || `${v.size}-${v.color}`),
    brand: firstNonEmpty(data.storeBriefInfo?.storeName),
    price: {
      amount: null,
      formatted: firstNonEmpty(rawPrice),
      retailAmount: null,
      retailFormatted: firstNonEmpty(retailFormatted),
      discountPercent: firstNonEmpty(priceModule?.discount),
    },
    images,
    sourceStage: "run-params",
  };
};

const extractStructuredFallback = (html) => {
  const blocks = parseJsonLdBlocks(html);
  const product = findProductJsonLd(blocks);
  if (!product) return null;

  const firstVariant = Array.isArray(product.hasVariant) ? product.hasVariant[0] : null;
  const variantOffer = firstVariant?.offers;
  const variants = Array.isArray(product.hasVariant)
    ? uniqueBy(
        product.hasVariant
          .map((v) => normalizeVariant({
            sku: v.sku,
            size: v.size,
            color: v.color || product.color,
            price: v.offers?.price,
            availability: v.offers?.availability,
            url: v.offers?.url,
          }))
          .filter(Boolean),
        (v) => v.sku || `${v.size}-${v.color}`
      )
    : [];

  const rawAmount = firstNonEmpty(variantOffer?.price, product.offers?.price);

  return {
    title: cleanTitle(firstNonEmpty(product.name, firstVariant?.name)),
    color: firstNonEmpty(product.color),
    colors: unique([product.color, ...variants.map((v) => v.color)]),
    sizes: unique(variants.map((v) => v.size)),
    variants,
    images: unique((product.image || []).map(normalizeImageUrl).map(cleanImageUrl).filter(Boolean)),
    price: {
      amount: rawAmount ? String(rawAmount) : null,
      formatted: rawAmount ? `€${rawAmount}` : null,
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
    brand: firstNonEmpty(product.brand?.name),
    sourceStage: "json-ld",
  };
};

const extractDomFallback = async (page) => {
  try {
    const domData = await page.evaluate(() => {
      const compact = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
      const unique = (arr) => [...new Set(arr.filter(Boolean))];
      const normalizeUrl = (v) => {
        if (!v || typeof v !== "string") return null;
        if (v.startsWith("//")) return `https:${v}`;
        if (v.startsWith("http://")) return `https://${v.slice("http://".length)}`;
        return v;
      };

      const titleEl = document.querySelector("h1") || document.querySelector('[class*="product-title"]');
      const title = compact(titleEl?.textContent);

      const priceEl = document.querySelector('[class*="price--current"]') || document.querySelector('[class*="uniform-banner-box-price"]');
      const price = compact(priceEl?.textContent);

      // AliExpress color selectors — try multiple patterns as class names change frequently
      const colorCandidates = [
        // Image-based color swatches with title/alt
        ...Array.from(document.querySelectorAll('[class*="sku"] img[title], [class*="sku"] img[alt]'))
          .map((el) => compact(el.getAttribute("title") || el.getAttribute("alt"))),
        // Span/div with aria-label inside sku containers
        ...Array.from(document.querySelectorAll('[class*="sku"] [aria-label]'))
          .map((el) => compact(el.getAttribute("aria-label"))),
        // data-spm-anchor-id often on color items
        ...Array.from(document.querySelectorAll('[class*="color"] img'))
          .map((el) => compact(el.getAttribute("title") || el.getAttribute("alt"))),
      ];
      const colors = unique(
        colorCandidates.filter((v) => v && v.length > 1 && v.length <= 50 && !/^\d+$/.test(v))
      );

      const sizeEls = Array.from(document.querySelectorAll(
        '[class*="sku-item--size"] span, [class*="sku-item--text"], ' +
        '[class*="size-item"], [class*="skuSize"] span'
      ));
      const sizes = unique(sizeEls.map((el) => compact(el.textContent)).filter((v) => v && v.length <= 10));

      const imgEls = Array.from(document.querySelectorAll(
        '[class*="slider--img"] img, [class*="product-image"] img, ' +
        '[class*="gallery"] img, [class*="magnifier"] img'
      ));
      const images = unique(
        imgEls
          .map((el) => normalizeUrl(el.getAttribute("src") || el.getAttribute("data-src")))
          .filter((url) => url && !/_\d+x\d+/.test(url))
      );

      if (!title && colors.length === 0 && sizes.length === 0 && images.length === 0) return null;

      return {
        title: title || null,
        color: colors[0] || null,
        colors,
        sizes,
        variants: [],
        images,
        price: price ? { amount: null, formatted: price, retailAmount: null, retailFormatted: null, discountPercent: null } : null,
      };
    });

    if (!domData) return null;
    return { ...domData, sourceStage: "dom-live" };
  } catch {
    return null;
  }
};

const mergeProductData = (productContext, layers) => {
  const sourceChain = [];
  const merged = {
    itemId: productContext.itemId,
    title: null,
    color: null,
    colors: [],
    sizes: [],
    variants: [],
    brand: null,
    price: { amount: null, formatted: null, retailAmount: null, retailFormatted: null, discountPercent: null },
    images: [],
    url: productContext.productUrl,
    sourceChain,
    fieldSources: {},
  };

  for (const layer of layers) {
    if (!layer) continue;

    if (!merged.title || isGenericTitle(merged.title)) {
      const next = firstNonEmpty(layer.title, merged.title);
      if (next && next !== merged.title) {
        merged.title = next;
        if (layer.sourceStage && !merged.fieldSources.title) merged.fieldSources.title = layer.sourceStage;
      }
    }

    if (!merged.color || layer.sourceStage === "dom-live") {
      const next = firstNonEmpty(layer.color, merged.color);
      if (next) { merged.color = next; merged.fieldSources.color = layer.sourceStage; }
    }

    const prevColors = merged.colors.length;
    merged.colors = unique([...merged.colors, ...(layer.colors || [])]);
    if (merged.colors.length > prevColors && layer.sourceStage && !merged.fieldSources.colors)
      merged.fieldSources.colors = layer.sourceStage;

    const prevSizes = merged.sizes.length;
    merged.sizes = unique([...merged.sizes, ...(layer.sizes || [])]);
    if (merged.sizes.length > prevSizes && layer.sourceStage && !merged.fieldSources.sizes)
      merged.fieldSources.sizes = layer.sourceStage;

    const prevVariants = merged.variants.length;
    merged.variants = uniqueBy(
      [...merged.variants, ...((layer.variants || []).map(normalizeVariant).filter(Boolean))],
      (v) => v.sku || `${v.size}-${v.color}`
    );
    if (merged.variants.length > prevVariants && layer.sourceStage && !merged.fieldSources.variants)
      merged.fieldSources.variants = layer.sourceStage;

    if (!merged.brand) {
      merged.brand = firstNonEmpty(layer.brand);
      if (merged.brand && layer.sourceStage) merged.fieldSources.brand = layer.sourceStage;
    }

    const prevAmount = merged.price.amount;
    merged.price.amount = firstNonEmpty(merged.price.amount, layer.price?.amount);
    merged.price.formatted = firstNonEmpty(merged.price.formatted, layer.price?.formatted);
    merged.price.retailAmount = firstNonEmpty(merged.price.retailAmount, layer.price?.retailAmount);
    merged.price.retailFormatted = firstNonEmpty(merged.price.retailFormatted, layer.price?.retailFormatted);
    merged.price.discountPercent = firstNonEmpty(merged.price.discountPercent, layer.price?.discountPercent);
    if (!prevAmount && merged.price.amount && layer.sourceStage && !merged.fieldSources.price)
      merged.fieldSources.price = layer.sourceStage;

    const prevImages = merged.images.length;
    merged.images = unique([...merged.images, ...(layer.images || [])]);
    if (merged.images.length > prevImages && layer.sourceStage && !merged.fieldSources.images)
      merged.fieldSources.images = layer.sourceStage;

    if (layer.sourceStage) sourceChain.push(layer.sourceStage);
  }

  return merged;
};

const isGenericTitle = (title) => {
  if (!title || typeof title !== "string") return true;
  return GENERIC_PAGE_TITLES.some((p) => p.test(title.trim()));
};

const hasUsefulProductData = (data) =>
  Boolean(
    data.price.amount ||
    data.price.formatted ||
    data.images.length > 0 ||
    (data.title && !isGenericTitle(data.title))
  );

const isHumanCheck = (bodyText, pageTitle) =>
  HUMAN_CHECK_PATTERNS.some((p) => p.test(bodyText) || p.test(pageTitle || ""));

const isLoginWall = (bodyText, pageTitle) =>
  LOGIN_WALL_PATTERNS.some((p) => p.test(bodyText) || p.test(pageTitle || ""));

const readPageSnapshot = async (page) => {
  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: config.requestTimeoutMs });
      return {
        pageTitle: await page.title(),
        html: await page.content(),
        bodyText: await page.evaluate(() => document.body.innerText),
      };
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }
  throw lastError;
};

const navigateToProduct = async (page, productUrl) => {
  try {
    await page.goto(productUrl, { waitUntil: "commit", timeout: config.navigationTimeoutMs });
  } catch (error) {
    const msg = error.message || "";
    if (!msg.includes("ERR_ABORTED") && !msg.includes("interrupted by another navigation")) throw error;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: config.requestTimeoutMs });
};

const waitForHumanVerification = async (page) => {
  if (config.browserHeadless) {
    throw new UpstreamBlockError(
      "AliExpress requested human verification. Set BROWSER_HEADLESS=false, solve the captcha in the opened browser, and retry.",
      { requiresHumanVerification: true, verificationWaitMs: config.verificationWaitMs }
    );
  }
  try {
    await page.waitForFunction(
      () => {
        const text = (document.body?.innerText || "") + (document.title || "");
        return !/slide to verify|verify.*human|security.*check|captcha/i.test(text);
      },
      { timeout: config.verificationWaitMs }
    );
  } catch {
    throw new UpstreamBlockError(
      "AliExpress requested human verification. Solve it in the browser window and wait for the product page to resume.",
      { requiresHumanVerification: true, verificationWaitMs: config.verificationWaitMs }
    );
  }
};

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

export const fetchProductDetails = async (productUrl, options = {}) => {
  const productContext = parseProductUrl(productUrl);
  const attempts = buildAttempts(options.proxyUrls);
  const failureHistory = [];
  const cachedProducts = await readProductCache();

  for (const attempt of attempts) {
    try {
      const merged = await withPage(
        async (page) => {
          const bucket = createResponseBucket();
          const detachCollector = attachResponseCollector(page, bucket);

          try {
            await navigateToProduct(page, productContext.productUrl);
            await page.waitForTimeout(config.pageWaitMs);

            try {
              await page.waitForFunction(
                () => (document.body?.innerText?.replace(/[​\s]/g, "").length ?? 0) > 50,
                { timeout: 12000 }
              );
            } catch {
              // SPA did not render visible content in time — proceed anyway
            }

            let snapshot = await readPageSnapshot(page);

            if (isLoginWall(snapshot.bodyText, snapshot.pageTitle)) {
              throw new UpstreamBlockError("AliExpress is showing a login wall.");
            }

            if (isHumanCheck(snapshot.bodyText, snapshot.pageTitle)) {
              await waitForHumanVerification(page);
              snapshot = await readPageSnapshot(page);
            }

            if (isHumanCheck(snapshot.bodyText, snapshot.pageTitle)) {
              throw new UpstreamBlockError(
                "AliExpress requested human verification before exposing product data."
              );
            }

            const networkData = extractApiData(bucket, productContext);
            const runParamsData = extractRunParamsData(snapshot.html, productContext);
            const structuredFallback = extractStructuredFallback(snapshot.html);
            const domFallback = await extractDomFallback(page);

            const mergedData = mergeProductData(productContext, [
              networkData,
              runParamsData,
              structuredFallback,
              domFallback,
            ]);

            if (hasUsefulProductData(mergedData)) return mergedData;

            throw new UpstreamBlockError(
              "AliExpress did not expose enough product data for this request."
            );
          } finally {
            detachCollector();
          }
        },
        { profileKey: attempt.profileKey, proxyUrl: attempt.proxyUrl }
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
      if (!classifiedError.retryable) throw error;
    }
  }

  if (cachedProducts[productContext.itemId]) {
    return buildCachedResponse(
      cachedProducts[productContext.itemId],
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
