// ID field name used by each brand's scraper
const BRAND_ID_FIELD = {
  amazon:      "asin",
  zara:        "productId",
  pullandbear: "productId",
  bershka:     "productId",
  hm:          "articleCode",
  zalando:     "articleId",
  shein:       "goodsId",
  temu:        "productId",
  aliexpress:  "itemId",
  aboutyou:    "articleId",
};

const DEFAULT_PRICE = {
  amount: null,
  formatted: null,
  retailAmount: null,
  retailFormatted: null,
  discountPercent: null,
};

export const normalizeProductResponse = (brand, data) => {
  if (!data || typeof data !== "object") return data;

  const idField = BRAND_ID_FIELD[brand];
  const id = idField ? (data[idField] ?? null) : null;

  const normalized = {
    id,
    title:       data.title       ?? null,
    brand:       data.brand       ?? null,
    description: data.description ?? null,
    color:       data.color       ?? null,
    colors:      Array.isArray(data.colors)   ? data.colors   : [],
    sizes:       Array.isArray(data.sizes)    ? data.sizes    : [],
    variants:    Array.isArray(data.variants) ? data.variants : [],
    price:       { ...DEFAULT_PRICE, ...(data.price ?? {}) },
    images:      Array.isArray(data.images)   ? data.images   : [],
    url:         data.url    ?? null,
    market:      data.market ?? null,
  };

  // Keep details array if present (Inditex brands)
  if (Array.isArray(data.details) && data.details.length > 0) {
    normalized.details = data.details;
  }

  // Debug/tracing info grouped separately
  normalized._meta = {
    sourceChain:  data.sourceChain  ?? [],
    fieldSources: data.fieldSources ?? {},
    antiBot:      data.antiBot      ?? null,
  };

  return normalized;
};
