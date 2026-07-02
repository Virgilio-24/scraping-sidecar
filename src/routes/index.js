import express from "express";
import {
  getHealth,
  getProduct,
  getProxyMetrics,
  getTemuProduct,
  getAmazonProduct,
  getZalandoProduct,
  getZaraProduct,
  getAboutYouProduct,
  getHmProduct,
  getPullAndBearProduct,
  getBershkaProduct,
  getAutoProduct,
  getAmazonDebug,
  getAliExpressProduct,
  postSheinSessionCapture,
  getSheinSessionStatusHandler,
  deleteSheinSession,
} from "../controllers/product.js";

const router = express.Router();

router.get("/health", getHealth);
router.get("/proxy-metrics", getProxyMetrics);
router.get("/product", getProduct);
router.get("/temu/product", getTemuProduct);
router.get("/amazon/product", getAmazonProduct);
router.get("/zalando/product", getZalandoProduct);
router.get("/zara/product", getZaraProduct);
router.get("/aboutyou/product", getAboutYouProduct);
router.get("/hm/product", getHmProduct);
router.get("/pullandbear/product", getPullAndBearProduct);
router.get("/bershka/product", getBershkaProduct);
router.get("/product/auto", getAutoProduct);
router.get("/aliexpress/product", getAliExpressProduct);
router.get("/amazon/debug-price", getAmazonDebug);

// Shein session capture (opens a visible browser for manual CAPTCHA solving)
router.post("/shein/session/capture", postSheinSessionCapture);
router.get("/shein/session/status", getSheinSessionStatusHandler);
router.delete("/shein/session", deleteSheinSession);

export default router;
