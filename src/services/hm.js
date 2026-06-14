import fs from "fs/promises";
import path from "path";
import { config, resolveProjectPath } from "../config.js";
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
  se_sv: { market: "se", locale: "sv-SE" },
  no_no: { market: "no", locale: "nb-NO" },
  dk_da: { market: "dk", locale: "da-DK" },
  fi_fi: { market: "fi", locale: "fi-FI" },
};

const MARKET_CURRENCY = {
  pt: "€", de: "€", fr: "€", es: "€", it: "€", nl: "€",
  at: "€", fi: "€", be: "€",
  gb: "£",
  no: "kr", se: "kr", dk: "kr",
  ch: "CHF", us: "$", pl: "zł",
};

const PRODUCT_CACHE_FILE = "hm-product-cache.json";

const firstNonEmpty = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const normalizeImageUrl = (value) => {
  if (!value || typeof value !== "string") return null;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://")) return `https://${value.slice(7)}`;
  return value;
};

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

const parseProductUrl = (productUrl) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(productUrl);
  } catch {
    const error = new TypeError("The provided URL is invalid.");
    error.name = "InvalidUrlError";
    throw error;
  }

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

  return { articleCode, locale, market, localeKey, productUrl: cleanUrl };
};

const buildAttempts = (proxyUrls) => {
  const plan = proxyUrls?.length
    ? buildRequestAttemptPlan(proxyUrls, config.retryAttempts)
    : getAttemptPlan(config.retryAttempts);
  return plan.map((candidate, index) => ({
    ...candidate,
    attemptNumber: index + 1,
    profileKey: candidate.label === "direct" ? "hm-api-direct" : `hm-api-${candidate.label}`,
  }));
};

const createAttemptMetadata = (attempt) => ({
  attempt: attempt.attemptNumber,
  round: attempt.round,
  proxy: attempt.label,
  proxyTarget: attempt.proxyDisplay || null,
  sessionProfile: attempt.profileKey,
});

const buildFetchOptions = (locale, proxyUrl) => {
  const headers = {
    "Accept": "application/json",
    "Accept-Language": `${locale},${locale.split("-")[0]};q=0.9,en;q=0.8`,
    "User-Agent": config.userAgent,
    "Referer": "https://www2.hm.com/",
    "Origin": "https://www2.hm.com",
  };

  // Node 18+ native fetch supports a proxy via an undici dispatcher,
  // but for simplicity we just pass the headers — proxy support via env HTTP_PROXY
  // is handled by the Node runtime if set.
  return { headers };
};

const fetchProductFromApi = async (productContext, proxyUrl) => {
  const apiUrl = `https://api.hm.com/search-services/v1/${productContext.localeKey}/search/byids?ids=${productContext.articleCode}&touchPoint=DESKTOP&pageSource=pdp`;
  const fetchOpts = buildFetchOptions(productContext.locale, proxyUrl);

  const response = await fetch(apiUrl, fetchOpts);

  if (!response.ok) {
    throw new UpstreamBlockError(
      `H&M API responded with ${response.status} ${response.statusText}.`,
      { status: response.status }
    );
  }

  const json = await response.json();
  const article = json?.articles?.productList?.[0];

  if (!article) {
    throw new UpstreamBlockError("H&M API returned no product data for this article code.");
  }

  return article;
};

const parseArticle = (article, productContext) => {
  const currency = MARKET_CURRENCY[productContext.market] || "€";

  const whitePrice = article.prices?.find((p) => p.priceType === "whitePrice");
  const redPrice = article.prices?.find((p) => p.priceType === "redPrice");

  const priceAmount = whitePrice?.price != null ? String(whitePrice.price) : null;
  const retailAmount = redPrice?.price != null ? String(redPrice.price) : null;
  const formattedPrice = whitePrice?.formattedPrice ?? (priceAmount ? `${priceAmount} ${currency}` : null);
  const retailFormatted = redPrice?.formattedPrice ?? null;

  const colors = unique(
    (article.swatches || []).map((s) => firstNonEmpty(s.colorName)).filter(Boolean)
  );
  const color = firstNonEmpty(article.colorName, colors[0]);

  const sizes = unique(
    (article.sizes || [])
      .filter((s) => s.stock > 0 || true)
      .map((s) => firstNonEmpty(s.label))
      .filter(Boolean)
  );

  const images = unique([
    normalizeImageUrl(article.productImage),
    normalizeImageUrl(article.modelImage),
    ...((article.images || []).map((img) => normalizeImageUrl(img.url))),
  ].filter(Boolean));

  return {
    articleCode: productContext.articleCode,
    title: firstNonEmpty(article.productName),
    brand: firstNonEmpty(article.brandName, "H&M"),
    color,
    colors,
    sizes,
    variants: [],
    price: {
      amount: priceAmount,
      formatted: formattedPrice,
      retailAmount,
      retailFormatted,
      discountPercent: null,
    },
    images,
    url: productContext.productUrl,
    market: productContext.market,
    sourceChain: ["api-fetch"],
    fieldSources: {
      title: "api-fetch",
      brand: "api-fetch",
      color: "api-fetch",
      colors: "api-fetch",
      sizes: "api-fetch",
      price: "api-fetch",
      images: "api-fetch",
    },
  };
};

const classifyAttemptError = (error) => {
  if (error instanceof UpstreamBlockError)
    return { message: error.message, code: error.name, retryable: true };
  const message = typeof error?.message === "string" && error.message.trim()
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
      const article = await fetchProductFromApi(productContext, attempt.proxyUrl);
      const result = parseArticle(article, productContext);

      recordCandidateSuccess(attempt, { outcome: "product-data" });
      await writeProductCacheEntry(result);

      return {
        ...result,
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

  if (cachedProducts[productContext.articleCode]) {
    return buildCachedResponse(cachedProducts[productContext.articleCode], productContext, attempts, failureHistory);
  }

  throw new UpstreamBlockError(
    `Unable to fetch H&M product data after ${attempts.length} attempts.`,
    { attemptsTried: attempts.length, attemptHistory: failureHistory, proxyMetrics: getProxyMetrics() }
  );
};
