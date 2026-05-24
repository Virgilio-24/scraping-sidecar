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

const RESPONSE_TYPES = {
  realtime: /\/bff-api\/product\/get_goods_detail_realtime_data/i,
  detailAbt: /\/bff-api\/products-api\/get_detail_abt_info/i,
  images: /\/bff-api\/product\/get_goods_detail_image/i,
};

const HUMAN_CHECK_PATTERNS = [
  /verify that you are human/i,
  /verificar que voce e humano/i,
  /verificar que você é humano/i,
  /sou humano/i,
  /captcha/i,
];

const HUMAN_BUTTON_PATTERNS = [
  /sou humano/i,
  /i am human/i,
  /verify/i,
  /verificar/i,
  /continue/i,
];

const GENERIC_PAGE_TITLES = [
  /roupas femininas e masculinas, loja de moda online/i,
  /women'?s fashion|men'?s fashion/i,
  /^shein\b/i,
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

const COLOR_HINTS = [
  "amarelo manteiga",
  "butter yellow",
  "amarelo",
  "yellow",
  "preto",
  "black",
  "branco",
  "white",
  "bege",
  "beige",
  "azul",
  "blue",
  "verde",
  "green",
  "vermelho",
  "red",
  "rosa",
  "pink",
  "roxo",
  "purple",
  "castanho",
  "marrom",
  "brown",
  "cinza",
  "gray",
  "grey",
  "laranja",
  "orange",
];

const inferColorFromText = (...values) => {
  const haystack = values
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
    .toLowerCase();

  if (!haystack) {
    return null;
  }

  return COLOR_HINTS.find((hint) => haystack.includes(hint)) || null;
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

const normalizeGoodsImages = (goodsImages) => {
  if (!Array.isArray(goodsImages)) {
    return [];
  }

  return unique(
    goodsImages
      .map((image) => {
        if (typeof image === "string") {
          return normalizeImageUrl(image);
        }

        if (!image || typeof image !== "object") {
          return null;
        }

        return normalizeImageUrl(
          image.origin_image ||
            image.image ||
            image.thumbnail ||
            image.url ||
            image.masterUrl ||
            image.goods_image
        );
      })
      .filter(Boolean)
  );
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

const PRODUCT_CACHE_FILE = "product-cache.json";

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
  if (!productData?.goodsId) {
    return;
  }

  const cachePath = getProductCachePath();
  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const cache = await readProductCache();
  cache[productData.goodsId] = {
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

const stripSheinSuffix = (title) => {
  if (!title || typeof title !== "string") {
    return null;
  }

  return title.replace(/\s*\|\s*SHEIN.*$/i, "").trim() || null;
};

const findFirstValueByKeys = (input, keys) => {
  const wanted = new Set(keys);
  const queue = [input];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key) && typeof value === "string" && value.trim()) {
        return value.trim();
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
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

  const goodsIdMatch = parsedUrl.pathname.match(/-p-(\d+)\.html/i);

  if (!goodsIdMatch) {
    const error = new TypeError("Unable to extract goodsId from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const market = parsedUrl.hostname.split(".")[0] || "www";
  const locale = market === "pt" ? "pt-PT" : "en-US";

  return {
    goodsId: goodsIdMatch[1],
    locale,
    market,
    origin: parsedUrl.origin,
    productUrl: parsedUrl.toString(),
  };
};

const buildAttempts = (productContext) => {
  return getAttemptPlan(config.retryAttempts).map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey:
      candidate.label === "direct"
        ? `${productContext.market}-direct-seeded`
        : `${productContext.market}-${candidate.label}`,
  }));
};

const createResponseBucket = () => ({
  realtime: null,
  detailAbt: null,
  images: null,
});

const resolveResponseType = (url) => {
  for (const [name, pattern] of Object.entries(RESPONSE_TYPES)) {
    if (pattern.test(url)) {
      return name;
    }
  }

  return null;
};

const attachResponseCollector = (page, bucket) => {
  const handler = async (response) => {
    const responseType = resolveResponseType(response.url());

    if (!responseType) {
      return;
    }

    const contentType = response.headers()["content-type"] || "";

    if (!contentType.includes("application/json")) {
      return;
    }

    try {
      bucket[responseType] = await response.json();
    } catch {
      bucket[responseType] = null;
    }
  };

  page.on("response", handler);

  return () => {
    page.off("response", handler);
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

const extractProductSectionText = (bodyText, pageTitle) => {
  if (!bodyText) {
    return "";
  }

  const normalizedBodyText = bodyText.replace(/\s+/g, " ").trim();
  const title = stripSheinSuffix(pageTitle);

  if (!title) {
    return normalizedBodyText;
  }

  const startIndex = normalizedBodyText.lastIndexOf(title);

  if (startIndex === -1) {
    return normalizedBodyText;
  }

  return normalizedBodyText.slice(startIndex, startIndex + 2200);
};

const extractStructuredFallback = (html) => {
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
    color: firstNonEmpty(product.color),
    colors: unique([product.color, ...variants.map((variant) => variant.color)]),
    sizes: unique(variants.map((variant) => variant.size)),
    variants,
    images: unique((product.image || []).map(normalizeImageUrl)),
    price: {
      amount: firstNonEmpty(variantOffer?.price, product.offers?.price),
      formatted: null,
      retailAmount: null,
      retailFormatted: null,
      discountPercent: null,
    },
    brand: firstNonEmpty(product.brand?.name),
    sourceStage: "json-ld",
  };
};

const extractHtmlFallback = (html, pageTitle) => {
  const salePriceMatch = html.match(/"salePrice"\s*:\s*\{[^}]*"amount"\s*:\s*"([^"]+)"/i);
  const retailPriceMatch = html.match(/"retailPrice"\s*:\s*\{[^}]*"amount"\s*:\s*"([^"]+)"/i);
  const goodsSnMatch = html.match(/"goods_sn"\s*:\s*"([^"]+)"/i);
  const colorMatch = html.match(/"color"\s*:\s*"([^"]+)"/i);

  return {
    goodsSn: goodsSnMatch?.[1] || null,
    title: stripSheinSuffix(pageTitle),
    color: colorMatch?.[1] || null,
    colors: unique([colorMatch?.[1]]),
    sizes: unique(
      [...html.matchAll(/\b(\d{2}(?:\/\d{2})?\s*\([A-Z]+\)|XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)\b/g)]
        .map((match) => match[1])
        .filter(Boolean)
    ),
    variants: [],
    price: {
      amount: salePriceMatch?.[1] || null,
      formatted: null,
      retailAmount: retailPriceMatch?.[1] || null,
      retailFormatted: null,
      discountPercent: null,
    },
    images: [],
    sourceStage: "html-regex",
  };
};

