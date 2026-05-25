import express from "express";
import { getHealth, getProduct, getProxyMetrics, getTemuProduct } from "../controllers/product.js";

const router = express.Router();

router.get("/health", getHealth);
router.get("/proxy-metrics", getProxyMetrics);
router.get("/product", getProduct);
router.get("/temu/product", getTemuProduct);

export default router;
