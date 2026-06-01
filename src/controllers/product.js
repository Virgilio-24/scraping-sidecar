import { getProxySummary } from "../services/proxy-pool.js";
import { UpstreamBlockError, fetchProductDetails } from "../services/shein.js";
import {
  UpstreamBlockError as TemuUpstreamBlockError,
  fetchProductDetails as fetchTemuProductDetails,
} from "../services/temu.js";
import {
  UpstreamBlockError as AmazonUpstreamBlockError,
  fetchProductDetails as fetchAmazonProductDetails,
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

export const getHealth = (req, res) => {
  res.status(200).json({ status: "ok" });
};

export const getProxyMetrics = (req, res) => {
  res.status(200).json({
    status: "ok",
    data: getProxySummary(),
  });
};

export const getProduct = async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchProductDetails(url);

    return res.status(200).json({
      status: "ok",
      data,
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
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchTemuProductDetails(url);

    return res.status(200).json({
      status: "ok",
      data,
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
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchAmazonProductDetails(url);

    return res.status(200).json({
      status: "ok",
      data,
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
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchZalandoProductDetails(url);

    return res.status(200).json({
      status: "ok",
      data,
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
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchZaraProductDetails(url);

    return res.status(200).json({
      status: "ok",
      data,
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
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: "error",
      message: "Query string 'url' is required.",
    });
  }

  try {
    const data = await fetchAboutYouProductDetails(url);

    return res.status(200).json({
      status: "ok",
      data,
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


const makeInditexHandler = (fetchFn, BlockError) => async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: "error", message: "Query string 'url' is required." });
  try {
    const data = await fetchFn(url);
    return res.status(200).json({ status: "ok", data });
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

export const getPullAndBearProduct = makeInditexHandler(fetchPullAndBearProductDetails, PullAndBearUpstreamBlockError);
export const getBershkaProduct = makeInditexHandler(fetchBershkaProductDetails, BershkaUpstreamBlockError);

export const getHmProduct = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: "error", message: "Query string 'url' is required." });
  try {
    const data = await fetchHmProductDetails(url);
    return res.status(200).json({ status: "ok", data });
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