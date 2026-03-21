const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Validate API key exists
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }
  return new Anthropic();
}

// Retry wrapper for API calls — retries on transient errors
async function withRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxRetries;
      const isTransient = err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.message?.includes("ECONNRESET");
      if (isLast || !isTransient) throw err;
      // Exponential backoff: 3s, 6s
      const delay = 3000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Parse location from user message using Claude
async function parseLocation(client, message) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Extract the city and state/province from this message. The user is looking for modular/manufactured/prefab/tiny home builders. This works for ALL 50 US states AND all 13 Canadian provinces/territories.

For US locations, use the full state name (e.g., "California" not "CA").
For Canadian locations, use the full province name (e.g., "Ontario" not "ON", "British Columbia" not "BC").

Reply with ONLY valid JSON: {"city": "...", "state": "...", "understood": true} or {"understood": false, "reason": "..."} if you can't understand the request.

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

// Search for companies using Claude with web search
async function searchCompanies(client, city, state, onProgress) {
  const canadianProvinces = [
    "Alberta", "British Columbia", "Manitoba", "New Brunswick",
    "Newfoundland and Labrador", "Nova Scotia", "Ontario", "Prince Edward Island",
    "Quebec", "Saskatchewan", "Northwest Territories", "Nunavut", "Yukon",
  ];
  const isCanadian = canadianProvinces.some(
    (p) => state.toLowerCase() === p.toLowerCase()
  );

  const searchQueries = [
    `modular home builders ${city} ${state}`,
    `manufactured home dealers ${city} ${state}`,
    `prefab home builders ${city} ${state}`,
    `tiny home builders ${city} ${state}`,
    `panelized home builders ${city} ${state}`,
    `modular home companies near ${city} ${state}`,
    `"modular homes" OR "prefab homes" "${city}" "${state}" contact`,
    `manufactured home dealers near ${city} ${state}`,
    `custom modular homes ${city} ${state}`,
  ];

  if (isCanadian) {
    searchQueries.push(
      `modular home builders ${state} Canada`,
      `prefabricated homes ${city} ${state} Canada`,
      `manufactured homes ${state} Canada dealers`,
    );
  }

  const allCompanies = new Map();
  let searchCount = 0;

  for (const query of searchQueries) {
    searchCount++;
    onProgress({
      type: "search_progress",
      message: `Searching (${searchCount}/${searchQueries.length}): "${query}"...`,
      count: allCompanies.size,
    });

    try {
      const resp = await withRetry(() =>
        client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 7,
            },
          ],
          messages: [
            {
              role: "user",
              content: `Search the web for: ${query}

Find ALL modular/manufactured/prefab/tiny home builders and dealers in or near ${city}, ${state}. For each company found, extract:
- Company name
- Website URL (the company's own website, not a directory listing)

Reply with ONLY a JSON array of objects: [{"name": "Company Name", "website": "https://..."}]
Include every company you can find. Do not include directory/listing sites themselves (like Yelp, BBB, etc) - only actual companies.`,
            },
          ],
        })
      );

      let text = "";
      for (const block of resp.content) {
        if (block.type === "text") {
          text += block.text;
        }
      }

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const companies = JSON.parse(jsonMatch[0]);
          for (const company of companies) {
            if (company.name && company.website) {
              let url = company.website.trim();
              if (!url.startsWith("http")) url = "https://" + url;
              try {
                const domain = new URL(url).hostname.replace("www.", "");
                if (!allCompanies.has(domain)) {
                  allCompanies.set(domain, {
                    name: company.name.trim(),
                    website: url,
                  });
                }
              } catch {
                // Skip invalid URLs
              }
            }
          }
        } catch {
          // JSON parse failed, continue
        }
      }
    } catch (err) {
      onProgress({
        type: "search_error",
        message: `Search query failed: ${query} (${err.message}). Continuing...`,
      });
    }
  }

  return Array.from(allCompanies.values());
}

// Helper to extract and validate scraped data from Claude's response
function parseScrapedData(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const data = JSON.parse(jsonMatch[0]);
    // Validate email format
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      data.email = null;
    }
    if (data.salesEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.salesEmail)) {
      data.salesEmail = null;
    }
    // Validate phone number (must have 7-15 digits)
    if (data.phone) {
      const digits = data.phone.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) {
        data.phone = null;
      }
    }
    return data;
  } catch {
    return null;
  }
}

