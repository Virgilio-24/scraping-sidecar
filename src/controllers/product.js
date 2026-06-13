import { getProxySummary } from "../services/proxy-pool.js";
import { normalizeProductResponse } from "../utils/normalize.js";
import { UpstreamBlockError, fetchProductDetails } from "../services/shein.js";
import {
  UpstreamBlockError as TemuUpstreamBlockError,
  fetchProductDetails as fetchTemuProductDetails,
} from "../services/temu.js";
import {
  UpstreamBlockError as AmazonUpstreamBlockError,
  fetchProductDetails as fetchAmazonProductDetails,
  debugPriceDom,
} from "../services/amazon.js";
import {
  UpstreamBlockError as ZalandoUpstreamBlockError,
  fetchProductDetails as fetchZalandoProductDetails,
} from "../services/zalando.js";
import {
  UpstreamBlockError as ZaraUpstreamBlockError,
  fetchProductDetails as fetchZaraProductDetails,
} from "../services/zara.js";
import {
  UpstreamBlockError as AboutYouUpstreamBlockError,
  fetchProductDetails as fetchAboutYouProductDetails,
} from "../services/aboutyou.js";
import {
  UpstreamBlockError as HmUpstreamBlockError,
  fetchProductDetails as fetchHmProductDetails,
} from "../services/hm.js";
import {
  UpstreamBlockError as PullAndBearUpstreamBlockError,
  fetchProductDetails as fetchPullAndBearProductDetails,
} from "../services/pullandbear.js";
import {
  UpstreamBlockError as BershkaUpstreamBlockError,
  fetchProductDetails as fetchBershkaProductDetails,
} from "../services/bershka.js";
import {
  UpstreamBlockError as AliExpressUpstreamBlockError,
  fetchProductDetails as fetchAliExpressProductDetails,
} from "../services/aliexpress.js";
import { detectBrand, SUPPORTED_BRANDS } from "../services/brand-router.js";

export const getAmazonDebug = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };
  if (!url) return res.status(400).json({ status: "error", message: "url required" });
  try {
    const data = await debugPriceDom(url);
    return res.status(200).json({ status: "ok", data });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
};

export const getHealth = (req, res) => {
  res.status(200).json({ status: "ok" });
};

export const getProxyMetrics = (req, res) => {
  res.status(200).json({
    status: "ok",
    data: getProxySummary(),
  });
};

const parseProxies = (raw) =>
  raw ? raw.split(",").map((p) => p.trim()).filter(Boolean) : [];

export const getProduct = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchProductDetails(url, fetchOptions);

    return res.status(200).json({
      status: "ok",
      brand: "shein",
      data: normalizeProductResponse("shein", data),
    });
  } catch (error) {
    if (error instanceof UpstreamBlockError) {
      return res.status(502).json({
        status: "error",
        message: error.message,
        details: error.details,
      });
    }

    if (
      typeof error?.message === "string" &&
      error.message.includes("Executable doesn't exist")
    ) {
      return res.status(503).json({
        status: "error",
        message:
          "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project.",
      });
    }

    if (error instanceof TypeError || error.name === "InvalidUrlError") {
      return res.status(400).json({
        status: "error",
        message: error.message,
      });
    }

    console.error(error);

    return res.status(500).json({
      status: "error",
      message: "Unable to fetch product details.",
    });
  }
};

export const getTemuProduct = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchTemuProductDetails(url, fetchOptions);

    return res.status(200).json({
      status: "ok",
      brand: "temu",
      data: normalizeProductResponse("temu", data),
    });
  } catch (error) {
    if (error instanceof TemuUpstreamBlockError) {
      return res.status(502).json({
        status: "error",
        message: error.message,
        details: error.details,
      });
    }

    if (
      typeof error?.message === "string" &&
      error.message.includes("Executable doesn't exist")
    ) {
      return res.status(503).json({
        status: "error",
        message:
          "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project.",
      });
    }

    if (error instanceof TypeError || error.name === "InvalidUrlError") {
      return res.status(400).json({
        status: "error",
        message: error.message,
      });
    }

    console.error(error);

    return res.status(500).json({
      status: "error",
      message: "Unable to fetch product details.",
    });
  }
};

