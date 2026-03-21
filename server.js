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

// Throttle: wait between API calls to stay under rate limits
let lastApiCallTime = 0;
// Haiku: 50K input tokens/min, ~3-5K tokens per web search call = ~10-16 calls/min safe
// 5 seconds between calls = 12 calls/min max, well within limits
const MIN_API_INTERVAL_MS = 5000;

async function throttle() {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < MIN_API_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_API_INTERVAL_MS - elapsed));
  }
  lastApiCallTime = Date.now();
}

// Retry wrapper — retries on transient errors with exponential backoff
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
      // Rate limit: wait 60s+ with backoff; other transient: shorter backoff
      const delay = isRateLimit
        ? 60000 * Math.pow(1.5, attempt) // 60s, 90s, 135s
        : 5000 * Math.pow(2, attempt);   // 5s, 10s, 20s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Extract text blocks from Claude response
function extractText(resp) {
  let text = "";
  for (const block of resp.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

// Parse location — supports "city, state" OR just "state" for statewide searches
async function parseLocation(client, message) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: `Extract the location from this message. The user is looking for modular/manufactured/prefab/tiny home builders.

The user may specify:
- A city AND state (e.g., "builders in Denver, Colorado")
- JUST a state or province (e.g., "all builders in Florida", "every company in Texas")

For US locations, use full state names (e.g., "California" not "CA").
For Canadian locations, use full province names (e.g., "Ontario" not "ON").

Reply with ONLY valid JSON in one of these formats:
- City + state: {"city": "Denver", "state": "Colorado", "statewide": false, "understood": true}
- State only: {"city": null, "state": "Florida", "statewide": true, "understood": true}
- Cannot understand: {"understood": false, "reason": "..."}

Message: "${message}"`,
        },
      ],
    })
  );
  const text = resp.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { understood: false, reason: "Could not parse response" };
  return JSON.parse(jsonMatch[0]);
}

