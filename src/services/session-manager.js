import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config, resolveProjectPath } from "../config.js";

chromium.use(StealthPlugin());

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
      viewport: { width: 1366, height: 768 },
      screen: { width: 1366, height: 768 },
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
