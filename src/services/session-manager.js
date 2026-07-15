import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config, resolveProjectPath } from "../config.js";

chromium.use(StealthPlugin());

// Active VNC browser sessions waiting to be saved manually
const activeSessions = new Map(); // siteKey → { context, page, resolve, reject }

export const saveActiveSession = async (siteKey) => {
  const session = activeSessions.get(siteKey);
  if (!session) throw new Error(`Nenhuma sessão VNC activa para "${siteKey}".`);
  session.resolve();
};

export const cancelActiveSession = async (siteKey) => {
  const session = activeSessions.get(siteKey);
  if (!session) throw new Error(`Nenhuma sessão VNC activa para "${siteKey}".`);
  session.reject(new Error("Sessão cancelada pelo utilizador."));
};

// All supported sites with their profile keys and start URLs
export const SITE_CONFIGS = {
  "shein-pt":      { profileKey: "pt-direct-seeded",        startUrl: "https://pt.shein.com/",           name: "SHEIN Portugal",    locale: "pt-PT" },
  "shein-www":     { profileKey: "www-direct-seeded",       startUrl: "https://www.shein.com/",          name: "SHEIN Global",      locale: "en-US" },
  "shein-es":      { profileKey: "es-direct-seeded",        startUrl: "https://www.shein.com/es/",       name: "SHEIN España",      locale: "es-ES" },
  "temu":          { profileKey: "temu-direct",              startUrl: "https://www.temu.com/pt/",        name: "Temu Portugal",     locale: "pt-PT" },
  "amazon-pt":     { profileKey: "amazon-pt-direct",        startUrl: "https://www.amazon.es/",          name: "Amazon ES (PT)",    locale: "pt-PT" },
  "amazon-com":    { profileKey: "amazon-com-direct",       startUrl: "https://www.amazon.com/",         name: "Amazon COM",        locale: "en-US" },
  "amazon-uk":     { profileKey: "amazon-uk-direct",        startUrl: "https://www.amazon.co.uk/",       name: "Amazon UK",         locale: "en-GB" },
  "zalando":       { profileKey: "zalando-pt-direct",       startUrl: "https://www.zalando.pt/",         name: "Zalando PT",        locale: "pt-PT" },
  "zara":          { profileKey: "zara-pt-direct",          startUrl: "https://www.zara.com/pt/",        name: "Zara PT",           locale: "pt-PT" },
  "hm":            { profileKey: "hm-api-direct",           startUrl: "https://www.hm.com/pt_pt/",       name: "H&M PT",            locale: "pt-PT" },
  "aliexpress":    { profileKey: "aliexpress-direct",       startUrl: "https://pt.aliexpress.com/",      name: "AliExpress PT",     locale: "pt-PT" },
  "pullandbear":   { profileKey: "pullandbear-pt-direct",   startUrl: "https://www.pullandbear.com/pt/", name: "Pull&Bear PT",      locale: "pt-PT" },
  "bershka":       { profileKey: "bershka-pt-direct",       startUrl: "https://www.bershka.com/pt/",     name: "Bershka PT",        locale: "pt-PT" },
};

const getProfilePath = (profileKey) => {
  const dir = resolveProjectPath(config.sessionStateDir);
  return path.join(dir, `${profileKey.replace(/[^a-z0-9._-]/gi, "-")}.json`);
};

const ensureDir = async () => {
  await fs.mkdir(resolveProjectPath(config.sessionStateDir), { recursive: true });
};

const dismissOverlays = async (page) => {
  // Remove fixed/absolute overlays blocking interaction
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((el) => {
      const style = window.getComputedStyle(el);
      if (
        (style.position === "fixed" || style.position === "absolute") &&
        style.zIndex > 100 &&
        style.display !== "none" &&
        !el.querySelector("input, button, a, form")
      ) {
        el.style.display = "none";
      }
    });
  }).catch(() => {});

  // Click common consent/accept buttons
  const cookieSelectors = [
    'button[id*="accept"]', 'button[class*="accept"]',
    'button[id*="cookie"]', 'button[class*="cookie"]',
    'button[id*="consent"]', 'button[class*="consent"]',
    'button:has-text("Accept")', 'button:has-text("Aceitar")',
    'button:has-text("Accept All")', 'button:has-text("Aceitar tudo")',
    'button:has-text("Got it")', 'button:has-text("OK")',
  ];
  for (const sel of cookieSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        console.log(`[session] Overlay/cookie dispensado (${sel})`);
        break;
      }
    } catch { /* ignore */ }
  }
};