// Ask Claude to list all major cities/metros in a state for comprehensive searching
async function getCitiesForState(client, state) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `List the top 15-25 cities in ${state} by population where modular/manufactured home builders operate. Include major metros and key regional centers.

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

// Add a company to the map (deduplicates by domain)
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

// Run a single search query and extract companies from the response
async function runSearchQuery(client, query, extractionPrompt) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        },
      ],
      messages: [
        {
          role: "user",
          content: extractionPrompt,
        },
      ],
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
// DISCOVERY ENGINE — finds as many companies as possible
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
  const country = isCanadian ? "Canada" : "USA";

  // Helper to run one search and collect results
  async function search(query, prompt, roundLabel) {
    totalSearches++;
    onProgress({
      type: "search_progress",
      message: `${roundLabel} — Search #${totalSearches}: "${query}"`,
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
          message: `${roundLabel} — Found ${newCount} new companies (${allCompanies.size} total)`,
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

  // Standard prompt for company extraction
  function makePrompt(query, locationDesc) {
    return `Search: ${query}

Find ALL modular/manufactured/prefab/tiny home builders and dealers in ${locationDesc}. Extract every company with its website URL (not directory listings).

Reply ONLY JSON array: [{"name": "Company Name", "website": "https://..."}]
Include every company found.`;
  }

  // ---- ROUND 1: Broad state-wide searches ----
  onProgress({
    type: "discovery_round",
    round: 1,
    message: `Round 1: State-wide searches for ${state}...`,
  });

  const stateQueries = [
    `all modular home builders in ${state}`,
    `all manufactured home dealers in ${state}`,
    `prefab home builders ${state} complete list`,
    `tiny home builders ${state}`,
    `mobile home dealers ${state}`,
    `manufactured home sales centers ${state}`,
  ];

  if (isCanadian) {
    stateQueries.push(
      `modular home builders ${state} Canada list`,
    );
  }

  for (const q of stateQueries) {
    await search(q, makePrompt(q, state), "Round 1: State-wide");
  }

  // ---- ROUND 2: Industry directory searches ----
  onProgress({
    type: "discovery_round",
    round: 2,
    message: `Round 2: Industry directory searches for ${state}...`,
  });

  const directoryQueries = [
    `manufactured home dealers ${state} site:mhvillage.com`,
    `modular home builders ${state} site:houzz.com OR site:buildzoom.com`,
    `${state} manufactured housing association members list`,
    `manufactured home dealers ${state} site:yellowpages.com OR site:bbb.org`,
  ];

  for (const q of directoryQueries) {
    await search(q, makePrompt(q, state), "Round 2: Directories");
  }

  // ---- ROUND 3: Manufacturer dealer network searches ----
  onProgress({
    type: "discovery_round",
    round: 3,
    message: `Round 3: Manufacturer dealer networks in ${state}...`,
  });

  const dealerQueries = [
    `Clayton Homes OR Champion Homes OR Cavco dealers ${state}`,
    `Palm Harbor OR Fleetwood OR Skyline Champion dealers ${state}`,
    `Jacobsen OR Commodore OR Franklin OR TRU Homes dealers ${state}`,
  ];

  for (const q of dealerQueries) {
    await search(q, makePrompt(q, state), "Round 3: Dealer networks");
  }

  // ---- ROUND 4: City-by-city searches ----
  // Determine which cities to search
  let cities = [];
  if (statewide) {
    onProgress({
      type: "discovery_round",
      round: 4,
      message: `Round 4: Identifying all cities in ${state} to search...`,
    });
    cities = await getCitiesForState(client, state);
    onProgress({
      type: "search_progress",
      message: `Found ${cities.length} cities in ${state} to search individually`,
      count: allCompanies.size,
    });
  } else {
    cities = [city];
  }

  // Search each city with multiple query types
  const cityQueryTypes = [
    (c, s) => `modular home builders ${c} ${s}`,
    (c, s) => `manufactured home dealers ${c} ${s}`,
  ];

  for (let ci = 0; ci < cities.length; ci++) {
    const cityName = cities[ci];
    const cityLabel = `Round 4: Cities [${ci + 1}/${cities.length}] ${cityName}`;

    for (const mkQuery of cityQueryTypes) {
      const q = mkQuery(cityName, state);
      await search(q, makePrompt(q, `${cityName}, ${state}`), cityLabel);
    }
  }

  // ---- ROUND 5: Deep sweep — catch stragglers ----
  onProgress({
    type: "discovery_round",
    round: 5,
    message: `Round 5: Deep sweep — additional search strategies for ${state}...`,
  });

  const deepQueries = [
    `"modular home" OR "manufactured home" builders ${state} "contact us"`,
    `custom modular homes ${state} builders reviews`,
  ];

  for (const q of deepQueries) {
    await search(q, makePrompt(q, state), "Round 5: Deep sweep");
  }

  // ---- ROUND 6: Retailers & sales centers — dedicated retail sweep ----
  onProgress({
    type: "discovery_round",
    round: 6,
    message: `Round 6: Retailers, sales centers & mobile home dealers in ${state}...`,
  });

  const retailQueries = [
    `manufactured home retailers ${state} complete list directory`,
    `mobile home sales centers showroom ${state}`,
  ];

  for (const q of retailQueries) {
    await search(q, makePrompt(q, state), "Round 6: Retailers");
  }

  onProgress({
    type: "search_progress",
    message: `Discovery complete! Found ${allCompanies.size} unique companies after ${totalSearches} searches.`,
    count: allCompanies.size,
  });

  return Array.from(allCompanies.values());
}

// ============================================================
// CONTACT SCRAPING (single-phase per company — saves 2 API calls each)
// ============================================================

function parseScrapedData(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const data = JSON.parse(jsonMatch[0]);
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      data.email = null;
    }
    if (data.salesEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.salesEmail)) {
      data.salesEmail = null;
    }
    if (data.phone) {
      const digits = data.phone.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) data.phone = null;
    }
    return data;
  } catch {
    return null;
  }
}

async function scrapeCompany(client, company, state, onPhaseUpdate) {
  let domain = "";
  try {
    domain = new URL(company.website).hostname.replace("www.", "");
  } catch {}

  try {
    onPhaseUpdate(company.name, "Scraping contact info...");
    const resp = await withRetry(() =>
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [
          {
            role: "user",
            content: `Find email and phone for: ${company.name}
Website: ${company.website}

Search their website contact page and directories for contact info. Try: site:${domain} contact email phone, "${company.name}" ${state} email phone

Reply ONLY JSON:
{"name":"${company.name}","website":"${company.website}","email":"found email or null","salesEmail":"sales email or null","phone":"found phone or null","specialties":["only include applicable: Manufactured Homes, Modular Homes, Tiny Homes, Commercial Modular"],"sourceUrl":"URL where found","confidence":"high or low"}

Only report what you actually find in search results. Never guess.`,
          },
        ],
      })
    );

    const text = extractText(resp);
    const data = parseScrapedData(text);

    return {
      name: data?.name || company.name,
      website: company.website,
      email: data?.email || null,
      salesEmail: data?.salesEmail || null,
      phone: data?.phone || null,
      specialties: data?.specialties || [],
      sourceUrl: data?.sourceUrl || "",
      confidence:
        data?.email && data?.phone
          ? "high"
          : data?.email || data?.phone
            ? "medium"
            : "low",
      status: "success",
    };
  } catch (err) {
    return {
      ...company,
      status: "error",
      error: err.message,
      email: null,
      phone: null,
      specialties: [],
      confidence: "low",
    };
  }
}

