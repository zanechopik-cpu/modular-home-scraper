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

// Retry wrapper — retries on transient errors with exponential backoff
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxRetries;
      const isTransient =
        err.status === 429 ||
        err.status === 500 ||
        err.status === 502 ||
        err.status === 503 ||
        err.message?.includes("ECONNRESET") ||
        err.message?.includes("ETIMEDOUT");
      if (isLast || !isTransient) throw err;
      const delay = 3000 * Math.pow(2, attempt); // 3s, 6s, 12s
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
      model: "claude-sonnet-4-6",
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
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `List ALL cities and towns in ${state} where modular or manufactured home builders/dealers might operate. Include:
- Every city with population over 20,000
- Every county seat
- Major suburban areas and metro satellite cities
- Known manufactured housing market areas

Be comprehensive — I need to search EVERY possible area. For a large state like Texas or Florida this could be 80-120+ cities. For smaller states it might be 20-40.

Reply with ONLY a JSON array of city names: ["City1", "City2", ...]
No state abbreviations, just city names.`,
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
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 10,
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
    return `Search the web for: ${query}

Find ALL modular/manufactured/prefab/tiny/panelized home builders, dealers, retailers, sales centers, resellers, and companies in ${locationDesc}. Include builders, manufacturers, dealers, retailers, sales lots, and anyone who sells or builds these homes. Extract EVERY company mentioned anywhere in the search results.

For each company, extract:
- Company name (the actual business name)
- Website URL (the company's own website, NOT directory listings like Yelp/BBB)

Reply with ONLY a JSON array: [{"name": "Company Name", "website": "https://..."}]

IMPORTANT: Include EVERY single company you see in the results. Do not filter or limit. Even if a company seems small or you're unsure, include it.`;
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
    `modular home companies ${state} directory`,
    `manufactured housing dealers ${state}`,
    `tiny home builders ${state}`,
    `"modular homes" "${state}" builders list`,
    `"manufactured homes" "${state}" dealers directory`,
    `panelized home builders ${state}`,
    `modular construction companies ${state}`,
    `factory built homes ${state} dealers`,
    `HUD homes dealers ${state}`,
    `manufactured home sales centers ${state}`,
    `mobile home dealers ${state}`,
    `modular home retailers ${state}`,
    `manufactured home sales lots ${state}`,
    `mobile home sales ${state} dealers`,
    `used manufactured homes dealers ${state}`,
    `double wide mobile home dealers ${state}`,
    `single wide manufactured home retailers ${state}`,
  ];

  if (isCanadian) {
    stateQueries.push(
      `modular home builders ${state} Canada list`,
      `prefabricated homes ${state} Canada companies`,
      `manufactured homes ${state} Canada directory`,
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
    `site:modularhomes.com ${state}`,
    `site:manufacturedhomes.com ${state}`,
    `site:modularhomeowners.com ${state}`,
    `site:prefabreviews.com ${state}`,
    `"modular home" builders ${state} site:houzz.com`,
    `manufactured home dealers ${state} site:mhvillage.com`,
    `${state} manufactured housing association members`,
    `${state} modular building institute members`,
    `${state} home builders association modular`,
    `MHI manufactured housing ${state} members`,
    `modular home builders ${state} site:buildzoom.com`,
    `manufactured homes ${state} site:homeadvisor.com`,
    `manufactured home retailers ${state} site:mhvillage.com`,
    `mobile home dealers ${state} site:mhvillage.com`,
    `manufactured home sales ${state} site:yellowpages.com`,
    `mobile home dealers ${state} site:mapquest.com`,
    `"manufactured home" OR "mobile home" dealer ${state} site:bbb.org`,
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
    `Clayton Homes dealers ${state}`,
    `Champion Homes dealers ${state}`,
    `Cavco homes dealers ${state}`,
    `Skyline Champion dealers ${state}`,
    `Palm Harbor Homes dealers ${state}`,
    `Fleetwood Homes dealers ${state}`,
    `Adventure Homes dealers ${state}`,
    `Sunshine Homes dealers ${state}`,
    `Jacobsen Homes dealers ${state}`,
    `Commodore Homes dealers ${state}`,
    `Redman Homes dealers ${state}`,
    `Nobility Homes dealers ${state}`,
    `Franklin Homes dealers ${state}`,
    `TRU Homes dealers ${state}`,
    `Deer Valley Homebuilders dealers ${state}`,
    `manufactured home retailers ${state}`,
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
    (c, s) => `prefab home builders near ${c} ${s}`,
    (c, s) => `tiny home builders ${c} ${s}`,
    (c, s) => `mobile home dealers ${c} ${s}`,
    (c, s) => `manufactured home sales center ${c} ${s}`,
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
    `"modular home" OR "manufactured home" OR "prefab home" builders ${state} -site:yelp.com -site:facebook.com`,
    `"modular homes" "${state}" "contact us"`,
    `"manufactured housing" companies ${state} list`,
    `modular home builders ${state} reviews`,
    `new manufactured homes for sale ${state} dealers`,
    `custom modular homes ${state} builders`,
    `commercial modular buildings ${state}`,
    `modular home builders ${state} BBB accredited`,
    `"modular home" "${state}" site:google.com/maps`,
    `factory built housing ${state} retailers directory`,
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
    `manufactured home retailers ${state} complete list`,
    `mobile home dealers ${state} directory`,
    `manufactured home sales centers ${state}`,
    `"mobile home" OR "manufactured home" "sales center" ${state}`,
    `modular home sales ${state} showroom`,
    `manufactured home lot sales ${state}`,
    `mobile home resellers ${state}`,
    `manufactured home superstore ${state}`,
    `"homes for sale" manufactured dealer ${state}`,
    `repo manufactured homes dealers ${state}`,
    `affordable manufactured homes retailers ${state}`,
    `modular home display center ${state}`,
    `manufactured home communities sales ${state}`,
    `mobile home parks with sales office ${state}`,
    `land home packages ${state} manufactured`,
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
// CONTACT SCRAPING (3-phase per company)
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

async function crawlWebsite(client, company, domain) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
      messages: [
        {
          role: "user",
          content: `You are a thorough web scraper. Find the email address and phone number for this company by searching their website.

Company: ${company.name}
Website: ${company.website}
Domain: ${domain}

Perform ALL of these searches — do NOT skip any or stop early:
1. site:${domain} contact
2. site:${domain} email
3. site:${domain} phone
4. site:${domain} about
5. "${company.website}/contact"
6. "${company.website}/contact-us"
7. "${company.website}/about"
8. "${company.website}/about-us"
9. "${company.website}/get-in-touch"
10. site:${domain} "@"

Read ALL snippets for email addresses (@) and phone numbers.

Reply with ONLY valid JSON:
{
  "name": "Official company name",
  "website": "${company.website}",
  "email": "email or null",
  "salesEmail": "sales email or null",
  "phone": "phone or null",
  "specialties": ["from: Manufactured Homes, Modular Homes, Tiny Homes, Multifamily Modular, Commercial Modular, Panelized/Kit Builders"],
  "sourceUrl": "URL where found",
  "confidence": "high or low"
}

ONLY report emails/phones you actually SEE. Never guess. Complete ALL 10 searches.`,
        },
      ],
    })
  );
  return extractText(resp);
}