export const getAmazonProduct = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchAmazonProductDetails(url, fetchOptions);

    return res.status(200).json({
      status: "ok",
      brand: "amazon",
      data: normalizeProductResponse("amazon", data),
    });
  } catch (error) {
    if (error instanceof AmazonUpstreamBlockError) {
      return res.status(502).json({
        status: "error",
        message: error.message,
        details: error.details,
      });
    }

    if (
      typeof error?.message === "string" &&
      error.message.includes("Executable doesn't exist")
    ) {
      return res.status(503).json({
        status: "error",
        message:
          "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project.",
      });
    }

    if (error instanceof TypeError || error.name === "InvalidUrlError") {
      return res.status(400).json({
        status: "error",
        message: error.message,
      });
    }

    console.error(error);

    return res.status(500).json({
      status: "error",
      message: "Unable to fetch product details.",
    });
  }
};

export const getZalandoProduct = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchZalandoProductDetails(url, fetchOptions);

    return res.status(200).json({
      status: "ok",
      brand: "zalando",
      data: normalizeProductResponse("zalando", data),
    });
  } catch (error) {
    if (error instanceof ZalandoUpstreamBlockError) {
      return res.status(502).json({
        status: "error",
        message: error.message,
        details: error.details,
      });
    }

    if (
      typeof error?.message === "string" &&
      error.message.includes("Executable doesn't exist")
    ) {
      return res.status(503).json({
        status: "error",
        message:
          "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project.",
      });
    }

    if (error instanceof TypeError || error.name === "InvalidUrlError") {
      return res.status(400).json({
        status: "error",
        message: error.message,
      });
    }

    console.error(error);

    return res.status(500).json({
      status: "error",
      message: "Unable to fetch product details.",
    });
  }
};

export const getZaraProduct = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchZaraProductDetails(url, fetchOptions);

    return res.status(200).json({
      status: "ok",
      brand: "zara",
      data: normalizeProductResponse("zara", data),
    });
  } catch (error) {
    if (error instanceof ZaraUpstreamBlockError) {
      return res.status(502).json({
        status: "error",
        message: error.message,
        details: error.details,
      });
    }

    if (
      typeof error?.message === "string" &&
      error.message.includes("Executable doesn't exist")
    ) {
      return res.status(503).json({
        status: "error",
        message:
          "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project.",
      });
    }

    if (error instanceof TypeError || error.name === "InvalidUrlError") {
      return res.status(400).json({
        status: "error",
        message: error.message,
      });
    }

    console.error(error);

    return res.status(500).json({
      status: "error",
      message: "Unable to fetch product details.",
    });
  }
};

export const getAboutYouProduct = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchAboutYouProductDetails(url, fetchOptions);

    return res.status(200).json({
      status: "ok",
      brand: "aboutyou",
      data: normalizeProductResponse("aboutyou", data),
    });
  } catch (error) {
    if (error instanceof AboutYouUpstreamBlockError) {
      return res.status(502).json({
        status: "error",
        message: error.message,
        details: error.details,
      });
    }

    if (
      typeof error?.message === "string" &&
      error.message.includes("Executable doesn't exist")
    ) {
      return res.status(503).json({
        status: "error",
        message:
          "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project.",
      });
    }

    if (error instanceof TypeError || error.name === "InvalidUrlError") {
      return res.status(400).json({
        status: "error",
        message: error.message,
      });
    }

    console.error(error);

    return res.status(500).json({
      status: "error",
      message: "Unable to fetch product details.",
    });
  }
};