// ============================================================
// API ENDPOINT
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

    // Step 1: Parse location
    send({ type: "status", message: "Understanding your request..." });
    const location = await parseLocation(client, message);

    if (!location.understood) {
      send({
        type: "error",
        message:
          location.reason ||
          "I couldn't understand that location. Try something like 'Find all modular home builders in Florida' or 'builders in Denver, Colorado'.",
      });
      send({ type: "done" });
      clearInterval(heartbeat);
      return res.end();
    }

    const { city, state, statewide } = location;
    const locationDesc = statewide ? state : `${city}, ${state}`;

    send({
      type: "status",
      message: statewide
        ? `Great! I'll search for modular home builders across ${state}. This might take 5-7 minutes...`
        : `Great! I'll search for modular home builders in ${city}, ${state}. This might take 5-7 minutes...`,
    });

    // Step 2: Discovery — find every company possible
    const startTime = Date.now();
    send({
      type: "phase",
      phase: "discovery",
      message: `PHASE 1: DISCOVERY — Finding every modular/manufactured home company in ${locationDesc}...`,
    });

    const companies = await discoverCompanies(
      client,
      city,
      state,
      statewide || false,
      send
    );

    if (companies.length === 0) {
      send({
        type: "error",
        message: `No modular home builders found in ${locationDesc}. Try a different state or check spelling.`,
      });
      send({ type: "done" });
      clearInterval(heartbeat);
      return res.end();
    }

    send({
      type: "search_complete",
      message: `Discovery complete! Found ${companies.length} unique companies. Now deep-scraping each one for contact info...`,
      count: companies.length,
    });

    // Step 3: Scrape each company one at a time
    send({
      type: "phase",
      phase: "scrape",
      message: `PHASE 2: CONTACT SCRAPING — Scraping ${companies.length} companies for emails, phones & specialties...`,
    });

    const results = [];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];

      const onPhaseUpdate = (name, status) => {
        send({
          type: "scrape_progress",
          message: `[${i + 1}/${companies.length}] ${name} — ${status}`,
          current: i + 1,
          total: companies.length,
          percent: Math.round(((i) / companies.length) * 100),
        });
      };

      const result = await scrapeCompany(client, company, state, onPhaseUpdate);
      results.push(result);

      const hasEmail = result.email ? "email found" : "no email";
      const hasPhone = result.phone ? "phone found" : "no phone";
      const icon = result.email || result.phone ? "OK" : "--";
      send({
        type: "scrape_progress",
        message: `[${i + 1}/${companies.length}] ${result.name || company.name} — ${icon} (${hasEmail}, ${hasPhone})`,
        current: i + 1,
        total: companies.length,
        percent: Math.round(((i + 1) / companies.length) * 100),
      });
    }

    // Step 4: Compile results
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    const timeStr = hours > 0
      ? `${hours}h ${minutes}m ${seconds}s`
      : `${minutes}m ${seconds}s`;
    const withEmail = results.filter((r) => r.email).length;
    const withPhone = results.filter((r) => r.phone).length;

    const summary = {
      type: "results",
      city: city || "(statewide)",
      state,
      statewide: statewide || false,
      totalCompanies: results.length,
      withEmail,
      withPhone,
      emailPercent:
        results.length > 0 ? Math.round((withEmail / results.length) * 100) : 0,
      phonePercent:
        results.length > 0 ? Math.round((withPhone / results.length) * 100) : 0,
      timeElapsed: timeStr,
      results: results.map((r) => ({
        name: r.name || "Unknown",
        website: r.website || "",
        email: r.email || null,
        salesEmail: r.salesEmail || null,
        phone: r.phone || null,
        specialties: r.specialties || [],
        sourceUrl: r.sourceUrl || "",
        confidence: r.confidence || "low",
        status: r.status || "unknown",
      })),
    };

    send(summary);
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