async function searchDirectories(client, company, domain, state) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
      messages: [
        {
          role: "user",
          content: `Search EXTERNAL sources for this company's email and phone number.

Company: ${company.name}
Website: ${company.website}
Domain: ${domain}
State: ${state}

Perform ALL searches:
1. "${company.name}" email phone
2. "${company.name}" ${state} contact information
3. "${domain}" email
4. "${company.name}" site:facebook.com
5. "${company.name}" site:yelp.com
6. "${company.name}" site:bbb.org
7. "${company.name}" ${state} reviews contact
8. "${company.name}" google maps email phone
9. "${company.name}" "${state}" modular homes email
10. "${domain}" "@" contact

Reply with ONLY valid JSON:
{
  "name": "Company name",
  "website": "${company.website}",
  "email": "email or null",
  "salesEmail": "sales email or null",
  "phone": "phone or null",
  "specialties": ["from: Manufactured Homes, Modular Homes, Tiny Homes, Multifamily Modular, Commercial Modular, Panelized/Kit Builders"],
  "sourceUrl": "URL where found",
  "confidence": "high or low"
}

ONLY report what you actually SEE. Never guess. Complete ALL 10 searches.`,
        },
      ],
    })
  );
  return extractText(resp);
}

async function deepContactHunt(client, company, domain, state) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [
        {
          role: "user",
          content: `I already searched the company's website AND directories but could NOT find email/phone. Try CREATIVE alternative strategies.

Company: ${company.name}
Website: ${company.website}
Domain: ${domain}
State: ${state}

Try ALL of these:
1. "${company.name}" email -site:${domain}
2. "${company.name}" "@${domain}"
3. "${company.name}" phone number
4. "${company.name}" contact us email modular
5. inurl:${domain} email OR phone OR contact
6. "${company.name}" owner email ${state}
7. ${domain} whois email contact
8. "${company.name}" linkedin email modular homes

Reply with ONLY valid JSON:
{"email": "email or null", "salesEmail": "sales email or null", "phone": "phone or null", "sourceUrl": "where found"}

ONLY report what you actually find. Try ALL 8 searches.`,
        },
      ],
    })
  );
  return extractText(resp);
}