const extractTextFallback = (bodyText, pageTitle) => {
  const productText = extractProductSectionText(bodyText, pageTitle);

  if (!productText) {
    return null;
  }

  const colorMatch =
    productText.match(/Cor:\s*([\p{L}\s-]+?)(?:Imagem grande|Tamanho|Guia de tamanhos|$)/iu) ||
    productText.match(/Cor\s*([\p{L}\s-]+?)(?:Imagem grande|Tamanho|Guia de tamanhos|$)/iu);
  const sizeBlockMatch = productText.match(
    /Tamanho(?:EU Tamanho)?(?:\s*por favor escolha Tamanho)?([\s\S]{0,160}?)(?:Guia de tamanhos|ADICIONAR AO CARRINHO|Não é o seu tamanho|\n\n)/i
  );
  const rawSizes = sizeBlockMatch?.[1] || productText;
  const sizes = unique(
    [
      ...rawSizes.matchAll(/\d{2}(?:\/\d{2})?\s*\([A-Z]+\)/g),
      ...rawSizes.matchAll(/\b(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)\b/g),
    ]
      .map((match) => match[0]?.trim())
      .filter(Boolean)
  );

  return {
    color: colorMatch?.[1]?.trim() || null,
    colors: unique([colorMatch?.[1]?.trim()]),
    sizes,
    variants: [],
    sourceStage: "body-text",
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
      const sizePattern = /\b(?:\d{2}(?:\/\d{2})?\s*\([A-Z]+\)|XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)\b/g;
      const productIntro =
        document.querySelector('.atf-right, .purchase-control, .goods-detail.product-intro') ||
        document.body;
      const bodyText = compact(productIntro?.innerText || document.body?.innerText || '');
      const optionTexts = Array.from(
        productIntro.querySelectorAll("button, [role='button'], label, [aria-label], [title], span")
      )
        .map((node) =>
          compact(
            node.getAttribute?.("aria-label") || node.getAttribute?.("title") || node.textContent
          )
        )
        .filter(Boolean);

      const parseJsonLdBlocks = () =>
        Array.from(document.querySelectorAll("script[type='application/ld+json']"))
          .map((node) => node.textContent?.trim())
          .filter(Boolean)
          .flatMap((source) => {
            try {
              return [JSON.parse(source)];
            } catch {
              return [];
            }
          });

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

      const product = findProductJsonLd(parseJsonLdBlocks());
      const jsonLdVariants = Array.isArray(product?.hasVariant)
        ? product.hasVariant
            .map((variant) => ({
              sku: compact(variant?.sku),
              size: compact(variant?.size),
              color: compact(variant?.color || product?.color),
              price: compact(String(variant?.offers?.price || "")),
              availability: compact(variant?.offers?.availability),
              url: compact(variant?.offers?.url),
            }))
            .filter((variant) =>
              variant.sku || variant.size || variant.color || variant.price || variant.url
            )
        : [];
      const colorMatch =
        bodyText.match(/Cor:\s*([\p{L}\s-]+?)(?:Imagem grande|Tamanho|Guia de tamanhos|$)/iu) ||
        bodyText.match(/Cor\s*([\p{L}\s-]+?)(?:Imagem grande|Tamanho|Guia de tamanhos|$)/iu);
      const colorSection =
        document.querySelector('.product-intro__color, [class*="product-intro__color"]') ||
        productIntro;
      const colorOptions = unique(
        Array.from(
          colorSection.querySelectorAll(
            '.radio-container[aria-label], .radio-container[title], [role="radio"][aria-label], [role="radio"][title], .sub-title'
          )
        )
          .map((node) =>
            compact(node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.textContent)
          )
          .filter(
            (value) =>
              value &&
              !/^Cor\b/i.test(value) &&
              !/Imagem grande/i.test(value) &&
              !/Mostrar mais cores/i.test(value)
          )
      );
      const activeColor = compact(
        colorSection.querySelector('.radio-container.active')?.getAttribute?.('aria-label') ||
          colorSection.querySelector('.sub-title')?.textContent
      );
      const sizes = unique([
        ...Array.from(bodyText.matchAll(sizePattern), (match) => compact(match[0])),
        ...optionTexts.flatMap((text) =>
          Array.from(text.matchAll(sizePattern), (match) => compact(match[0]))
        ),
        ...jsonLdVariants.map((variant) => compact(variant.size)),
      ]);
      const colors = unique([
        activeColor,
        ...colorOptions,
        compact(colorMatch?.[1]),
        compact(product?.color),
        ...jsonLdVariants.map((variant) => compact(variant.color)),
      ]);
      const images = unique(
        (Array.isArray(product?.image) ? product.image : [])
          .map(normalizeUrl)
          .filter(Boolean)
      );

      if (colors.length === 0 && sizes.length === 0 && jsonLdVariants.length === 0 && images.length === 0) {
        return null;
      }

      return {
        color: activeColor || compact(colorMatch?.[1]) || compact(product?.color) || null,
        colors,
        sizes,
        variants: jsonLdVariants,
        images,
      };
    });

    if (!domData) {
      return null;
    }

    return {
      ...domData,
      sourceStage: "dom-live",
    };
  } catch {
    return null;
  }
};

