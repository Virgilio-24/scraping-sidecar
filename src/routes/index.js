import express from "express";
import { getHealth, getProduct, getProxyMetrics } from "../controllers/product.js";

const router = express.Router();

router.get("/health", getHealth);
router.get("/proxy-metrics", getProxyMetrics);
router.get("/product", getProduct);

export default router;
