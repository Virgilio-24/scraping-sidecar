import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { config, resolveProjectPath } from "../config.js";

const SHEIN_PROFILE_MARKETS = ["pt", "www", "es", "fr"];
const SHEIN_START_URL = "https://pt.shein.com/";
const SESSION_TIMEOUT_MS = config.loginWaitMs || 300_000;

const stealth = chromium;
stealth.use(StealthPlugin());

const getProfilePath = (market) => {
  const dir = resolveProjectPath(config.sessionStateDir);
  return path.join(dir, `${market}-direct-seeded.json`);
};

const ensureDir = async () => {
  await fs.mkdir(resolveProjectPath(config.sessionStateDir), { recursive: true });
};

export const captureSheinSession = async (market = "pt") => {
  await ensureDir();

  const profilePath = getProfilePath(market);

  // Always start fresh — avoids "Invalid parameters" from mismatched cookie domains

  // Always launch visible so the user can interact
  const browser = await stealth.launch({
    headless: false,
    args: [],
    channel: config.browserChannel || undefined,
  });

  const origin = market === "pt" ? "https://pt.shein.com" : `https://${market}.shein.com`;
  const startUrl = `${origin}/`;

  try {
    const context = await browser.newContext({
      locale: market === "pt" ? "pt-PT" : "en-US",
      userAgent: config.userAgent,
      viewport: { width: 1366, height: 768 },
      screen: { width: 1366, height: 768 },
      colorScheme: "light",
      timezoneId: "Europe/Lisbon",
      extraHTTPHeaders: {
        "Accept-Language": market === "pt" ? "pt-PT,pt;q=0.9,en;q=0.8" : "en-US,en;q=0.9",
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "languages", {
        get: () => ["pt-PT", "pt", "en-US", "en"],
      });
      if (!window.chrome) window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Give the user time to navigate, solve CAPTCHAs, and browse normally
    await page.waitForTimeout(SESSION_TIMEOUT_MS);

    // Save the full storage state (cookies + localStorage)
    await context.storageState({ path: profilePath });
    await context.close();

    // Read back to return cookie count
    const saved = JSON.parse(await fs.readFile(profilePath, "utf8"));
    const cookieCount = (saved.cookies || []).length;

    return { market, profilePath, cookieCount, savedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
};

export const getSheinSessionStatus = async () => {
  const results = [];

  for (const market of SHEIN_PROFILE_MARKETS) {
    const profilePath = getProfilePath(market);
    try {
      const raw = await fs.readFile(profilePath, "utf8");
      const data = JSON.parse(raw);
      const cookies = data.cookies || [];
      const sheinCookies = cookies.filter((c) =>
        c.domain?.includes("shein.com")
      );
      const stat = await fs.stat(profilePath);
      results.push({
        market,
        exists: true,
        cookieCount: cookies.length,
        sheinCookieCount: sheinCookies.length,
        savedAt: stat.mtime.toISOString(),
        hasSession: sheinCookies.length > 0,
      });
    } catch {
      results.push({ market, exists: false, cookieCount: 0, sheinCookieCount: 0, hasSession: false });
    }
  }

  return results;
};

export const clearSheinSession = async (market = "pt") => {
  const profilePath = getProfilePath(market);
  try {
    await fs.unlink(profilePath);
    return { market, cleared: true };
  } catch {
    return { market, cleared: false };
  }
};