const makeInditexHandler = (fetchFn, BlockError, brand) => async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };
  if (!url) return res.status(400).json({ status: "error", message: "Query string 'url' is required." });
  try {
    const data = await fetchFn(url, fetchOptions);
    return res.status(200).json({ status: "ok", brand, data: normalizeProductResponse(brand, data) });
  } catch (error) {
    if (error instanceof BlockError)
      return res.status(502).json({ status: "error", message: error.message, details: error.details });
    if (typeof error?.message === "string" && error.message.includes("Executable doesn't exist"))
      return res.status(503).json({ status: "error", message: "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project." });
    if (error instanceof TypeError || error.name === "InvalidUrlError")
      return res.status(400).json({ status: "error", message: error.message });
    console.error(error);
    return res.status(500).json({ status: "error", message: "Unable to fetch product details." });
  }
};

export const getPullAndBearProduct = makeInditexHandler(fetchPullAndBearProductDetails, PullAndBearUpstreamBlockError, "pullandbear");

const LANG_TO_AMAZON_PARAM = {
  pt: "pt_PT", en: "en_GB", es: "es_ES", de: "de_DE", fr: "fr_FR", it: "it_IT",
};

const applyLangToUrl = (brand, url, lang) => {
  if (brand !== "amazon" || !lang) return url;
  const code = LANG_TO_AMAZON_PARAM[lang.toLowerCase()];
  if (!code) return url;
  try {
    const parsed = new URL(url);
    // Prefer /-/lang/ prefix over query param when possible
    if (!parsed.pathname.includes("/-/")) {
      parsed.pathname = `/-/${lang.toLowerCase()}${parsed.pathname}`;
    }
    return parsed.toString();
  } catch {
    return url;
  }
};

export const getAutoProduct = async (req, res) => {
  const { url, lang, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };

  if (!url) {
    return res.status(400).json({ status: "error", message: "Query string 'url' is required." });
  }

  const entry = detectBrand(url);

  if (!entry) {
    return res.status(400).json({
      status: "error",
      message: "Unable to detect brand from URL.",
      supportedBrands: SUPPORTED_BRANDS,
    });
  }

  const fetchUrl = applyLangToUrl(entry.brand, url, lang);

  try {
    const data = await entry.fetch(fetchUrl, fetchOptions);
    return res.status(200).json({ status: "ok", brand: entry.brand, data: normalizeProductResponse(entry.brand, data) });
  } catch (error) {
    if (error.name === "UpstreamBlockError") {
      return res.status(502).json({ status: "error", brand: entry.brand, message: error.message, details: error.details });
    }
    if (typeof error?.message === "string" && error.message.includes("Executable doesn't exist")) {
      return res.status(503).json({ status: "error", message: "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project." });
    }
    if (error instanceof TypeError || error.name === "InvalidUrlError") {
      return res.status(400).json({ status: "error", message: error.message });
    }
    console.error(error);
    return res.status(500).json({ status: "error", brand: entry.brand, message: "Unable to fetch product details." });
  }
};
export const getBershkaProduct = makeInditexHandler(fetchBershkaProductDetails, BershkaUpstreamBlockError, "bershka");
export const getAliExpressProduct = makeInditexHandler(fetchAliExpressProductDetails, AliExpressUpstreamBlockError, "aliexpress");

export const getHmProduct = async (req, res) => {
  const { url, proxies: rawProxies } = req.query;
  const fetchOptions = { proxyUrls: parseProxies(rawProxies) };
  if (!url) return res.status(400).json({ status: "error", message: "Query string 'url' is required." });
  try {
    const data = await fetchHmProductDetails(url, fetchOptions);
    return res.status(200).json({ status: "ok", brand: "hm", data: normalizeProductResponse("hm", data) });
  } catch (error) {
    if (error instanceof HmUpstreamBlockError)
      return res.status(502).json({ status: "error", message: error.message, details: error.details });
    if (typeof error?.message === "string" && error.message.includes("Executable doesn't exist"))
      return res.status(503).json({ status: "error", message: "Playwright Chromium is not installed. Run 'npx playwright install chromium' in the sidecar project." });
    if (error instanceof TypeError || error.name === "InvalidUrlError")
      return res.status(400).json({ status: "error", message: error.message });
    console.error(error);
    return res.status(500).json({ status: "error", message: "Unable to fetch product details." });
  }
};