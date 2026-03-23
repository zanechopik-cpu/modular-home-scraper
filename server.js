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

// Parse location — always extracts the state/province for statewide search
async function parseLocation(client, message) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Extract the US state or Canadian province from this user message: "${message}"

The user only needs to provide a state or province — no city is needed. If they mention just a state name (like "Utah" or "Texas"), that is perfectly valid.

Reply ONLY JSON:
- Found: {"state":"Florida","understood":true}
- Not a valid US state or Canadian province: {"understood":false,"reason":"Please enter a US state or Canadian province."}

Always use full state names (e.g. "California" not "CA"). For Canada use full province names.
A state/province name alone is a complete, valid input.`,
        },
      ],
    })
  );
  const text = resp.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { understood: false, reason: "Could not parse response" };
  return JSON.parse(jsonMatch[0]);
}

// Get regions/areas within a state for broader coverage
async function getRegionsForState(client, state) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `List 5-8 geographic regions or areas of ${state} (e.g. "Northern ${state}", "Southern ${state}", "Central ${state}", "${state} Panhandle", major metro areas).
Reply ONLY JSON array: ["Region1", "Region2", ...]`,
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

// Get neighboring states/provinces for wider surface area
function getNeighboringStates(state) {
  const neighbors = {
    "Alabama": ["Georgia", "Florida", "Mississippi", "Tennessee"],
    "Alaska": [],
    "Arizona": ["New Mexico", "Nevada", "Utah", "California"],
    "Arkansas": ["Missouri", "Oklahoma", "Texas", "Louisiana", "Mississippi", "Tennessee"],
    "California": ["Oregon", "Nevada", "Arizona"],
    "Colorado": ["Wyoming", "Nebraska", "Kansas", "Oklahoma", "New Mexico", "Utah"],
    "Connecticut": ["New York", "Massachusetts", "Rhode Island"],
    "Delaware": ["Maryland", "Pennsylvania", "New Jersey"],
    "Florida": ["Georgia", "Alabama"],
    "Georgia": ["Florida", "Alabama", "Tennessee", "North Carolina", "South Carolina"],
    "Hawaii": [],
    "Idaho": ["Montana", "Wyoming", "Utah", "Nevada", "Oregon", "Washington"],
    "Illinois": ["Wisconsin", "Iowa", "Missouri", "Indiana", "Kentucky"],
    "Indiana": ["Illinois", "Michigan", "Ohio", "Kentucky"],
    "Iowa": ["Minnesota", "Wisconsin", "Illinois", "Missouri", "Nebraska", "South Dakota"],
    "Kansas": ["Nebraska", "Missouri", "Oklahoma", "Colorado"],
    "Kentucky": ["Indiana", "Ohio", "West Virginia", "Virginia", "Tennessee", "Missouri", "Illinois"],
    "Louisiana": ["Texas", "Arkansas", "Mississippi"],
    "Maine": ["New Hampshire"],
    "Maryland": ["Pennsylvania", "Delaware", "Virginia", "West Virginia"],
    "Massachusetts": ["New Hampshire", "Vermont", "New York", "Connecticut", "Rhode Island"],
    "Michigan": ["Ohio", "Indiana", "Wisconsin"],
    "Minnesota": ["Wisconsin", "Iowa", "South Dakota", "North Dakota"],
    "Mississippi": ["Tennessee", "Alabama", "Louisiana", "Arkansas"],
    "Missouri": ["Iowa", "Illinois", "Kentucky", "Tennessee", "Arkansas", "Oklahoma", "Kansas", "Nebraska"],
    "Montana": ["North Dakota", "South Dakota", "Wyoming", "Idaho"],
    "Nebraska": ["South Dakota", "Iowa", "Missouri", "Kansas", "Colorado", "Wyoming"],
    "Nevada": ["Oregon", "Idaho", "Utah", "Arizona", "California"],
    "New Hampshire": ["Maine", "Vermont", "Massachusetts"],
    "New Jersey": ["New York", "Pennsylvania", "Delaware"],
    "New Mexico": ["Colorado", "Oklahoma", "Texas", "Arizona", "Utah"],
    "New York": ["Vermont", "Massachusetts", "Connecticut", "New Jersey", "Pennsylvania"],
    "North Carolina": ["Virginia", "Tennessee", "Georgia", "South Carolina"],
    "North Dakota": ["Montana", "South Dakota", "Minnesota"],
    "Ohio": ["Michigan", "Indiana", "Kentucky", "West Virginia", "Pennsylvania"],
    "Oklahoma": ["Kansas", "Missouri", "Arkansas", "Texas", "New Mexico", "Colorado"],
    "Oregon": ["Washington", "Idaho", "Nevada", "California"],
    "Pennsylvania": ["New York", "New Jersey", "Delaware", "Maryland", "West Virginia", "Ohio"],
    "Rhode Island": ["Massachusetts", "Connecticut"],
    "South Carolina": ["North Carolina", "Georgia"],
    "South Dakota": ["North Dakota", "Minnesota", "Iowa", "Nebraska", "Wyoming", "Montana"],
    "Tennessee": ["Kentucky", "Virginia", "North Carolina", "Georgia", "Alabama", "Mississippi", "Arkansas", "Missouri"],
    "Texas": ["New Mexico", "Oklahoma", "Arkansas", "Louisiana"],
    "Utah": ["Idaho", "Wyoming", "Colorado", "New Mexico", "Arizona", "Nevada"],
    "Vermont": ["New Hampshire", "Massachusetts", "New York"],
    "Virginia": ["Maryland", "West Virginia", "Kentucky", "Tennessee", "North Carolina"],
    "Washington": ["Oregon", "Idaho"],
    "West Virginia": ["Ohio", "Pennsylvania", "Maryland", "Virginia", "Kentucky"],
    "Wisconsin": ["Michigan", "Minnesota", "Iowa", "Illinois"],
    "Wyoming": ["Montana", "South Dakota", "Nebraska", "Colorado", "Utah", "Idaho"],
  };
  return neighbors[state] || [];
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

const MAX_RESULTS = 100;

async function discoverCompanies(client, state, onProgress) {
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
          message: `+${newCount} new (${allCompanies.size} total)`,
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

Extract every company name + website URL. Use company's own website, not directory listings.

Reply ONLY JSON array: [{"name": "Company Name", "website": "https://..."}]
Include EVERY company you find. The more the better.`;
  }

  // ---- ROUND 1: Broad state-level searches ----
  onProgress({ type: "discovery_round", round: 1, message: `Broad search across ${state}...` });

  const stateQueries = [
    `all modular home builders in ${state} complete list`,
    `all manufactured home dealers in ${state} directory`,
    `prefab kit home builders ${state}`,
    `tiny home builders companies ${state}`,
    `mobile home dealers ${state} list`,
    `commercial modular construction companies ${state}`,
    `multifamily modular builders ${state}`,
    `manufactured home sales centers ${state}`,
    `modular home companies ${state} directory list`,
    `factory built homes ${state} dealers retailers`,
  ];

  if (isCanadian) {
    stateQueries.push(
      `modular home builders ${state} Canada complete list`,
      `prefab homes ${state} Canada companies`,
    );
  }

  for (const q of stateQueries) {
    await search(q, makePrompt(q, state), "Round 1");
  }

  // ---- ROUND 2: Directory & association searches ----
  onProgress({ type: "discovery_round", round: 2, message: `Directory searches for ${state}...` });

  const directoryQueries = [
    `manufactured home dealers ${state} site:mhvillage.com`,
    `modular home builders ${state} site:houzz.com OR site:buildzoom.com`,
    `${state} manufactured housing association members list`,
    `modular home builders ${state} site:yellowpages.com OR site:bbb.org`,
    `"modular homes" "${state}" site:modularhomes.com OR site:prefabreviews.com`,
  ];

  for (const q of directoryQueries) {
    await search(q, makePrompt(q, state), "Round 2");
  }

  // ---- ROUND 3: Manufacturer dealer networks ----
  onProgress({ type: "discovery_round", round: 3, message: `Dealer networks in ${state}...` });

  const dealerQueries = [
    `Clayton Homes OR Champion Homes OR Cavco dealers locations ${state}`,
    `Palm Harbor OR Fleetwood OR Skyline Champion dealers ${state}`,
    `Jacobsen OR Commodore OR Franklin OR TRU Homes OR Deer Valley dealers ${state}`,
    `Nobility Homes OR Adventure Homes OR Sunshine Homes dealers ${state}`,
  ];

  for (const q of dealerQueries) {
    await search(q, makePrompt(q, state), "Round 3");
  }

  // ---- ROUND 4: Regional searches within the state ----
  onProgress({ type: "discovery_round", round: 4, message: `Searching regions of ${state}...` });

  const regions = await getRegionsForState(client, state);
  onProgress({
    type: "search_progress",
    message: `Searching ${regions.length} regions in ${state}`,
    count: allCompanies.size,
  });

  for (let ri = 0; ri < regions.length; ri++) {
    const region = regions[ri];
    const q = `modular OR manufactured OR prefab home builders dealers ${region} ${state}`;
    await search(q, makePrompt(q, `${region}, ${state}`), `Regions [${ri + 1}/${regions.length}]`);
  }

  // ---- ROUND 5: Neighboring states for wider coverage ----
  const neighbors = isCanadian ? [] : getNeighboringStates(state);
  if (neighbors.length > 0) {
    // Pick up to 4 neighbors to keep token budget reasonable
    const searchNeighbors = neighbors.slice(0, 4);
    onProgress({ type: "discovery_round", round: 5, message: `Searching neighboring states: ${searchNeighbors.join(", ")}...` });

    for (const neighbor of searchNeighbors) {
      const queries = [
        `modular home builders ${neighbor} complete list`,
        `manufactured home dealers ${neighbor} directory`,
        `tiny home OR prefab OR kit home builders ${neighbor}`,
      ];
      for (const q of queries) {
        await search(q, makePrompt(q, neighbor), `Neighbor: ${neighbor}`);
      }
    }
  }

  // ---- ROUND 6: Final sweep — alternate terms ----
  onProgress({ type: "discovery_round", round: 6, message: `Final sweep...` });

  const finalQueries = [
    `"modular home" OR "manufactured home" builders ${state} "contact us" -site:yelp.com`,
    `panelized home builders ${state} OR kit home builders ${state}`,
    `ADU builders ${state} modular accessory dwelling unit`,
    `steel frame modular homes ${state} OR SIP panel homes ${state}`,
  ];

  for (const q of finalQueries) {
    await search(q, makePrompt(q, state), "Round 6");
  }

  const total = allCompanies.size;
  onProgress({
    type: "search_progress",
    message: `Discovery complete! Found ${total} unique companies in ${totalSearches} searches.`,
    count: total,
  });

  // Return up to MAX_RESULTS
  const all = Array.from(allCompanies.values());
  return all.slice(0, MAX_RESULTS);
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
        message: location.reason || "I couldn't understand that location. Try entering a US state (e.g. 'Florida', 'Texas') or Canadian province (e.g. 'Ontario').",
      });
      send({ type: "done" });
      clearInterval(heartbeat);
      return res.end();
    }

    const { state } = location;

    send({
      type: "status",
      message: `Great! I'll search for modular home builders across ${state} and neighboring states. This might take 5-10 minutes...`,
    });

    const startTime = Date.now();
    send({
      type: "phase",
      phase: "discovery",
      message: `Starting web search across ${state}...`,
    });

    const companies = await discoverCompanies(client, state, send);

    if (companies.length === 0) {
      send({
        type: "error",
        message: `No modular home builders found in ${state}. Try a different state or province.`,
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
      state,
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
