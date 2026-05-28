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

const CAPTCHA_PATTERNS = [
  /\/errors\/validateCaptcha/i,
  /\/captcha\//i,
];

const BLOCK_TITLE_PATTERNS = [
  /robot check/i,
  /captcha/i,
  /sorry/i,
];

const BLOCK_BODY_PATTERNS = [
  /enter the characters you see below/i,
  /type the characters you see in this image/i,
];

const GENERIC_TITLE_PATTERNS = [
  /^amazon\b/i,
  /amazon\.com/i,
  /sign in/i,
];

const MARKET_LOCALE_MAP = {
  es: "es-ES",
  uk: "en-GB",
  de: "de-DE",
  fr: "fr-FR",
  it: "it-IT",
  com: "en-US",
};

const PRODUCT_CACHE_FILE = "amazon-product-cache.json";

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
  if (!productData?.asin) {
    return;
  }

  const cachePath = getProductCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const cache = await readProductCache();
  cache[productData.asin] = {
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

  const asinMatch = parsedUrl.pathname.match(/(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/i);
  const asin = asinMatch?.[1] || parsedUrl.searchParams.get("asin");

  if (!asin) {
    const error = new TypeError("Unable to extract ASIN from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const hostParts = parsedUrl.hostname.split(".");
  const lastPart = hostParts[hostParts.length - 1];
  const secondLastPart = hostParts[hostParts.length - 2];
  const market = secondLastPart === "co" ? "uk" : (lastPart === "com" ? "com" : lastPart);

  // Preserve language prefix (e.g. /-/pt/ on amazon.es means "show in Portuguese")
  const langPrefixMatch = parsedUrl.pathname.match(/^\/-\/([a-z]{2})\//i);
  const langCode = langPrefixMatch?.[1]?.toLowerCase();
  const langPrefix = langCode ? `/-/${langCode}` : "";

  const LANG_LOCALE_MAP = { pt: "pt-PT", en: "en-US", es: "es-ES", de: "de-DE", fr: "fr-FR", it: "it-IT" };
  const locale = (langCode && LANG_LOCALE_MAP[langCode]) || MARKET_LOCALE_MAP[market] || "en-US";

  const cleanPath = `${langPrefix}/dp/${asin.toUpperCase()}`;
  const cleanUrl = `${parsedUrl.origin}${cleanPath}`;

  return {
    asin: asin.toUpperCase(),
    locale,
    market,
    langCode: langCode || null,
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
  const profileBase = productContext.langCode
    ? `amazon-${productContext.market}-${productContext.langCode}`
    : `amazon-${productContext.market}`;

  return getAttemptPlan(config.retryAttempts).map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey:
      candidate.label === "direct"
        ? `${profileBase}-direct`
        : `${profileBase}-${candidate.label}`,
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

const extractScriptLayer = (html, asin) => {
  // GTM dataLayer — Amazon includes ecommerce product data for analytics
  const dataLayerMatch = html.match(/var\s+dataLayer\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (dataLayerMatch) {
    try {
      const entries = JSON.parse(dataLayerMatch[1]);
      for (const entry of entries) {
        const products =
          entry?.ecommerce?.detail?.products ||
          entry?.ecommerce?.impressions ||
          entry?.ecommerce?.items ||
          [];
        const product =
          products.find((p) =>
            String(p?.id || p?.item_id || "").toUpperCase() === asin
          ) || products[0];

        if (product) {
          const price = firstNonEmpty(
            String(product.price ?? ""),
            String(product.item_price ?? "")
          );
          return {
            title: firstNonEmpty(product.name, product.item_name),
            brand: firstNonEmpty(product.brand, product.item_brand),
            color: null,
            colors: [],
            sizes: [],
            variants: [],
            images: [],
            price: {
              amount: price && price !== "" ? price : null,
              formatted: null,
              retailAmount: null,
              retailFormatted: null,
              discountPercent: null,
            },
            sourceStage: "script-datalayer",
          };
        }
      }
    } catch {
      // malformed dataLayer — skip
    }
  }

  // colorImages script — Amazon's image gallery data structure
  const colorImagesMatch = html.match(/var\s+colorImages\s*=\s*\{[^{]*'initial'\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  if (colorImagesMatch) {
    try {
      const entries = JSON.parse(colorImagesMatch[1]);
      const images = unique(
        entries
          .map((entry) => normalizeImageUrl(entry?.hiRes || entry?.large || entry?.main?.["hiRes"] || entry?.main?.["large"]))
          .filter(Boolean)
      );
      if (images.length > 0) {
        return {
          title: null,
          brand: null,
          color: null,
          colors: [],
          sizes: [],
          variants: [],
          images,
          price: { amount: null, formatted: null, retailAmount: null, retailFormatted: null, discountPercent: null },
          sourceStage: "script-color-images",
        };
      }
    } catch {
      // ignore
    }
  }

  // Inline scripts containing the ASIN — look for title/price patterns
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const src = match[1];
    if (!src.toUpperCase().includes(asin)) {
      continue;
    }

    const titleMatch = src.match(/"(?:title|productTitle|item_name|itemName)"\s*:\s*"([^"]{5,})"/i);
    const priceMatch = src.match(/"(?:price|salePrice|sale_price)"\s*:\s*"?([\d.,]+)"?/i);
    const brandMatch = src.match(/"(?:brand|manufacturer|item_brand)"\s*:\s*"([^"]+)"/i);

    if (titleMatch || priceMatch) {
      return {
        title: titleMatch ? titleMatch[1] : null,
        brand: brandMatch ? brandMatch[1] : null,
        color: null,
        colors: [],
        sizes: [],
        variants: [],
        images: [],
        price: {
          amount: priceMatch ? priceMatch[1] : null,
          formatted: null,
          retailAmount: null,
          retailFormatted: null,
          discountPercent: null,
        },
        sourceStage: "script-inline",
      };
    }
  }

  return null;
};

const extractJsonLdLayer = (html) => {
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

  return {
    title: firstNonEmpty(product.name, firstVariant?.name),
    brand: firstNonEmpty(product.brand?.name),
    color: firstNonEmpty(product.color),
    colors: unique([product.color, ...variants.map((v) => v.color)]),
    sizes: unique(variants.map((v) => v.size)),
    variants,
    images: unique((Array.isArray(product.image) ? product.image : [product.image]).filter(Boolean).map(normalizeImageUrl)),
    price: {
      amount: firstNonEmpty(variantOffer?.price, product.offers?.price),
      formatted: null,
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
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

      const parsePrice = (text) => {
        if (!text) {
          return null;
        }

        const cleaned = compact(text);
        const match = cleaned.match(/[\d.,]+/);

        if (!match) {
          return null;
        }

        return match[0].replace(/,(?=\d{3})/g, "");
      };

      const titleEl = document.querySelector("#productTitle");
      const title = titleEl ? compact(titleEl.textContent) : null;

      const salePriceSelectors = [
        ".a-price.priceToPay .a-offscreen",
        ".a-price.a-text-price[data-a-color='price'] .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        ".a-price .a-offscreen",
      ];

      let salePriceText = null;
      let salePriceEl = null;

      for (const sel of salePriceSelectors) {
        const el = document.querySelector(sel);

        if (el) {
          salePriceText = compact(el.textContent);
          salePriceEl = el;
          break;
        }
      }

      let retailPriceText = null;
      const retailCandidates = Array.from(document.querySelectorAll(".a-text-price .a-offscreen"));

      for (const el of retailCandidates) {
        if (el !== salePriceEl) {
          retailPriceText = compact(el.textContent);
          break;
        }
      }

      const brandBylineEl = document.querySelector("#bylineInfo");
      let brand = null;

      if (brandBylineEl) {
        const bylineText = compact(brandBylineEl.textContent);
        const visitMatch =
          bylineText.match(/visit the (.+?) store/i) ||
          bylineText.match(/visita la tienda de (.+?)(?:\s*$)/i) ||
          bylineText.match(/boutique (.+?) sur amazon/i) ||
          bylineText.match(/besuche den shop von (.+?)(?:\s*$)/i) ||
          bylineText.match(/visita il negozio di (.+?)(?:\s*$)/i);
        const brandMatch = bylineText.match(/brand[:\s]+(.+?)(?:\s*$)/i);

        if (visitMatch) {
          brand = visitMatch[1].trim();
        } else if (brandMatch) {
          brand = brandMatch[1].trim();
        } else {
          brand = bylineText || null;
        }
      }

      if (!brand) {
        const brandEl = document.querySelector("#brand") ||
          document.querySelector(".po-brand .a-span9 span");
        brand = brandEl ? compact(brandEl.textContent) : null;
      }

      if (!brand) {
        const addToCartBtn = document.querySelector("#add-to-cart-button");
        brand = addToCartBtn?.getAttribute("data-brand") || null;
      }

      const pickBestFromDynamicImage = (attr) => {
        if (!attr) return null;
        try {
          const map = JSON.parse(attr);
          let bestUrl = null, bestArea = 0;
          for (const [url, dims] of Object.entries(map)) {
            if (Array.isArray(dims) && dims.length >= 2) {
              const area = dims[0] * dims[1];
              if (area > bestArea) { bestArea = area; bestUrl = url; }
            }
          }
          return normalizeUrl(bestUrl);
        } catch {
          return null;
        }
      };

      // Collect all gallery images from data-a-dynamic-image attributes
      const allDynamicEls = Array.from(document.querySelectorAll("[data-a-dynamic-image]"));
      const galleryImages = unique(
        allDynamicEls
          .map((el) => pickBestFromDynamicImage(el.getAttribute("data-a-dynamic-image")))
          .filter(Boolean)
      );

      // Fallback to src if no dynamic images found
      if (galleryImages.length === 0) {
        for (const sel of ["#landingImage", "#imgTagWrappingDiv img", "#main-image-container img", ".imgTagWrapper img"]) {
          const el = document.querySelector(sel);
          if (el?.getAttribute("src")) {
            galleryImages.push(normalizeUrl(el.getAttribute("src")));
            break;
          }
        }
      }

      const images = unique(galleryImages.filter(Boolean));

      // Selected value — inline twister header (new UI) then legacy
      const selectedColorEl =
        document.querySelector("#inline-twister-expanded-dimension-text-color_name") ||
        document.querySelector("#variation_color_name .selection") ||
        document.querySelector(".po-color .a-span9 span");
      const selectedColor = selectedColorEl ? compact(selectedColorEl.textContent) : null;

      const selectedSizeEl =
        document.querySelector("#inline-twister-expanded-dimension-text-size_name") ||
        document.querySelector("#variation_size_name .selection") ||
        document.querySelector(".po-size .a-span9 span");
      const selectedSize = selectedSizeEl ? compact(selectedSizeEl.textContent) : null;

      const isSizePlaceholder = (text) =>
        !text ||
        /^selecionar|^seleccion|^selezion|^wählen|^please select|^choose|^sélection/i.test(text) ||
        /^[←→\d\s]+$/.test(text);

      const isColorPlaceholder = (text) =>
        !text ||
        /^[←→\d\s]+$/.test(text) ||
        text.length < 2;

      // All colors — inline twister li items + legacy
      const colorEls = Array.from(
        document.querySelectorAll([
          "#inline-twister-expander-content-color_name li",
          "[id^='color_name_']:not([id$='-announce'])",
          "#variation_color_name li[title]",
          "#variation_color_name .swatchSelect img[alt]",
          "#color_name li[title]",
        ].join(", "))
      );
      const colors = unique(
        colorEls
          .map((el) => {
            const title = el.getAttribute("title");
            const imgAlt = el.querySelector("img")?.getAttribute("alt");
            const announce = el.querySelector("[id$='-announce']");
            return compact(title || imgAlt || (announce ? announce.textContent : el.textContent));
          })
          .filter((v) => !isColorPlaceholder(v))
      );

      if (selectedColor && !colors.includes(selectedColor)) {
        colors.unshift(selectedColor);
      }

      // All sizes — inline twister announce spans + legacy + dropdown (excluding placeholder)
      const sizeEls = Array.from(
        document.querySelectorAll([
          "[id^='size_name_'][id$='-announce']",
          "#inline-twister-expander-content-size_name li[title]",
          "#variation_size_name li .a-size-base",
          "#variation_size_name li[title]",
          "#native_dropdown_selected_size_name option:not([value=''])",
          "#size_name li .a-size-base",
        ].join(", "))
      );
      const sizes = unique(
        sizeEls
          .map((el) => compact(el.getAttribute("title") || el.textContent).replace(/\s*\($/, "").trim())
          .filter((v) => !isSizePlaceholder(v))
      );

      if (selectedSize && !sizes.includes(selectedSize)) {
        sizes.unshift(selectedSize);
      }

      const saleAmount = parsePrice(salePriceText);

      if (
        !title &&
        !saleAmount &&
        images.length === 0 &&
        colors.length === 0 &&
        sizes.length === 0
      ) {
        return null;
      }

      return {
        title,
        brand,
        color: selectedColor,
        colors: unique(colors),
        sizes: unique(sizes),
        images,
        price: {
          amount: saleAmount,
          formatted: salePriceText,
          retailAmount: parsePrice(retailPriceText),
          retailFormatted: retailPriceText,
          discountPercent: null,
        },
      };
    });

    if (!domData) {
      return null;
    }

    return {
      ...domData,
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

const isBlocked = (url, pageTitle, bodyText) => {
  if (CAPTCHA_PATTERNS.some((p) => p.test(url || ""))) {
    return true;
  }

  if (BLOCK_TITLE_PATTERNS.some((p) => p.test(pageTitle || ""))) {
    return true;
  }

  if (BLOCK_BODY_PATTERNS.some((p) => p.test(bodyText || ""))) {
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
    asin: productContext.asin,
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
    merged.sizes = unique([...merged.sizes, ...(layer.sizes || [])]);
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
        bodyText: await page.evaluate(() => document.body.innerText),
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

          if (isBlocked(snapshot.currentUrl, snapshot.pageTitle, snapshot.bodyText)) {
            throw new UpstreamBlockError(
              "Amazon blocked the request with a CAPTCHA or robot check."
            );
          }

          const jsonLdLayer = extractJsonLdLayer(snapshot.html);
          const scriptLayer = extractScriptLayer(snapshot.html, productContext.asin);
          const domLayer = await extractDomFallback(page);
          const mergedData = mergeProductData(productContext, [jsonLdLayer, scriptLayer, domLayer]);

          if (hasUsefulProductData(mergedData)) {
            return mergedData;
          }

          if (isBlocked(snapshot.currentUrl, snapshot.pageTitle, snapshot.bodyText)) {
            throw new UpstreamBlockError(
              "Amazon blocked the request with a CAPTCHA or robot check."
            );
          }

          throw new UpstreamBlockError(
            "Amazon did not expose enough product data for this request."
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

  if (cachedProducts[productContext.asin]) {
    return buildCachedResponse(
      cachedProducts[productContext.asin],
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
