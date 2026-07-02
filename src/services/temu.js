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
  goodsDetail: /\/api\/poppy\/v1\/goods|\/api\/bg\/.*goods.*detail|\/api\/bg\/.*item.*info|\/api\/oak\/integration\/render/i,
  seoData: /\/api\/seo\/get_page_seo_data/i,
};

const HUMAN_CHECK_PATTERNS = [
  /slide to verify/i,
  /verify.*human/i,
  /security.*check/i,
  /verificação de segurança/i,
  /vérification de sécurité/i,
  /verificación de seguridad/i,
];

const LOGIN_WALL_PATTERNS = [
  /enter your (email|phone)/i,
  /sign in to temu/i,
  /log in.*temu/i,
  /introduz.*email|introduz.*telefone/i,
  /continuar com.*email|continuar com.*telefone/i,
  /continue with.*email|continue with.*phone/i,
];

const GENERIC_PAGE_TITLES = [
  /^temu\b/i,
  /temu[-–—]\s*as low as/i,
  /shop.*temu/i,
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

const PRODUCT_CACHE_FILE = "temu-product-cache.json";

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

  const pathMatch = parsedUrl.pathname.match(/-[pg]-(\d+)/i);
  const goodsId = pathMatch?.[1] || parsedUrl.searchParams.get("goods_id");

  if (!goodsId) {
    const error = new TypeError("Unable to extract goodsId from the provided URL.");
    error.name = "InvalidUrlError";
    throw error;
  }

  const cleanUrl = pathMatch
    ? `${parsedUrl.origin}${parsedUrl.pathname}`
    : `${parsedUrl.origin}/goods.html?goods_id=${goodsId}`;

  return {
    goodsId,
    productUrl: cleanUrl,
  };
};

const buildAttempts = (proxyUrls) => {
  const plan = proxyUrls?.length
    ? buildRequestAttemptPlan(proxyUrls, config.retryAttempts)
    : getAttemptPlan(config.retryAttempts);
  return plan.map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey:
      candidate.label === "direct"
        ? "temu-direct"
        : `temu-${candidate.label}`,
  }));
};

const createResponseBucket = () => ({
  goodsDetail: [],
  seoData: [],
});

const resolveResponseType = (url) => {
  for (const [name, pattern] of Object.entries(RESPONSE_TYPES)) {
    if (pattern.test(url)) {
      return name;
    }
  }

  return null;
};