const readBrowserStorage = async (page) => {
  try {
    return await page.evaluate(() => ({
      pcRecentViews: window.localStorage.getItem("pc_recent_views"),
    }));
  } catch {
    return { pcRecentViews: null };
  }
};

const extractStorageFallback = (productContext, browserStorage) => {
  const rawRecentViews = browserStorage?.pcRecentViews;

  if (!rawRecentViews) {
    return null;
  }

  try {
    const entries = JSON.parse(rawRecentViews);

    if (!Array.isArray(entries)) {
      return null;
    }

    const matchingEntry = entries.find((entry) => {
      const goodsId = firstNonEmpty(entry?.goods_id, entry?.goodsId?.goods_id);
      return goodsId === productContext.goodsId;
    });

    if (!matchingEntry) {
      return null;
    }

    const goods = matchingEntry.goodsId || matchingEntry;

    return {
      goodsId: productContext.goodsId,
      goodsSn: firstNonEmpty(goods.goods_sn, matchingEntry.goods_sn),
      title: firstNonEmpty(goods.goods_name, matchingEntry.goods_name),
      color: null,
      colors: [],
      sizes: [],
      variants: [],
      price: {
        amount: firstNonEmpty(goods.salePrice?.amount),
        formatted: firstNonEmpty(goods.salePrice?.amountWithSymbol),
        retailAmount: firstNonEmpty(goods.retailPrice?.amount),
        retailFormatted: firstNonEmpty(goods.retailPrice?.amountWithSymbol),
        discountPercent: firstNonEmpty(goods.unit_discount),
      },
      images: unique(
        [goods.goods_img, goods.goods_thumb, matchingEntry.goods_img].map(normalizeImageUrl)
      ),
      sourceStage: "storage-recent-views",
    };
  } catch {
    return null;
  }
};

