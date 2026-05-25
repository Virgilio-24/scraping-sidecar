import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const configFilePath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(configFilePath), "..");

const parseProxyList = (value) => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const numberFromEnv = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: numberFromEnv(process.env.PORT, 3001),
  browserHeadless: process.env.BROWSER_HEADLESS === "true",
  navigationTimeoutMs: numberFromEnv(process.env.NAVIGATION_TIMEOUT_MS, 45000),
  requestTimeoutMs: numberFromEnv(process.env.REQUEST_TIMEOUT_MS, 45000),
  pageWaitMs: numberFromEnv(process.env.PAGE_WAIT_MS, 4000),
  retryAttempts: Math.max(numberFromEnv(process.env.RETRY_ATTEMPTS, 3), 1),
  prewarmHomeMs: Math.max(numberFromEnv(process.env.PREWARM_HOME_MS, 2500), 0),
  humanSolveWaitMs: Math.max(numberFromEnv(process.env.HUMAN_SOLVE_WAIT_MS, 6000), 0),
  verificationWaitMs: Math.max(numberFromEnv(process.env.VERIFICATION_WAIT_MS, 300000), 0),
  loginWaitMs: Math.max(numberFromEnv(process.env.LOGIN_WAIT_MS, 300000), 0),
  sessionStateDir: process.env.SESSION_STATE_DIR || ".sessions",
  proxyUrls: parseProxyList(process.env.PROXY_URLS),
  userAgent:
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
};

export const resolveProjectPath = (...segments) => path.join(projectRoot, ...segments);
