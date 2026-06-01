import { createInditexFetcher, UpstreamBlockError } from "./inditex-base.js";

const fetchProductDetails = createInditexFetcher({
  brand: "Bershka",
  hostname: "www.bershka.com",
  cdnHostname: "static.bershka.net",
  cacheFile: "bershka-product-cache.json",
  profileKeyPrefix: "bershka",
  genericTitlePattern: /^bershka\b/i,
});

export { fetchProductDetails, UpstreamBlockError };
