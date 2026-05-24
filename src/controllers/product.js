import { getProxySummary } from "../services/proxy-pool.js";
import { UpstreamBlockError, fetchProductDetails } from "../services/shein.js";

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
