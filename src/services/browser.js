import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";
import { config, resolveProjectPath } from "../config.js";

const browserPromises = new Map();

const ensureDirectory = async (directoryPath) => {
  await fs.mkdir(directoryPath, { recursive: true });
};

const sanitizeSegment = (value) => value.replace(/[^a-z0-9._-]/gi, "-");

const resolveProxySettings = (proxyUrl) => {
  if (!proxyUrl) {
    return null;
  }

  const parsed = new URL(proxyUrl);
  const proxy = {
    server: `${parsed.protocol}//${parsed.host}`,
  };

  if (parsed.username) {
    proxy.username = decodeURIComponent(parsed.username);
  }

  if (parsed.password) {
    proxy.password = decodeURIComponent(parsed.password);
  }

  return proxy;
};

const getBrowserKey = (proxyUrl) => proxyUrl || "direct";

const getStorageStatePath = async (profileKey) => {
  const directoryPath = resolveProjectPath(config.sessionStateDir);
  await ensureDirectory(directoryPath);
  return path.join(directoryPath, `${sanitizeSegment(profileKey)}.json`);
};

const resolveStorageStateOption = async (storageStatePath) => {
  try {
    await fs.access(storageStatePath);
    return storageStatePath;
  } catch {
    return undefined;
  }
};

export const getBrowser = async (options = {}) => {
  const browserKey = getBrowserKey(options.proxyUrl);
  const proxySettings = resolveProxySettings(options.proxyUrl);

  if (!browserPromises.has(browserKey)) {
    browserPromises.set(browserKey, chromium.launch({
      headless: config.browserHeadless,
      ...(proxySettings ? { proxy: proxySettings } : {}),
    }));
  }

  return browserPromises.get(browserKey);
};

export const withPage = async (callback, options = {}) => {
  const storageStatePath = await getStorageStatePath(options.profileKey || "default");
  const storageState = await resolveStorageStateOption(storageStatePath);
  const browser = await getBrowser({ proxyUrl: options.proxyUrl });
  const context = await browser.newContext({
    locale: options.locale || "pt-PT",
    userAgent: config.userAgent,
    viewport: {
      width: 1366,
      height: 768,
    },
    screen: {
      width: 1366,
      height: 768,
    },
    colorScheme: "light",
    timezoneId: "Europe/Lisbon",
    extraHTTPHeaders: {
      "Accept-Language": options.acceptLanguage || "pt-PT,pt;q=0.9,en;q=0.8",
    },
    ...(storageState ? { storageState } : {}),
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });

    Object.defineProperty(navigator, "platform", {
      get: () => "Win32",
    });

    Object.defineProperty(navigator, "languages", {
      get: () => ["pt-PT", "pt", "en-US", "en"],
    });

    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  page.setDefaultTimeout(config.requestTimeoutMs);

  try {
    return await callback(page);
  } finally {
    await context.storageState({ path: storageStatePath });
    await context.close();
  }
};

const closeBrowser = async () => {
  if (browserPromises.size === 0) {
    return;
  }

  const currentBrowsers = Array.from(browserPromises.values());
  browserPromises.clear();
  await Promise.all(currentBrowsers.map(async (browserPromise) => {
    const browser = await browserPromise;
    await browser.close();
  }));
};

process.once("SIGINT", () => {
  closeBrowser().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  closeBrowser().finally(() => process.exit(0));
});
