const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }
  return new Anthropic();
}

// Throttle: stay under Haiku's 50K input tokens/min
// ~3-4K tokens per call, 5s gap = ~12 calls/min = ~42K tokens/min
let lastApiCallTime = 0;
const MIN_API_INTERVAL_MS = 5000;

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < MIN_API_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_API_INTERVAL_MS - elapsed));
  }
  lastApiCallTime = Date.now();
}

// Retry with long backoff on 429 rate limits
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      const isLast = attempt === maxRetries;
      const isRateLimit = err.status === 429;
      const isTransient =
        isRateLimit ||
        err.status === 529 ||
        err.status === 500 ||
        err.status === 502 ||
        err.status === 503 ||
        err.message?.includes("ECONNRESET") ||
        err.message?.includes("ETIMEDOUT");
      if (isLast || !isTransient) throw err;
      const delay = isRateLimit
        ? 60000 * Math.pow(1.5, attempt) // 60s, 90s, 135s
        : 5000 * Math.pow(2, attempt);   // 5s, 10s, 20s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function extractText(resp) {
  let text = "";
  for (const block of resp.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

// Parse location from user message
async function parseLocation(client, message) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Extract location from: "${message}"

Reply ONLY JSON:
- City+state: {"city":"Denver","state":"Colorado","statewide":false,"understood":true}
- State only: {"city":null,"state":"Florida","statewide":true,"understood":true}
- Unknown: {"understood":false,"reason":"..."}

Use full state names. For Canada use full province names.`,
        },
      ],
    })
  );
  const text = resp.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { understood: false, reason: "Could not parse response" };
  return JSON.parse(jsonMatch[0]);
}

// Get cities for statewide search
async function getCitiesForState(client, state) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `List top 15-25 cities in ${state} by population. Include major metros and regional centers.
Reply ONLY JSON array: ["City1", "City2", ...]`,
        },
      ],
    })
  );
  const text = resp.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
}

// Deduplicate by domain
function addCompanyToMap(map, company) {
  if (!company.name || !company.website) return false;
  let url = company.website.trim();
  if (!url.startsWith("http")) url = "https://" + url;
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    if (!map.has(domain)) {
      map.set(domain, { name: company.name.trim(), website: url });
      return true;
    }
  } catch {}
  return false;
}

// Run a web search and extract company names + URLs
async function runSearchQuery(client, query, extractionPrompt) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: extractionPrompt }],
    })
  );
  const text = extractText(resp);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
}

// ============================================================
// DISCOVERY ENGINE — URL-only, no contact scraping
// ============================================================

async function discoverCompanies(client, city, state, statewide, onProgress) {
  const allCompanies = new Map();
  let totalSearches = 0;

  const canadianProvinces = [
    "Alberta", "British Columbia", "Manitoba", "New Brunswick",
    "Newfoundland and Labrador", "Nova Scotia", "Ontario", "Prince Edward Island",
    "Quebec", "Saskatchewan", "Northwest Territories", "Nunavut", "Yukon",
  ];
  const isCanadian = canadianProvinces.some(
    (p) => state.toLowerCase() === p.toLowerCase()
  );

  async function search(query, prompt, roundLabel) {
    totalSearches++;
    onProgress({
      type: "search_progress",
      message: `Searching (${totalSearches}): "${query}"`,
      count: allCompanies.size,
    });

    try {
      const companies = await runSearchQuery(client, query, prompt);
      let newCount = 0;
      for (const c of companies) {
        if (addCompanyToMap(allCompanies, c)) newCount++;
      }
      if (newCount > 0) {
        onProgress({
          type: "search_progress",
          message: `Found ${newCount} new companies (${allCompanies.size} total)`,
          count: allCompanies.size,
        });
      }
    } catch (err) {
      onProgress({
        type: "search_error",
        message: `Search failed: "${query}" (${err.message}). Continuing...`,
      });
    }
  }

  function makePrompt(query, locationDesc) {
    return `Search: ${query}

Find ALL modular, manufactured, prefab, kit, tiny home, commercial modular, and multifamily modular companies in ${locationDesc}.

Extract every company name and website URL. Use company's own website, not directory listings.

Reply ONLY JSON array: [{"name": "Company Name", "website": "https://..."}]`;
  }

  // ---- ROUND 1: Broad searches ----
  onProgress({ type: "discovery_round", round: 1, message: `Searching ${state}...` });

  const stateQueries = [
    `all modular home builders in ${state}`,
    `all manufactured home dealers in ${state}`,
    `prefab kit home builders ${state}`,
    `tiny home builders ${state}`,
    `mobile home dealers ${state}`,
    `commercial modular buildings ${state}`,
    `multifamily modular construction ${state}`,
    `manufactured home sales centers ${state}`,
  ];

  if (isCanadian) {
    stateQueries.push(`modular home builders ${state} Canada list`);
  }

  for (const q of stateQueries) {
    await search(q, makePrompt(q, state), "Round 1");
  }

  // ---- ROUND 2: Directory searches ----
  onProgress({ type: "discovery_round", round: 2, message: `Searching directories for ${state}...` });

  const directoryQueries = [
    `manufactured home dealers ${state} site:mhvillage.com`,
    `modular home builders ${state} site:houzz.com OR site:buildzoom.com`,
    `${state} manufactured housing association members list`,
    `manufactured home dealers ${state} site:yellowpages.com OR site:bbb.org`,
  ];

  for (const q of directoryQueries) {
    await search(q, makePrompt(q, state), "Round 2");
  }

  // ---- ROUND 3: Manufacturer dealer networks ----
  onProgress({ type: "discovery_round", round: 3, message: `Searching dealer networks in ${state}...` });

  const dealerQueries = [
    `Clayton Homes OR Champion Homes OR Cavco dealers ${state}`,
    `Palm Harbor OR Fleetwood OR Skyline Champion dealers ${state}`,
    `Jacobsen OR Commodore OR Franklin OR TRU Homes dealers ${state}`,
  ];

  for (const q of dealerQueries) {
    await search(q, makePrompt(q, state), "Round 3");
  }

  // ---- ROUND 4: City-by-city ----
  let cities = [];
  if (statewide) {
    onProgress({ type: "discovery_round", round: 4, message: `Searching cities in ${state}...` });
    cities = await getCitiesForState(client, state);
    onProgress({
      type: "search_progress",
      message: `Searching ${cities.length} cities in ${state}`,
      count: allCompanies.size,
    });
  } else {
    cities = [city];
  }

  for (let ci = 0; ci < cities.length; ci++) {
    const cityName = cities[ci];
    const q = `modular OR manufactured home builders dealers ${cityName} ${state}`;
    await search(q, makePrompt(q, `${cityName}, ${state}`), `Cities [${ci + 1}/${cities.length}]`);
  }

  // ---- ROUND 5: Final sweep ----
  onProgress({ type: "discovery_round", round: 5, message: `Final sweep for ${state}...` });

  const finalQueries = [
    `"modular home" OR "manufactured home" OR "prefab" builders ${state} "contact us"`,
    `panelized home builders ${state} OR kit home builders ${state}`,
  ];

  for (const q of finalQueries) {
    await search(q, makePrompt(q, state), "Round 5");
  }

  onProgress({
    type: "search_progress",
    message: `Discovery complete! Found ${allCompanies.size} unique companies in ${totalSearches} searches.`,
    count: allCompanies.size,
  });

  return Array.from(allCompanies.values());
}

// ============================================================
// API ENDPOINT — URL discovery only, no scraping phase
// ============================================================

app.post("/api/search", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  req.setTimeout(0);
  res.setTimeout(0);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const client = getClient();

    send({ type: "status", message: "Understanding your request..." });
    const location = await parseLocation(client, message);

    if (!location.understood) {
      send({
        type: "error",
        message: location.reason || "I couldn't understand that location. Try 'Find modular home builders in Florida' or 'builders in Denver, Colorado'.",
      });
      send({ type: "done" });
      clearInterval(heartbeat);
      return res.end();
    }

    const { city, state, statewide } = location;
    const locationDesc = statewide ? state : `${city}, ${state}`;

    send({
      type: "status",
      message: `Great! I'll search for modular home builders in ${locationDesc}. This might take 5-7 minutes...`,
    });

    const startTime = Date.now();
    send({
      type: "phase",
      phase: "discovery",
      message: `Starting web search for modular home builders in ${locationDesc}...`,
    });

    const companies = await discoverCompanies(client, city, state, statewide || false, send);

    if (companies.length === 0) {
      send({
        type: "error",
        message: `No modular home builders found in ${locationDesc}. Try a different location.`,
      });
      send({ type: "done" });
      clearInterval(heartbeat);
      return res.end();
    }

    // Results — URLs only, no scraping needed
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = `${minutes}m ${seconds}s`;

    send({
      type: "results",
      city: city || "(statewide)",
      state,
      statewide: statewide || false,
      totalCompanies: companies.length,
      timeElapsed: timeStr,
      results: companies.map((c) => ({
        name: c.name,
        website: c.website,
      })),
    });
    send({ type: "done" });
  } catch (err) {
    send({
      type: "error",
      message: `Error: ${err.message}. Please check your ANTHROPIC_API_KEY and try again.`,
    });
    send({ type: "done" });
  }

  clearInterval(heartbeat);
  res.end();
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🏠 Modular Home Builder Finder`);
  console.log(`   Running at http://localhost:${PORT}`);
  console.log(
    `   API Key: ${process.env.ANTHROPIC_API_KEY ? "✓ Set" : "✗ Missing (set ANTHROPIC_API_KEY)"}`
  );
  console.log("");
});
