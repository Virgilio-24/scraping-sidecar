import { fetchProductDetails as fetchSheinProductDetails } from "./shein.js";
import { fetchProductDetails as fetchTemuProductDetails } from "./temu.js";
import { fetchProductDetails as fetchAmazonProductDetails } from "./amazon.js";
import { fetchProductDetails as fetchZalandoProductDetails } from "./zalando.js";
import { fetchProductDetails as fetchZaraProductDetails } from "./zara.js";
import { fetchProductDetails as fetchAboutYouProductDetails } from "./aboutyou.js";
import { fetchProductDetails as fetchHmProductDetails } from "./hm.js";
import { fetchProductDetails as fetchPullAndBearProductDetails } from "./pullandbear.js";
import { fetchProductDetails as fetchBershkaProductDetails } from "./bershka.js";

const BRAND_MAP = [
  { brand: "zara",        match: (h) => h === "www.zara.com" || h === "zara.com",                           fetch: fetchZaraProductDetails },
  { brand: "pullandbear", match: (h) => h === "www.pullandbear.com" || h === "pullandbear.com",             fetch: fetchPullAndBearProductDetails },
  { brand: "bershka",     match: (h) => h === "www.bershka.com" || h === "bershka.com",                     fetch: fetchBershkaProductDetails },
  { brand: "hm",          match: (h) => h === "www2.hm.com" || h === "www.hm.com" || h === "hm.com",        fetch: fetchHmProductDetails },
  { brand: "aboutyou",    match: (h) => h.endsWith(".aboutyou.com") || h === "aboutyou.com",                fetch: fetchAboutYouProductDetails },
  { brand: "zalando",     match: (h) => h.endsWith(".zalando.com") || /zalando\.[a-z]{2,3}$/.test(h),       fetch: fetchZalandoProductDetails },
  { brand: "amazon",      match: (h) => h.endsWith(".amazon.com") || /amazon\.[a-z]{2,3}$/.test(h),         fetch: fetchAmazonProductDetails },
  { brand: "temu",        match: (h) => h === "www.temu.com" || h === "temu.com",                            fetch: fetchTemuProductDetails },
  { brand: "shein",       match: (h) => h.endsWith(".shein.com") || h === "shein.com",                       fetch: fetchSheinProductDetails },
];

export const SUPPORTED_BRANDS = BRAND_MAP.map((b) => b.brand);

export const detectBrand = (url) => {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return BRAND_MAP.find((b) => b.match(hostname)) ?? null;
};
