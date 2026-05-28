# Temu API — Research Notes

## Summary

Temu exposes two completely separate API surfaces with different access models and protection mechanisms.

---

## 1. Partner / Seller OpenAPI

A documented, legitimate integration API used by sellers, logistics platforms, and ERPs.

### Authentication

Each request requires a `sign` parameter generated as follows:

```
1. Build a params dict: { type, app_key, access_token, timestamp, ...business_params }
2. Sort all keys alphabetically
3. Concatenate as: key1value1key2value2... (no separators, no equals signs)
4. Wrap with app_secret on both ends:
   pre_sign = app_secret + concatenated_string + app_secret
5. sign = MD5(pre_sign).toUpperCase()
6. Include sign in the POST body alongside all other params
```

TypeScript reference:
```typescript
const signStr = app_secret + reqStr + app_secret;
const sign = crypto.createHash("md5").update(signStr, "utf-8").digest("hex").toUpperCase();
```

### Required credentials

| Field          | Description                          |
|----------------|--------------------------------------|
| `app_key`      | Application identifier               |
| `app_secret`   | Application secret (used in signing) |
| `access_token` | OAuth-style token, ~3-month TTL      |
| `timestamp`    | Unix timestamp in seconds            |

Credentials require an **approved Temu seller account**. Registration:
- US: `seller.temu.com/open-platform/client-manage`
- EU: `seller-eu.temu.com/open-platform/client-manage`

### Regional endpoints

All requests are `POST` with `Content-Type: application/json;charset=UTF-8`. All parameters including `sign` go in the POST body.

| Region   | Endpoint                                      |
|----------|-----------------------------------------------|
| US       | `https://openapi-b-us.temu.com/openapi/router`   |
| EU       | `https://openapi-b-eu.temu.com/openapi/router`   |
| Global   | `https://openapi-b-global.temu.com/openapi/router` |

### Relevant API methods

| Method                          | Description              |
|---------------------------------|--------------------------|
| `bg.local.goods.list.query`     | List products            |
| `bg.local.goods.sku.list.query` | List SKUs / variants     |
| `bg.local.goods.cats.get`       | Get categories           |
| `bg.local.goods.stock.edit`     | Update inventory         |
| `bg.open.accesstoken.create`    | Exchange auth code for access_token |

### Open source SDK implementations

- [AlienLlama0/temu-js-sdk](https://github.com/AlienLlama0/temu-js-sdk) — TypeScript, full sign algorithm
- [XIE7654/temu_api](https://github.com/XIE7654/temu_api) — Python, 60+ API methods

---

## 2. Consumer-facing website API

The API that `temu.com` calls in the browser when a user browses products. This is undocumented and heavily protected.

### Protection mechanisms

- JavaScript fingerprinting (canvas, WebGL, plugins, navigator properties)
- Dynamic session cookies set by their anti-bot layer
- GeeTest slide CAPTCHA or custom sliding puzzle
- IP-based rate limiting
- Redirect to `login.html` when bot detected

### Token status

**No public reverse-engineering of the consumer-facing request token exists.** The Reddit thread at `r/webscraping` (Jan 2025) mentions that a Chinese data team successfully reversed the sign token from the mobile APK, but no public implementation was shared. The consensus was:

> "You have to recreate that token, there is no easy way of doing it, you have to reverse the JS and see how that token is getting created." — u/hackbyown

> "If you have valid sign token the API request will pass successfully without a single blocking and then you can scale it across 100s of concurrent workers." — u/hackbyown

### Known working browser scraper approaches

- [n1ceh4t/Temu-Item-Scraper](https://github.com/n1ceh4t/Temu-Item-Scraper) — Selenium + session cookies
- [FarisAshhab/temu-product-scraper](https://github.com/FarisAshhab/temu-product-scraper) — requires manual browser login

All public scrapers use headless browser automation rather than direct API calls.

---

## Current approach in this project

This sidecar uses Playwright with `playwright-extra` + `puppeteer-extra-plugin-stealth` to evade browser fingerprint detection.

### Status (tested May 2026)

**Blocked.** Temu's `phantom` anti-bot system detects Playwright even with the stealth plugin and serves degraded responses:

- All product API endpoints (`/api/poppy/v1/goods`, `/api/seo/get_page_seo_data`) return `{"success":false,"error_code":40002}` or empty results
- The SPA renders a blank page (only zero-width space characters in body text)
- The only endpoint that fires is `/api/poppy/v1/goods_detail?scene=goods_detail_sold_out_similar` with `{"server_time":0,"has_more":false}`

The stealth plugin bypasses the login redirect and CAPTCHA detection, but the `phantom` fingerprinting layer identifies the automated browser at the SPA level before rendering any product data.

### Anti-bot flow (implemented)

```
1. Prewarm: navigate to temu.com homepage to establish session
2. Navigate to product URL (tracking params stripped)
3. Wait for SPA to render (up to 12s)
4. If redirected to login.html → wait for manual login (loginWaitMs)
5. If login modal overlay → try Escape / close button
6. If sliding puzzle → wait for manual solve (verificationWaitMs)
7. Extract from: network JSON → JSON-LD → DOM fallback
8. Save session to .sessions/temu-direct.json for reuse
```

### Path to unblocking

In order of effort:

1. **Residential proxies** — rotating proxies that haven't been flagged by `phantom`. Add URLs to `PROXY_URLS` in `.env`. Success rate depends on proxy quality; datacenter proxies will also be blocked.
2. **Mobile APK token** — reverse engineer Temu's mobile app to extract the sign token generation algorithm. With a valid token, direct API calls bypass browser automation entirely and scale to hundreds of concurrent workers (confirmed by community research).
3. **Seller Partner API** — requires an approved Temu seller account. Gives legitimate access to product data via the documented OpenAPI.

---

## References

- [AlienLlama0/temu-js-sdk](https://github.com/AlienLlama0/temu-js-sdk)
- [XIE7654/temu_api](https://github.com/XIE7654/temu_api)
- [arvingill/Temu-API-Doc](https://github.com/arvingill/Temu-API-Doc)
- [Temu Partner EU — API documentation](https://partner-eu.temu.com/documentation)
- [r/webscraping — Temu Scraper thread (Jan 2025)](https://www.reddit.com/r/webscraping/comments/1hzv76j/temu_scraper/)
- [How to Scrape Temu — Crawlbase](https://crawlbase.com/blog/how-to-scrape-temu/)