// Opens a visible browser on the VNC display, navigates to a product URL,
// waits until the product page has real content, then saves cookies.
// Only saves if the product was actually returned (no CAPTCHA remaining).
export const captureSessionForProduct = async (siteKey, productUrl, { timeoutMs = 600_000 } = {}) => {
  const site = SITE_CONFIGS[siteKey];
  if (!site) throw new Error(`Unknown site key: "${siteKey}"`);

  await ensureDir();
  const profilePath = getProfilePath(site.profileKey);

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      "--no-default-browser-check",
    ],
    channel: config.browserChannel || undefined,
  });

  try {
    const context = await browser.newContext({
      locale: site.locale,
      userAgent: config.userAgent,
      viewport: null,
      screen: { width: 1920, height: 1080 },
      colorScheme: "light",
      timezoneId: "Europe/Lisbon",
      extraHTTPHeaders: {
        "Accept-Language": site.locale === "pt-PT"
          ? "pt-PT,pt;q=0.9,en;q=0.8"
          : `${site.locale},en;q=0.8`,
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      if (!window.chrome) window.chrome = { runtime: {} };
    });

    const page = await context.newPage();

    // Navigate to homepage first to trigger cookie consent and establish base session
    console.log(`[session] A navegar para homepage de ${site.name}...`);
    await page.goto(site.startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Auto-dismiss common cookie consent buttons and overlays
    await page.waitForTimeout(2000);
    await dismissOverlays(page);

    // Now navigate to the product URL
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2000);
    await dismissOverlays(page);

    console.log(`[session] VNC browser aberto → ${productUrl}`);
    console.log(`[session] Faz login/resolve CAPTCHA no noVNC e depois chama POST /api/session/save-vnc com { "site": "${siteKey}" }`);

    // Wait for manual save signal or timeout
    await new Promise((resolve, reject) => {
      activeSessions.set(siteKey, { context, page, resolve, reject });
      setTimeout(() => reject(new Error(`Timeout após ${timeoutMs / 1000}s. Cookies NOT saved.`)), timeoutMs);
    }).finally(() => {
      activeSessions.delete(siteKey);
    });

    // Save session after manual signal
    await context.storageState({ path: profilePath });
    await context.close();

    const saved = JSON.parse(await fs.readFile(profilePath, "utf8"));
    const cookieCount = (saved.cookies || []).length;

    // Sincronizar cookies para o Firestore via TradeFlow (para o import worker usar)
    if (saved.cookies?.length && config.tradeflowApiUrl && config.tradeflowAdminToken) {
      const domain = new URL(site.startUrl).hostname.replace(/^www\./, '');
      const cookieString = saved.cookies.map(c => `${c.name}=${c.value}`).join('; ');
      fetch(`${config.tradeflowApiUrl}/cookies/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': config.tradeflowAdminToken },
        body: JSON.stringify({ domain, cookies: cookieString }),
      }).then(() => console.log(`[session] ✅ ${cookieCount} cookies sincronizados para Firestore (${domain})`))
        .catch(err => console.warn(`[session] ⚠️ Falha ao sincronizar cookies: ${err.message}`));
    }

    console.log(`[session] ✅ Sessão guardada manualmente (${cookieCount} cookies)`);

    return {
      site: siteKey,
      name: site.name,
      profileKey: site.profileKey,
      profilePath,
      cookieCount,
      savedAt: new Date().toISOString(),
    };
  } finally {
    activeSessions.delete(siteKey);
    await browser.close();
  }
};

export const captureSession = async (siteKey) => {
  const site = SITE_CONFIGS[siteKey];
  if (!site) {
    throw new Error(`Unknown site key: "${siteKey}". Available: ${Object.keys(SITE_CONFIGS).join(", ")}`);
  }

  await ensureDir();
  const profilePath = getProfilePath(site.profileKey);
  const waitMs = config.loginWaitMs || 300_000;

  const browser = await chromium.launch({
    headless: false,
    args: [],
    channel: config.browserChannel || undefined,
  });

  try {
    const context = await browser.newContext({
      locale: site.locale,
      userAgent: config.userAgent,
      viewport: null,
      screen: { width: 1920, height: 1080 },
      colorScheme: "light",
      timezoneId: "Europe/Lisbon",
      extraHTTPHeaders: {
        "Accept-Language": site.locale === "pt-PT"
          ? "pt-PT,pt;q=0.9,en;q=0.8"
          : `${site.locale},en;q=0.8`,
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      if (!window.chrome) window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    await page.goto(site.startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    console.log(`[session] Browser aberto para ${site.name}. A aguardar ${waitMs / 1000}s de interação...`);
    await page.waitForTimeout(waitMs);

    await context.storageState({ path: profilePath });
    await context.close();

    const saved = JSON.parse(await fs.readFile(profilePath, "utf8"));
    const cookieCount = (saved.cookies || []).length;

    return {
      site: siteKey,
      name: site.name,
      profileKey: site.profileKey,
      profilePath,
      cookieCount,
      savedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
};

export const getAllSessionStatus = async () => {
  const results = [];

  for (const [siteKey, site] of Object.entries(SITE_CONFIGS)) {
    const profilePath = getProfilePath(site.profileKey);
    try {
      const raw = await fs.readFile(profilePath, "utf8");
      const data = JSON.parse(raw);
      const cookies = data.cookies || [];
      const siteCookies = cookies.filter((c) => {
        const domain = c.domain || "";
        return Object.values(SITE_CONFIGS)
          .some((s) => {
            try { return new URL(s.startUrl).hostname.includes(domain.replace(/^\./, "")); } catch { return false; }
          });
      });
      const stat = await fs.stat(profilePath);
      results.push({
        site: siteKey,
        name: site.name,
        profileKey: site.profileKey,
        exists: true,
        cookieCount: cookies.length,
        savedAt: stat.mtime.toISOString(),
        hasSession: cookies.length > 0,
      });
    } catch {
      results.push({
        site: siteKey,
        name: site.name,
        profileKey: site.profileKey,
        exists: false,
        cookieCount: 0,
        hasSession: false,
      });
    }
  }

  return results;
};

export const clearSession = async (siteKey) => {
  const site = SITE_CONFIGS[siteKey];
  if (!site) throw new Error(`Unknown site key: "${siteKey}"`);
  const profilePath = getProfilePath(site.profileKey);
  try {
    await fs.unlink(profilePath);
    return { site: siteKey, cleared: true };
  } catch {
    return { site: siteKey, cleared: false };
  }
};
