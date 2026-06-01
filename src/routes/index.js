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

export default router;