function mergeData(primary, secondary) {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    name: primary.name || secondary.name,
    website: primary.website || secondary.website,
    email: primary.email || secondary.email || null,
    salesEmail: primary.salesEmail || secondary.salesEmail || null,
    phone: primary.phone || secondary.phone || null,
    specialties:
      primary.specialties?.length > 0
        ? primary.specialties
        : secondary.specialties || [],
    sourceUrl: (primary.email ? primary.sourceUrl : secondary.sourceUrl) || "",
    confidence: primary.confidence || secondary.confidence || "low",
  };
}

async function scrapeCompany(client, company, state, onPhaseUpdate) {
  let domain = "";
  try {
    domain = new URL(company.website).hostname.replace("www.", "");
  } catch {}

  try {
    onPhaseUpdate(company.name, "Phase 1/3: Crawling website...");
    const phase1Text = await crawlWebsite(client, company, domain);
    const phase1Data = parseScrapedData(phase1Text);

    onPhaseUpdate(company.name, "Phase 2/3: Searching directories...");
    const phase2Text = await searchDirectories(client, company, domain, state);
    const phase2Data = parseScrapedData(phase2Text);

    let merged = mergeData(phase1Data, phase2Data);

    if (!merged || !merged.email || !merged.phone) {
      onPhaseUpdate(company.name, "Phase 3/3: Deep contact hunt...");
      const phase3Text = await deepContactHunt(client, company, domain, state);
      const phase3Data = parseScrapedData(phase3Text);

      if (phase3Data) {
        merged = merged || {};
        merged.email = merged.email || phase3Data.email || null;
        merged.salesEmail = merged.salesEmail || phase3Data.salesEmail || null;
        merged.phone = merged.phone || phase3Data.phone || null;
        if (phase3Data.sourceUrl && !merged.sourceUrl) {
          merged.sourceUrl = phase3Data.sourceUrl;
        }
      }
    }

    return {
      name: merged?.name || company.name,
      website: company.website,
      email: merged?.email || null,
      salesEmail: merged?.salesEmail || null,
      phone: merged?.phone || null,
      specialties: merged?.specialties || [],
      sourceUrl: merged?.sourceUrl || "",
      confidence:
        merged?.email && merged?.phone
          ? "high"
          : merged?.email || merged?.phone
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
        ? `Starting exhaustive statewide search for ALL modular/manufactured home companies in ${state}. This will search every city, every directory, and every manufacturer dealer network. This may take 1-3 hours for comprehensive results.`
        : `Searching for modular home builders in ${city}, ${state}. This does a thorough deep scrape — please be patient.`,
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
      message: `PHASE 2: CONTACT SCRAPING — Deep-scraping ${companies.length} companies one by one (3 phases each)...`,
    });

    const results = [];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];

      const onPhaseUpdate = (name, phase) => {
        send({
          type: "scrape_progress",
          message: `[${i + 1}/${companies.length}] ${name} — ${phase}`,
          current: i + 1,
          total: companies.length,
          percent: Math.round(((i + 0.5) / companies.length) * 100),
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