const parseCapturedResponse = async (response) => {
  const contentType = response.headers()["content-type"] || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const body = await response.text();

  if (!body) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const attachResponseCollector = (page, bucket) => {
  const handler = async (response) => {
    const responseType = resolveResponseType(response.url());

    if (!responseType) {
      return;
    }

    try {
      const payload = await parseCapturedResponse(response);

      if (!payload) {
        return;
      }

      bucket[responseType].push({
        url: response.url(),
        payload,
      });
    } catch {
      // ignore unrelated or malformed matching responses
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

const getNestedValue = (input, path) => {
  let current = input;

  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return null;
    }

    current = current[segment];
  }

  return current ?? null;
};

const findCandidateResultObjects = (payload) => {
  const directCandidates = [
    getNestedValue(payload, ["result"]),
    getNestedValue(payload, ["data", "result"]),
    getNestedValue(payload, ["data"]),
    getNestedValue(payload, ["goods"]),
    getNestedValue(payload, ["result", "goods"]),
  ].filter((value) => value && typeof value === "object");

  const queue = [...directCandidates, payload];
  const seen = new Set();
  const matches = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    const hasProductShape =
      "price_info" in current ||
      "property_list" in current ||
      "sku_list" in current ||
      "goods_imgs" in current ||
      "display_name" in current ||
      "goods_name" in current ||
      ("title" in current && "goods_id" in current) ||
      ("title" in current && "price_info" in current);

    if (hasProductShape) {
      matches.push(current);
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return uniqueBy(matches, (value) => JSON.stringify(value));
};

const normalizeCandidateGoodsId = (result) =>
  firstNonEmpty(
    String(result?.goods_id || ""),
    String(result?.goodsId || ""),
    String(result?.goods_id_str || "")
  );

const scoreCandidateResult = (result, productContext) => {
  const candidateGoodsId = normalizeCandidateGoodsId(result);
  let score = candidateGoodsId === productContext.goodsId ? 100 : 0;

  if (firstNonEmpty(result?.display_name, result?.goods_name)) {
    score += 10;
  }

  if (Array.isArray(result?.goods_imgs) && result.goods_imgs.length > 0) {
    score += 10;
  }

  if (Array.isArray(result?.property_list) && result.property_list.length > 0) {
    score += 10;
  }

  if (Array.isArray(result?.sku_list) && result.sku_list.length > 0) {
    score += 10;
  }

  if (result?.price_info && typeof result.price_info === "object") {
    score += 10;
  }

  return score;
};

const resolveGoodsDetailResult = (bucket, productContext) => {
  const candidates = bucket.goodsDetail.flatMap((entry) => findCandidateResultObjects(entry.payload));

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(
    (left, right) => scoreCandidateResult(right, productContext) - scoreCandidateResult(left, productContext)
  )[0];
};

const extractPropertyValues = (propertyList, namePattern) =>
  unique(
    propertyList
      .filter((prop) => namePattern.test(prop?.property_name || prop?.spec_name || ""))
      .flatMap((prop) =>
        (
          prop.sku_property_values ||
          prop.value_list ||
          prop.attr_value_list ||
          prop.values ||
          []
        ).map((v) =>
          firstNonEmpty(
            v?.property_value_name,
            v?.spec_value,
            v?.value_name,
            v?.name,
            typeof v === "string" ? v : null
          )
        )
      )
  );

const extractSkuSpecs = (skuList, namePattern) =>
  unique(
    skuList.flatMap((sku) =>
      (sku?.specs || sku?.prop_list || [])
        .filter((s) => namePattern.test(s?.spec_name || s?.prop_name || ""))
        .map((s) => firstNonEmpty(s?.spec_value, s?.prop_value))
    )
  );

const normalizePrice = (value) => {
  if (typeof value === "number") return String(value / 100);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
};

const extractImages = (result) => {
  const goodsImgs = Array.isArray(result.goods_imgs) ? result.goods_imgs : [];
  return unique(
    goodsImgs
      .map((img) => {
        if (typeof img === "string") return normalizeImageUrl(img);
        if (!img || typeof img !== "object") return null;
        return normalizeImageUrl(
          img.goods_image_url ||
            img.origin_url ||
            img.url ||
            img.img_url ||
            img.thumb_url ||
            img.image_url
        );
      })
      .filter(Boolean)
  );
};

const extractApiData = (bucket, productContext) => {
  const result = resolveGoodsDetailResult(bucket, productContext);

  if (!result) {
    return null;
  }


  const priceInfo = result.price_info || {};
  const skuList = Array.isArray(result.sku_list) ? result.sku_list : [];
  const propertyList = Array.isArray(result.property_list) ? result.property_list : [];

  // Colors — try property_list first, then color_list, then sku specs
  const colorsFromProps = extractPropertyValues(propertyList, /color|colour|cor/i);
  const colorsFromList = unique(
    (Array.isArray(result.color_list) ? result.color_list : []).map((c) =>
      firstNonEmpty(c?.color_name, c?.name, typeof c === "string" ? c : null)
    )
  );
  const colorsFromSkus = extractSkuSpecs(skuList, /color|colour|cor/i);
  const colors = unique([...colorsFromProps, ...colorsFromList, ...colorsFromSkus]);

  // Sizes — try property_list first, then sku specs
  const sizesFromProps = extractPropertyValues(propertyList, /size|tamanho|taille|talla/i);
  const sizesFromSkus = extractSkuSpecs(skuList, /size|tamanho|taille|talla/i);
  const sizes = unique([...sizesFromProps, ...sizesFromSkus]);

  const variants = uniqueBy(
    skuList
      .map((sku) => {
        if (!sku) return null;

        // Try sale_prop_map (id→value), specs array, prop_list array
        const propValues = [
          ...Object.values(sku.sale_prop_map || {}),
          ...(sku.specs || []).map((s) => s?.spec_value),
          ...(sku.prop_list || []).map((s) => s?.prop_value),
        ].filter(Boolean);

        const skuPrice =
          normalizePrice(sku.price) ||
          normalizePrice(sku.sale_price) ||
          normalizePrice(sku.price_info?.price);

        return normalizeVariant({
          sku: firstNonEmpty(String(sku.sku_id || sku.id || "")),
          size: propValues.find((v) => sizes.includes(v)) || null,
          color: propValues.find((v) => colors.includes(v)) || null,
          price: skuPrice,
          availability: null,
          url: null,
        });
      })
      .filter(Boolean),
    (variant) => variant.sku || `${variant.size}-${variant.color}`
  );

  const images = extractImages(result);
  // Also try single image fields from lightweight card responses
  const singleImage = normalizeImageUrl(
    typeof result.image === "string" ? result.image :
    typeof result.thumb_url === "string" ? result.thumb_url : null
  );
  if (singleImage && !images.includes(singleImage)) images.unshift(singleImage);

  // Price — try price_info, then top-level sale_price / original_price
  const rawPrice = priceInfo.price ?? result.sale_price;
  const rawMarketPrice = priceInfo.market_price ?? result.original_price;

  return {
    goodsId: productContext.goodsId,
    title: firstNonEmpty(result.display_name, result.goods_name, result.title),
    color: colors[0] || null,
    colors,
    sizes,
    variants,
    brand: firstNonEmpty(result.brand?.name, result.brand_name),
    price: {
      amount: normalizePrice(rawPrice),
      formatted: firstNonEmpty(priceInfo.price_with_symbol, result.price_with_symbol),
      retailAmount: normalizePrice(rawMarketPrice),
      retailFormatted: firstNonEmpty(priceInfo.market_price_with_symbol, result.original_price_with_symbol),
      discountPercent: firstNonEmpty(priceInfo.discount_rate, result.discount_rate),
    },
    images,
    sourceStage: "network-json",
  };
};

const extractSsrFallback = async (page, productContext) => {
  try {
    const data = await page.evaluate(() => {
      // Try __NEXT_DATA__ (newer Temu pages)
      try {
        const el = document.querySelector("#__NEXT_DATA__");
        if (el) return { source: "next-data", data: JSON.parse(el.textContent) };
      } catch {}

      // Try window variables
      for (const key of ["__INITIAL_STATE__", "__PRELOADED_STATE__", "PAGE_INFO"]) {
        try {
          if (window[key]) return { source: key, data: window[key] };
        } catch {}
      }

      return null;
    });

    if (!data) return null;

    // Walk the SSR object looking for a product shape
    const findProduct = (obj, depth = 0) => {
      if (depth > 8 || !obj || typeof obj !== "object") return null;
      if (
        obj.goods_name ||
        obj.display_name ||
        (obj.goods_id && (obj.price_info || obj.sale_price))
      ) return obj;
      for (const val of Object.values(obj)) {
        const found = findProduct(val, depth + 1);
        if (found) return found;
      }
      return null;
    };

    const product = findProduct(data.data);
    if (!product) return null;

    const skuList = Array.isArray(product.sku_list) ? product.sku_list : [];
    const propertyList = Array.isArray(product.property_list) ? product.property_list : [];
    const colorsFromProps = extractPropertyValues(propertyList, /color|colour|cor/i);
    const colorsFromList = unique(
      (Array.isArray(product.color_list) ? product.color_list : []).map((c) =>
        firstNonEmpty(c?.color_name, c?.name)
      )
    );
    const colors = unique([...colorsFromProps, ...colorsFromList, ...extractSkuSpecs(skuList, /color|colour|cor/i)]);
    const sizes = unique([
      ...extractPropertyValues(propertyList, /size|tamanho|taille|talla/i),
      ...extractSkuSpecs(skuList, /size|tamanho|taille|talla/i),
    ]);
    const images = extractImages(product);
    const priceInfo = product.price_info || {};
    const rawPrice = priceInfo.price ?? product.sale_price;
    const rawMarketPrice = priceInfo.market_price ?? product.original_price;

    return {
      goodsId: firstNonEmpty(String(product.goods_id || productContext.goodsId)),
      title: firstNonEmpty(product.display_name, product.goods_name),
      color: colors[0] || null,
      colors,
      sizes,
      variants: [],
      brand: firstNonEmpty(product.brand?.name, product.brand_name),
      price: {
        amount: normalizePrice(rawPrice),
        formatted: firstNonEmpty(priceInfo.price_with_symbol),
        retailAmount: normalizePrice(rawMarketPrice),
        retailFormatted: firstNonEmpty(priceInfo.market_price_with_symbol),
        discountPercent: firstNonEmpty(priceInfo.discount_rate),
      },
      images,
      sourceStage: `ssr-${data.source}`,
    };
  } catch {
    return null;
  }
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

const extractDomFallback = async (page) => {
  // Wait for React to render the product detail section
  await page.waitForSelector('h1, [data-testid*="product"], [aria-label*="cor" i], [aria-label*="tamanho" i], [aria-label*="size" i], [aria-label*="color" i]', { timeout: 8000 }).catch(() => null);

  // Scroll to trigger lazy loading of images and variant components
  await page.evaluate(() => window.scrollTo(0, Math.min(600, document.body.scrollHeight / 2))).catch(() => null);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => null);

  try {
    const domData = await page.evaluate(() => {
      const compact = (value) =>
        typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      const unique = (values) => [...new Set(values.filter(Boolean))];
      const normalizeUrl = (value) => {
        if (!value || typeof value !== "string") return null;
        if (value.startsWith("//")) return `https:${value}`;
        if (value.startsWith("http://")) return `https://${value.slice("http://".length)}`;
        return value;
      };
      const isCdnImg = (src) =>
        typeof src === "string" && (src.includes("kwcdn.com") || src.includes("temu.com/goods_img") || src.includes("temu.com/img"));

      const parseJsonLdBlocks = () =>
        Array.from(document.querySelectorAll("script[type='application/ld+json']"))
          .map((node) => node.textContent?.trim())
          .filter(Boolean)
          .flatMap((source) => {
            try { return [JSON.parse(source)]; } catch { return []; }
          });

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

      const product = findProductJsonLd(parseJsonLdBlocks());

      // Title
      const titleEl = document.querySelector("h1");
      const title = compact(titleEl?.textContent);

      // All radio/option elements — separate colors from sizes by content
      const allOptionEls = Array.from(document.querySelectorAll(
        '[role="radio"][aria-label], [role="option"][aria-label], [aria-checked][aria-label]'
      ));
      const sizePattern = /^\s*(?:\d{1,3}(?:[.,]\d)?(?:\s*(?:cm|mm|EU|UK|US))?\s*|XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)\s*$/i;
      const uiLabelPattern = /botão|button|select|tudo|all|fechar|close|mais|more|less|menos/i;

      const cleanLabel = (el) => {
        const raw = el.getAttribute("aria-label") || el.getAttribute("title") || "";
        // Strip decorative brackets 【】 「」 《》
        return raw.replace(/[【】「」《》\[\]]/g, "").trim();
      };

      const colors = unique(
        allOptionEls
          .map(cleanLabel)
          .filter((v) => v.length > 0 && v.length < 40 && !sizePattern.test(v) && !uiLabelPattern.test(v))
      );

      const sizes = unique(
        allOptionEls
          .map((el) => cleanLabel(el))
          .filter((v) => sizePattern.test(v) && v.length < 20)
      );

      // Images — look for product gallery container first, then fall back to all CDN imgs
      const galleryContainerSelectors = [
        '[class*="gallery"]', '[class*="swiper"]', '[class*="preview"]',
        '[class*="thumbnail"]', '[class*="carousel"]', '[class*="main-img"]',
        '[class*="product-img"]', '[class*="detail-img"]',
      ];
      let imgScope = null;
      for (const sel of galleryContainerSelectors) {
        const el = document.querySelector(sel);
        if (el && el.querySelectorAll("img").length > 0) { imgScope = el; break; }
      }
      const allImgs = Array.from((imgScope || document).querySelectorAll("img"));
      const images = unique(
        allImgs.flatMap((el) => {
          const candidates = [
            el.getAttribute("src"),
            el.getAttribute("data-src"),
            (el.getAttribute("srcset") || "").split(",")[0]?.trim().split(" ")[0],
            (el.getAttribute("data-srcset") || "").split(",")[0]?.trim().split(" ")[0],
          ];
          return candidates.map(normalizeUrl).filter((u) => u && isCdnImg(u) && !u.includes("thumbnail") && !u.includes("_60x60") && !u.includes("_100x100"));
        })
      ).slice(0, 20); // cap at 20 product images

      const jsonLdVariants = Array.isArray(product?.hasVariant)
        ? product.hasVariant.map((variant) => ({
            sku: compact(variant?.sku),
            size: compact(variant?.size),
            color: compact(variant?.color || product?.color),
            price: compact(String(variant?.offers?.price || "")),
            availability: compact(variant?.offers?.availability),
            url: compact(variant?.offers?.url),
          })).filter((v) => v.sku || v.size || v.color || v.price || v.url)
        : [];

      const allColors = unique([...colors, compact(product?.color)]);
      const allSizes = unique([...sizes, ...jsonLdVariants.map((v) => compact(v.size))]);
      const allImages = unique([
        ...images,
        ...(Array.isArray(product?.image) ? product.image.map(normalizeUrl) : []),
      ]);

      if (allColors.length === 0 && allSizes.length === 0 && allImages.length === 0 && jsonLdVariants.length === 0) {
        return null;
      }

      return {
        title: title || null,
        color: allColors[0] || null,
        colors: allColors,
        sizes: allSizes,
        variants: jsonLdVariants,
        images: allImages,
        price: null,
        _debug: { colorElCount: colorEls.length, sizeElCount: sizeEls.length, imgCount: allImgs.length, cdnImgCount: images.length },
      };
    });

    if (!domData) {
      return null;
    }

    const { _debug, ...rest } = domData;
    return { ...rest, sourceStage: "dom-live" };
  } catch {
    return null;
  }
};

const mergeProductData = (productContext, layers) => {
  const sourceChain = [];
  const merged = {
    goodsId: productContext.goodsId,
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

  return merged;
};

const prewarmSession = async (page) => {
  if (config.prewarmHomeMs <= 0) {
    return;
  }

  await page.goto("https://www.temu.com/", {
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
      };
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }

  throw lastError;
};

const isOnLoginPage = (url) =>
  typeof url === "string" && (url.includes("/login.html") || url.includes("/login?"));

const navigateToProduct = async (page, productUrl) => {
  try {
    await page.goto(productUrl, {
      waitUntil: "commit",
      timeout: config.navigationTimeoutMs,
    });
  } catch (error) {
    const msg = error.message || "";
    if (!msg.includes("ERR_ABORTED") && !msg.includes("interrupted by another navigation")) {
      throw error;
    }
  }

  await page.waitForLoadState("domcontentloaded", {
    timeout: config.requestTimeoutMs,
  });
};

const waitForLoginAndReturn = async (page, productUrl) => {
  if (config.browserHeadless) {
    throw new UpstreamBlockError(
      "Temu requires login. Set BROWSER_HEADLESS=false, complete the login in the opened browser, and retry.",
      {
        requiresLogin: true,
        loginWaitMs: config.loginWaitMs,
      }
    );
  }

  try {
    await page.waitForURL((url) => !isOnLoginPage(url.href), {
      timeout: config.loginWaitMs,
    });
  } catch {
    throw new UpstreamBlockError(
      "Temu redirected to login page. Please log in within the browser window and wait for the product page to resume.",
      {
        requiresLogin: true,
        loginWaitMs: config.loginWaitMs,
      }
    );
  }

  await navigateToProduct(page, productUrl);
};

const isHumanCheck = (bodyText, pageTitle) => {
  return HUMAN_CHECK_PATTERNS.some(
    (pattern) => pattern.test(bodyText) || pattern.test(pageTitle || "")
  );
};

const isLoginWall = (bodyText, pageTitle) => {
  return LOGIN_WALL_PATTERNS.some(
    (pattern) => pattern.test(bodyText) || pattern.test(pageTitle || "")
  );
};

const tryDismissLoginWall = async (page) => {
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
  } catch {
    // ignore
  }

  const closeSelectors = [
    '[class*="close"]',
    '[aria-label*="close" i]',
    '[aria-label*="fechar" i]',
    '[aria-label*="fermer" i]',
    '[aria-label*="cerrar" i]',
    'button[class*="modal"] svg',
  ];

  for (const selector of closeSelectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) {
        await locator.click({ timeout: 2000 });
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      continue;
    }
  }
};

const waitForHumanVerification = async (page) => {
  if (config.browserHeadless) {
    throw new UpstreamBlockError(
      "Temu requested human verification. Set BROWSER_HEADLESS=false, solve the puzzle in the opened browser, and retry.",
      {
        requiresHumanVerification: true,
        verificationWaitMs: config.verificationWaitMs,
      }
    );
  }

  try {
    await page.waitForFunction(
      () => {
        const text = (document.body?.innerText || "") + (document.title || "");
        return !/slide to verify|verify.*human|security.*check|verificação de segurança|vérification de sécurité|verificación de seguridad/i.test(text);
      },
      { timeout: config.verificationWaitMs }
    );
  } catch {
    throw new UpstreamBlockError(
      "Temu requested human verification (sliding puzzle). Solve it in the browser window and wait for the product page to resume.",
      {
        requiresHumanVerification: true,
        verificationWaitMs: config.verificationWaitMs,
      }
    );
  }
};

const isGenericTitle = (title) => {
  if (!title || typeof title !== "string") {
    return true;
  }

  return GENERIC_PAGE_TITLES.some((pattern) => pattern.test(title.trim()));
};

const hasUsefulProductData = (data) => {
  return Boolean(
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
            await prewarmSession(page);
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

            if (isOnLoginPage(page.url())) {
              await waitForLoginAndReturn(page, productContext.productUrl);
              await page.waitForTimeout(config.pageWaitMs);
              snapshot = await readPageSnapshot(page);
            } else if (isLoginWall(snapshot.bodyText, snapshot.pageTitle)) {
              await tryDismissLoginWall(page);
              snapshot = await readPageSnapshot(page);

              if (isOnLoginPage(page.url()) || isLoginWall(snapshot.bodyText, snapshot.pageTitle)) {
                await waitForLoginAndReturn(page, productContext.productUrl);
                await page.waitForTimeout(config.pageWaitMs);
                snapshot = await readPageSnapshot(page);
              }
            }

            if (isHumanCheck(snapshot.bodyText, snapshot.pageTitle)) {
              await waitForHumanVerification(page);
              snapshot = await readPageSnapshot(page);
            }

            if (isHumanCheck(snapshot.bodyText, snapshot.pageTitle)) {
              throw new UpstreamBlockError(
                "Temu requested human verification (sliding puzzle) before exposing product data."
              );
            }

            const networkData = extractApiData(bucket, productContext);
            const ssrFallback = await extractSsrFallback(page, productContext);
            const structuredFallback = extractStructuredFallback(snapshot.html);
            const domFallback = await extractDomFallback(page);

            const mergedData = mergeProductData(productContext, [
              networkData,
              ssrFallback,
              structuredFallback,
              domFallback,
            ]);

            if (hasUsefulProductData(mergedData)) {
              return mergedData;
            }

            throw new UpstreamBlockError(
              "Temu did not expose enough product data for this request."
            );
          } finally {
            detachCollector();
          }
        },
        {
          profileKey: attempt.profileKey,
          proxyUrl: attempt.proxyUrl,
        }
      );

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
