import express from "express";
import {
  getHealth,
  getProduct,
  getProxyMetrics,
  getTemuProduct,
  getAmazonProduct,
  getZalandoProduct,
} from "../controllers/product.js";

const router = express.Router();

router.get("/health", getHealth);
router.get("/proxy-metrics", getProxyMetrics);
router.get("/product", getProduct);
router.get("/temu/product", getTemuProduct);
router.get("/amazon/product", getAmazonProduct);
router.get("/zalando/product", getZalandoProduct);

export default router;