const extractSaleAttrOptions = (saleAttr, patterns) => {
  const groups = [];
  const queue = Array.isArray(saleAttr) ? [...saleAttr] : [saleAttr];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const name = firstNonEmpty(
      current.attr_name,
      current.attrName,
      current.name,
      current.label,
      current.title
    );
    const list =
      current.attr_value_list ||
      current.attrValueList ||
      current.sale_attr_list ||
      current.saleAttrList ||
      current.options ||
      current.values ||
      current.children;

    if (name && Array.isArray(list) && patterns.some((pattern) => pattern.test(name))) {
      groups.push(
        ...list.map((item) =>
          firstNonEmpty(
            item?.attr_value,
            item?.attrValue,
            item?.option_name,
            item?.optionName,
            item?.label,
            item?.name,
            item?.value,
            item?.text
          )
        )
      );
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return unique(groups);
};

const extractApiData = (bucket, productContext) => {
  const realtimeInfo = bucket.realtime?.info || {};
  const detailAbtInfo = bucket.detailAbt?.info?.detailAbtInfoList?.[0] || {};
  const productInfo = realtimeInfo.productInfo || {};
  const priceInfo = realtimeInfo.priceInfo || {};
  const sizes = extractSaleAttrOptions(realtimeInfo.saleAttr, [/size|tamanho/i]);
  const colors = extractSaleAttrOptions(realtimeInfo.saleAttr, [/color|cor/i]);

  return {
    goodsId: productContext.goodsId,
    goodsSn: firstNonEmpty(productInfo.goods_sn),
    title: firstNonEmpty(
      findFirstValueByKeys(detailAbtInfo, ["goodsTitle", "title", "goods_name"]),
      findFirstValueByKeys(productInfo, ["goodsTitle", "title", "goods_name"])
    ),
    color: firstNonEmpty(
      findFirstValueByKeys(realtimeInfo.saleAttr, ["color", "attr_value", "attrValue"])
    ),
    colors,
    sizes,
    variants: [],
    price: {
      amount: firstNonEmpty(priceInfo.salePrice?.amount),
      formatted: firstNonEmpty(priceInfo.salePrice?.amountWithSymbol),
      retailAmount: firstNonEmpty(priceInfo.retailPrice?.amount),
      retailFormatted: firstNonEmpty(priceInfo.retailPrice?.amountWithSymbol),
      discountPercent: firstNonEmpty(priceInfo.unitDiscount),
    },
    images: normalizeGoodsImages(bucket.images?.info?.goods_images),
    sourceStage: "network-json",
  };
};

const mergeProductData = (productContext, layers) => {
  const sourceChain = [];
  const merged = {
    goodsId: productContext.goodsId,
    goodsSn: null,
    title: null,
    color: null,
    colors: [],
    sizes: [],
    variants: [],
    brand: null,
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

    const previousGoodsSn = merged.goodsSn;
    merged.goodsSn = firstNonEmpty(merged.goodsSn, layer.goodsSn);
    if (!previousGoodsSn && merged.goodsSn && layer.sourceStage && !merged.fieldSources.goodsSn) {
      merged.fieldSources.goodsSn = layer.sourceStage;
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

    const previousBrand = merged.brand;
    merged.brand = firstNonEmpty(merged.brand, layer.brand);
    if (!previousBrand && merged.brand && layer.sourceStage && !merged.fieldSources.brand) {
      merged.fieldSources.brand = layer.sourceStage;
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

  if (!merged.color) {
    merged.color = inferColorFromText(merged.title);
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

const trySolveHumanCheck = async (page) => {
  for (const pattern of HUMAN_BUTTON_PATTERNS) {
    const locator = page.getByRole("button", { name: pattern }).first();

    if ((await locator.count()) === 0) {
      continue;
    }

    try {
      await locator.click({ timeout: 3000 });
      await page.waitForTimeout(config.humanSolveWaitMs);
      return true;
    } catch {
      continue;
    }
  }

  const textLocator = page.getByText(/sou humano|i am human|verificar/i).first();

  if ((await textLocator.count()) === 0) {
    return false;
  }

  try {
    await textLocator.click({ timeout: 3000 });
    await page.waitForTimeout(config.humanSolveWaitMs);
    return true;
  } catch {
    return false;
  }
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
      };
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }

  throw lastError;
};

const isHumanCheck = (html, pageTitle) => {
  return HUMAN_CHECK_PATTERNS.some(
    (pattern) => pattern.test(html) || pattern.test(pageTitle || "")
  );
};

const isGenericTitle = (title) => {
  if (!title || typeof title !== "string") {
    return true;
  }

  return GENERIC_PAGE_TITLES.some((pattern) => pattern.test(title.trim()));
};

const hasUsefulProductData = (data) => {
  return Boolean(
    data.goodsSn ||
      data.price.amount ||
      data.images.length > 0 ||
      (data.title && !isGenericTitle(data.title))
  );
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
      const merged = await withPage(async (page) => {
        const bucket = createResponseBucket();
        const detachCollector = attachResponseCollector(page, bucket);

        try {
          await prewarmSession(page, productContext);
          await page.goto(productContext.productUrl, {
            waitUntil: "domcontentloaded",
            timeout: config.navigationTimeoutMs,
          });
          await page.waitForTimeout(config.pageWaitMs);

          let snapshot = await readPageSnapshot(page);

          if (isHumanCheck(snapshot.html, snapshot.pageTitle)) {
            await trySolveHumanCheck(page);
            snapshot = await readPageSnapshot(page);
          }

          const networkData = extractApiData(bucket, productContext);
          const structuredFallback = extractStructuredFallback(snapshot.html);
          const htmlFallback = extractHtmlFallback(snapshot.html, snapshot.pageTitle);
          const domFallback = await extractDomFallback(page);
          const textFallback = extractTextFallback(snapshot.bodyText, snapshot.pageTitle);
          const browserStorage = await readBrowserStorage(page);
          const storageFallback = extractStorageFallback(productContext, browserStorage);
          const mergedData = mergeProductData(productContext, [
            networkData,
            structuredFallback,
            htmlFallback,
            domFallback,
            textFallback,
            storageFallback,
          ]);

          if (hasUsefulProductData(mergedData)) {
            return mergedData;
          }

          if (isHumanCheck(snapshot.html, snapshot.pageTitle)) {
            throw new UpstreamBlockError(
              "SHEIN requested human verification before exposing product data."
            );
          }

          throw new UpstreamBlockError(
            "SHEIN did not expose enough product data for this request."
          );
        } finally {
          detachCollector();
        }
      }, {
        locale: productContext.locale,
        profileKey: attempt.profileKey,
        proxyUrl: attempt.proxyUrl,
      });

      recordCandidateSuccess(attempt, {
        outcome: "product-data",
      });
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

  if (cachedProducts[productContext.goodsId]) {
    return buildCachedResponse(
      cachedProducts[productContext.goodsId],
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