// Extract text blocks from Claude response
function extractText(resp) {
  let text = "";
  for (const block of resp.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

// Phase 1: Crawl the company's own website pages thoroughly
async function crawlWebsite(client, company, domain) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
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
          content: `You are a thorough web scraper. Your ONLY job is to find the email address and phone number for this company by searching through their website.

Company: ${company.name}
Website: ${company.website}
Domain: ${domain}

You MUST perform ALL of these searches. Do every single one — do NOT skip any or stop early:

1. Search: site:${domain} contact
2. Search: site:${domain} email
3. Search: site:${domain} phone
4. Search: site:${domain} about
5. Search: "${company.website}/contact"
6. Search: "${company.website}/contact-us"
7. Search: "${company.website}/about"
8. Search: "${company.website}/about-us"
9. Search: "${company.website}/get-in-touch"
10. Search: site:${domain} "@"

For EACH search result, carefully read through ALL the text in every snippet. Look for:
- Email addresses (contain @ symbol) — e.g., info@company.com, sales@company.com
- Phone numbers — e.g., (555) 123-4567, 555-123-4567, 1-800-555-1234
- Look in page titles, descriptions, snippets, URLs — everywhere

After completing ALL searches, reply with ONLY valid JSON:
{
  "name": "Official company name as shown on their website",
  "website": "${company.website}",
  "email": "email found or null",
  "salesEmail": "sales-specific email if different, or null",
  "phone": "phone number found or null",
  "specialties": ["from: Manufactured Homes, Modular Homes, Tiny Homes, Multifamily Modular, Commercial Modular, Panelized/Kit Builders"],
  "sourceUrl": "URL where contact info was found",
  "confidence": "high or low",
  "pagesSearched": 0
}

RULES:
- ONLY report emails/phones you actually SEE in the search results. Never guess or fabricate.
- Set pagesSearched to the number of searches you actually performed.
- Do NOT stop searching early — complete ALL 10 searches even if you find something early. You may find a better email on a later page.`,
        },
      ],
    })
  );
  return extractText(resp);
}

// Phase 2: Search external directories, Google Business, social media for contact info
async function searchDirectories(client, company, domain, city, state) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
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
          content: `You are a thorough web scraper. Search EXTERNAL sources to find the email address and phone number for this company.

Company: ${company.name}
Website: ${company.website}
Domain: ${domain}
Location: ${city}, ${state}

Perform ALL of these searches — do NOT skip any:

1. Search: "${company.name}" "${city}" email phone
2. Search: "${company.name}" ${state} contact information
3. Search: "${domain}" email
4. Search: "${company.name}" site:facebook.com
5. Search: "${company.name}" site:yelp.com
6. Search: "${company.name}" site:bbb.org
7. Search: "${company.name}" ${city} ${state} reviews contact
8. Search: "${company.name}" google maps email phone
9. Search: "${company.name}" "${state}" modular homes email
10. Search: "${domain}" "@" contact

External sources that often list email and phone:
- Google Maps / Google Business Profile — often has email + phone in the sidebar
- Facebook business pages — check the About section
- Yelp business listings — check the business info sidebar
- Better Business Bureau (BBB) — shows contact details
- Houzz, HomeAdvisor, Angi — contractor profiles with contact info
- Yellow Pages, Manta, Superpages — business directories
- Industry directories (modularhomes.com, manufacturedhomes.com)

Read ALL search result snippets carefully for email addresses (@) and phone numbers.

Reply with ONLY valid JSON:
{
  "name": "Official company name",
  "website": "${company.website}",
  "email": "email found or null",
  "salesEmail": "sales-specific email if different, or null",
  "phone": "phone number found or null",
  "specialties": ["from: Manufactured Homes, Modular Homes, Tiny Homes, Multifamily Modular, Commercial Modular, Panelized/Kit Builders"],
  "sourceUrl": "URL where contact info was found",
  "confidence": "high or low"
}

RULES:
- ONLY report emails/phones you actually SEE in search results. Never guess.
- Emails from Facebook pages, Yelp, BBB, Google Business etc. are VALID — report them.
- If you find a phone but no email, still report the phone.
- Do NOT stop early — perform ALL 10 searches.`,
        },
      ],
    })
  );
  return extractText(resp);
}

// Phase 3: Last-resort deep email/phone hunt — tries creative search strategies
async function deepContactHunt(client, company, domain, city, state) {
  const resp = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 8,
        },
      ],
      messages: [
        {
          role: "user",
          content: `IMPORTANT: I have already searched the company's website AND major directories but could NOT find an email or phone for this company. I need you to try CREATIVE and ALTERNATIVE search strategies.

Company: ${company.name}
Website: ${company.website}
Domain: ${domain}
Location: ${city}, ${state}

Try ALL of these alternative searches:

1. Search: "${company.name}" email -site:${domain}
2. Search: "${company.name}" "@${domain}"
3. Search: "${company.name}" "${city}" phone number
4. Search: "${company.name}" contact us email modular
5. Search: inurl:${domain} email OR phone OR contact
6. Search: "${company.name}" owner email ${state}
7. Search: ${domain} whois email contact
8. Search: "${company.name}" linkedin email modular homes

Think creatively about where this company's contact info might be listed:
- Business registration databases
- LinkedIn company pages or owner profiles
- Industry association member directories
- Trade show exhibitor lists
- Building permit records
- News articles or press releases mentioning the company
- Partnership or dealer network pages on other companies' sites

Reply with ONLY valid JSON:
{
  "email": "email found or null",
  "salesEmail": "sales email or null",
  "phone": "phone found or null",
  "sourceUrl": "where you found it"
}

RULES:
- ONLY report what you actually find. Never fabricate.
- Try ALL 8 searches. Do not stop early.`,
        },
      ],
    })
  );
  return extractText(resp);
}

