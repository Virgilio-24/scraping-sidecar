import express from "express";
import {
  getHealth,
  getProduct,
  getProxyMetrics,
  getTemuProduct,
  getAmazonProduct,
} from "../controllers/product.js";

const router = express.Router();

router.get("/health", getHealth);
router.get("/proxy-metrics", getProxyMetrics);
router.get("/product", getProduct);
router.get("/temu/product", getTemuProduct);
router.get("/amazon/product", getAmazonProduct);

export default router;
