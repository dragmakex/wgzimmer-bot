const fs = require("fs");
const path = require("path");
const { chromium, request } = require("playwright");
require("dotenv").config();

const SEARCH_URL = "https://www.wgzimmer.ch/wgzimmer/search/room.html";
const HOME_URL = "https://www.wgzimmer.ch";
const SENT_PATH = path.join(__dirname, "..", "data", "sent.json");
const MAX_ATTEMPTS = 4;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function main() {
  const token = envRequired("TG_BOT_TOKEN");
  const chatId = envRequired("TG_CHAT_ID");
  const query = envRequired("SEARCH_QUERY");
  const headless = parseBoolEnv("HEADLESS", true);

  const sent = loadSent();
  const listings = await scrapeWithRetries(query, headless, MAX_ATTEMPTS);

  let newCount = 0;
  for (const listing of listings) {
    if (sent.has(listing.id)) continue;

    const message = `Neue WG-Zimmer-Anzeige gefunden:\n${listing.summary}\n${listing.href}`;
    await sendTelegram(token, chatId, message);
    sent.add(listing.id);
    newCount += 1;
  }

  saveSent(sent);
  console.log(`Done. ${newCount} new listing(s) notified.`);
}

async function scrapeWithRetries(query, headless, maxAttempts) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await scrapeOnce(query, headless);
    } catch (err) {
      lastErr = err;
      const backoff = attempt * 10;
      console.warn(
        `Attempt ${attempt}/${maxAttempts} failed: ${err.message}. Sleeping ${backoff}s`
      );
      await delay(backoff * 1000);
    }
  }
  throw lastErr || new Error("scraping failed after retries");
}

async function scrapeOnce(query, headless) {
  const browser = await chromium.launch({
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=1280,1600",
    ],
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 1600 },
  });
  const page = await context.newPage();

  try {
    await navigateToSearchForm(page);
    await maybeAcceptCookies(page);
    await waitForRecaptcha(page);

    const input = await page.waitForSelector('input[name="query"]', { timeout: 15000 });
    await input.fill("");
    await input.type(query, { delay: 30 });

    const button = await page.waitForSelector('input[type="button"][value="Suchen"]', {
      timeout: 10000,
    });

    // Try both click and direct submit; tolerate navigation destroying the context
    const navPromise = page.waitForURL(/search\/mate/, { timeout: 60000 }).catch(() => null);
    await Promise.allSettled([
      button.click({ timeout: 5000 }),
      page.evaluate("typeof submitForm === 'function' ? submitForm() : null"),
      navPromise,
    ]);

    // If still on form, try submit again once more after a brief pause
    if (page.url().includes("search/room")) {
      await delay(1000);
      await Promise.allSettled([
        page.evaluate("typeof submitForm === 'function' ? submitForm() : null"),
        page.waitForURL(/search\/mate/, { timeout: 20000 }).catch(() => null),
      ]);
    }

    await waitForResultsOrFallback(page, query);

    const listings = await page.$$eval("li.search-mate-entry a", (anchors) =>
      anchors
        .map((a) => {
          const href = a.href;
          const text = a.innerText || "";
          return { href, text };
        })
        .filter((x) => x.href)
    );

    const normalized = listings
      .map((item) => {
        try {
          const url = new URL(item.href);
          const segments = url.pathname.split("/").filter(Boolean);
          const id = segments[2];
          if (!id) return null;
          return {
            id,
            href: item.href,
            summary: item.text.trim(),
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    if (!normalized.length) {
      throw new Error("no listings found after search");
    }

    return normalized;
  } finally {
    await browser.close();
  }
}

async function navigateToSearchForm(page) {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await maybeAcceptCookies(page);

  // click logo link to ensure we're on /wgzimmer.html
  const homeLink = await page.waitForSelector('a[title="wgzimmer.ch"]', { timeout: 15000 });
  await Promise.allSettled([homeLink.click(), page.waitForLoadState("domcontentloaded")]);
  await maybeAcceptCookies(page);

  // click "Ich suche ein WG-Zimmer" tile
  const tileSelector = 'a[href="/wgzimmer/search/mate.html"]';
  const tile = await page.$(tileSelector);
  if (tile) {
    await Promise.allSettled([tile.click(), page.waitForLoadState("domcontentloaded")]);
    await maybeAcceptCookies(page);
  } else {
    console.warn("Search tile not found, navigating directly to search page");
  }

  // final fallback to ensure we landed on the form
  if (!page.url().includes("/wgzimmer/search/mate.html")) {
    await page.goto("https://www.wgzimmer.ch/wgzimmer/search/mate.html", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await maybeAcceptCookies(page);
  }
}

async function maybeAcceptCookies(page) {
  try {
    const btn = await page.waitForSelector("p.fc-button-label", { timeout: 5000 });
    await btn.click();
  } catch (_) {
    // ignore missing banner
  }
}

async function waitForRecaptcha(page) {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const ready = await page
      .evaluate(
        "typeof grecaptcha !== 'undefined' && typeof grecaptcha.execute === 'function'"
      )
      .catch(() => false);
    if (ready) return;
    await delay(500);
  }
  throw new Error("grecaptcha not ready after waiting");
}

async function waitForResultsOrFallback(page, query) {
  const resultsSelector = "#search-result-list li.search-mate-entry";
  try {
    await page.waitForSelector(resultsSelector, { timeout: 75000 });
    return;
  } catch (err) {
    console.warn("No results after form submit, trying direct navigation fallback");
  }

  const fallbackUrl = buildSearchUrl(query);
  await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(resultsSelector, { timeout: 45000 });
}

function buildSearchUrl(query) {
  const params = new URLSearchParams({
    startSearch: "true",
    "g-recaptcha-response": "",
    "bypass-csrf": "true",
    query,
    priceMin: "200",
    priceMax: "2000",
    wgState: "all",
    permanent: "all",
    studio: "false",
    student: "none",
    typeofwg: "all",
  });
  return `https://www.wgzimmer.ch/wgzimmer/search/mate.html?${params.toString()}`;
}


async function sendTelegram(token, chatId, message) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram error: ${res.status} ${body}`);
  }
}

function loadSent() {
  if (!fs.existsSync(path.dirname(SENT_PATH))) {
    fs.mkdirSync(path.dirname(SENT_PATH), { recursive: true });
  }
  if (!fs.existsSync(SENT_PATH)) {
    fs.writeFileSync(SENT_PATH, "[]", "utf8");
  }
  const raw = fs.readFileSync(SENT_PATH, "utf8");
  const arr = JSON.parse(raw);
  return new Set(arr);
}

function saveSent(set) {
  const arr = Array.from(set);
  fs.writeFileSync(SENT_PATH, JSON.stringify(arr, null, 2), "utf8");
}

function envRequired(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env ${name}`);
  return val;
}

function parseBoolEnv(name, defaultVal) {
  const raw = process.env[name];
  if (raw === undefined) return defaultVal;
  return ["1", "true", "yes", "y", "on"].includes(raw.toLowerCase());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