// Merge two data objects — first takes priority, second fills gaps
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
      (primary.specialties && primary.specialties.length > 0)
        ? primary.specialties
        : secondary.specialties || [],
    sourceUrl: (primary.email ? primary.sourceUrl : secondary.sourceUrl) || "",
    confidence: primary.confidence || secondary.confidence || "low",
  };
}

// Scrape a single company — three-phase: crawl website, search directories, deep hunt
async function scrapeCompany(client, company, city, state, onPhaseUpdate) {
  let domain = "";
  try {
    domain = new URL(company.website).hostname.replace("www.", "");
  } catch {}

  try {
    // Phase 1: Crawl the company's own website
    onPhaseUpdate(company.name, "Crawling website...");
    const phase1Text = await crawlWebsite(client, company, domain);
    const phase1Data = parseScrapedData(phase1Text);

    // Phase 2: Always search external directories to find additional/better data
    onPhaseUpdate(company.name, "Searching directories...");
    const phase2Text = await searchDirectories(client, company, domain, city, state);
    const phase2Data = parseScrapedData(phase2Text);

    // Merge Phase 1 + Phase 2
    let merged = mergeData(phase1Data, phase2Data);

    // Phase 3: If still missing email OR phone, do a deep hunt
    if (!merged || !merged.email || !merged.phone) {
      onPhaseUpdate(company.name, "Deep contact hunt...");
      const phase3Text = await deepContactHunt(client, company, domain, city, state);
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

    // Finalize
    const result = {
      name: (merged && merged.name) || company.name,
      website: company.website,
      email: (merged && merged.email) || null,
      salesEmail: (merged && merged.salesEmail) || null,
      phone: (merged && merged.phone) || null,
      specialties: (merged && merged.specialties) || [],
      sourceUrl: (merged && merged.sourceUrl) || "",
      confidence:
        (merged && merged.email && merged.phone) ? "high"
        : (merged && (merged.email || merged.phone)) ? "medium"
        : "low",
      status: "success",
    };

    return result;
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

// SSE endpoint for search with streaming progress
app.post("/api/search", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required" });
  }

  // Set up SSE with no timeout
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Disable request timeout for long scrapes
  req.setTimeout(0);
  res.setTimeout(0);

  // Keep connection alive with periodic heartbeats
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
          "I couldn't understand that location. Could you try something like 'Find modular home builders in Denver, Colorado'?",
      });
      send({ type: "done" });
      clearInterval(heartbeat);
      return res.end();
    }

    const { city, state } = location;
    send({
      type: "status",
      message: `Searching for modular home builders in ${city}, ${state}. This does a thorough deep scrape of every company — please be patient, it will take a while but the results will be comprehensive.`,
    });

    // Step 2: Search for companies
    const startTime = Date.now();
    send({
      type: "phase",
      phase: "search",
      message: `Phase 1 of 2: Discovering modular home builders in ${city}, ${state}...`,
    });

    const companies = await searchCompanies(client, city, state, send);

    if (companies.length === 0) {
      send({
        type: "error",
        message: `No modular home builders found in ${city}, ${state}. Try a larger nearby city or check the spelling.`,
      });
      send({ type: "done" });
      clearInterval(heartbeat);
      return res.end();
    }

    send({
      type: "search_complete",
      message: `Found ${companies.length} companies! Now deep-scraping each website for contact info (this is the thorough part)...`,
      count: companies.length,
    });

    // Step 3: Scrape each company ONE AT A TIME for maximum reliability
    send({
      type: "phase",
      phase: "scrape",
      message: `Phase 2 of 2: Deep-scraping ${companies.length} company websites one by one...`,
    });

    const results = [];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];

      // Phase update callback for granular progress
      const onPhaseUpdate = (name, phase) => {
        send({
          type: "scrape_progress",
          message: `[${i + 1}/${companies.length}] ${name} — ${phase}`,
          current: i + 1,
          total: companies.length,
          percent: Math.round(((i + 0.5) / companies.length) * 100),
        });
      };

      const result = await scrapeCompany(client, company, city, state, onPhaseUpdate);
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
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const withEmail = results.filter((r) => r.email).length;
    const withPhone = results.filter((r) => r.phone).length;

    const summary = {
      type: "results",
      city,
      state,
      totalCompanies: results.length,
      withEmail,
      withPhone,
      emailPercent: Math.round((withEmail / results.length) * 100),
      phonePercent: Math.round((withPhone / results.length) * 100),
      timeElapsed: `${minutes}m ${seconds}s`,
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

// Health check
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
