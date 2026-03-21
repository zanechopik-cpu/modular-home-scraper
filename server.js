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

// Parse location from user message using Claude
async function parseLocation(client, message) {
  const resp = await client.messages.create({
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
  });
  const text = resp.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { understood: false, reason: "Could not parse response" };
  return JSON.parse(jsonMatch[0]);
}

// Search for companies using Claude with web search
async function searchCompanies(client, city, state, onProgress) {
  // Detect if Canadian province for adapted queries
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
  ];

  // Add Canada-specific queries
  if (isCanadian) {
    searchQueries.push(
      `modular home builders ${state} Canada`,
      `prefabricated homes ${city} ${state} Canada`,
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
      const resp = await client.messages.create({
        model: "claude-sonnet-4-6",
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
            content: `Search the web for: ${query}

Find ALL modular/manufactured/prefab/tiny home builders and dealers in or near ${city}, ${state}. For each company found, extract:
- Company name
- Website URL (the company's own website, not a directory listing)

Reply with ONLY a JSON array of objects: [{"name": "Company Name", "website": "https://..."}]
Include every company you can find. Do not include directory/listing sites themselves (like Yelp, BBB, etc) - only actual companies.`,
          },
        ],
      });

      // Extract text from response
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
              // Normalize URL
              let url = company.website.trim();
              if (!url.startsWith("http")) url = "https://" + url;
              // Deduplicate by domain
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
function parseScrapedData(text, company) {
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
  const resp = await client.messages.create({
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
        content: `You are a web scraper. Your job is to thoroughly search through a company's website to find their contact information (email and phone number).

Company: ${company.name}
Website: ${company.website}
Domain: ${domain}

You MUST search ALL of these pages on their website. Perform a separate search for EACH one:

1. Search: site:${domain} contact
2. Search: site:${domain} email
3. Search: site:${domain} phone
4. Search: site:${domain} about
5. Search: "${company.website}/contact"
6. Search: "${company.website}/contact-us"
7. Search: "${company.website}/about"
8. Search: "${company.website}/about-us"
9. Search: "${company.website}/get-in-touch"
10. Search: site:${domain} "footer" OR "@" OR "email us"

For EACH search, carefully read through ALL the text in every search result snippet. Look for:
- Email addresses (contain @ symbol) — e.g., info@company.com, sales@company.com
- Phone numbers — e.g., (555) 123-4567, 555-123-4567, 1-800-555-1234
- Look in page titles, descriptions, snippets, URLs — everywhere

After completing all searches, reply with ONLY valid JSON:
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
- If a search returns no results, move on to the next one.
- Do NOT stop searching early — go through ALL the searches listed above.`,
      },
    ],
  });
  return extractText(resp);
}

// Phase 2: Search external directories, Google Business, social media for contact info
async function searchDirectories(client, company, domain, city, state) {
  const resp = await client.messages.create({
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
        content: `I could not find complete contact info on the company's website. Now search EXTERNAL sources.

Company: ${company.name}
Website: ${company.website}
Location: ${city}, ${state}

Search these external sources for their email and phone number:

1. Search: "${company.name}" "${city}" email phone
2. Search: "${company.name}" ${state} contact information
3. Search: "${domain}" email
4. Search: "${company.name}" site:facebook.com OR site:yelp.com OR site:bbb.org
5. Search: "${company.name}" ${city} ${state} reviews contact
6. Search: "${company.name}" google maps email phone
7. Search: "${company.name}" "${state}" modular homes email
8. Search: "${domain}" "@"

External sources that often have contact info:
- Google Maps / Google Business Profile
- Facebook business pages (often show email + phone in the About section)
- Yelp business listings
- Better Business Bureau (BBB)
- Houzz, HomeAdvisor, Angi
- State business registries
- Industry directories (modularhomes.com, manufacturedhomes.com)
- Yellow Pages, Manta, Superpages

Read ALL search result snippets carefully for email addresses and phone numbers.

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
- If you find a phone but no email, still report the phone.`,
      },
    ],
  });
  return extractText(resp);
}

// Scrape a single company — two-phase: crawl website, then search directories
async function scrapeCompany(client, company, city, state) {
  let domain = "";
  try {
    domain = new URL(company.website).hostname.replace("www.", "");
  } catch {}

  try {
    // Phase 1: Crawl the company's own website
    const phase1Text = await crawlWebsite(client, company, domain);
    const phase1Data = parseScrapedData(phase1Text, company);

    // If Phase 1 found both email and phone, we're done
    if (phase1Data && phase1Data.email && phase1Data.phone) {
      return { ...phase1Data, status: "success" };
    }

    // Phase 2: Search external directories for missing info
    const phase2Text = await searchDirectories(client, company, domain, city, state);
    const phase2Data = parseScrapedData(phase2Text, company);

    // Merge: prefer phase1 data, fill gaps with phase2
    const merged = {
      name: (phase1Data && phase1Data.name) || (phase2Data && phase2Data.name) || company.name,
      website: company.website,
      email: (phase1Data && phase1Data.email) || (phase2Data && phase2Data.email) || null,
      salesEmail: (phase1Data && phase1Data.salesEmail) || (phase2Data && phase2Data.salesEmail) || null,
      phone: (phase1Data && phase1Data.phone) || (phase2Data && phase2Data.phone) || null,
      specialties: (phase1Data && phase1Data.specialties && phase1Data.specialties.length > 0)
        ? phase1Data.specialties
        : (phase2Data && phase2Data.specialties) || [],
      sourceUrl: (phase1Data && phase1Data.email && phase1Data.sourceUrl)
        || (phase2Data && phase2Data.sourceUrl) || "",
      confidence: (phase1Data && phase1Data.email && phase1Data.phone) ? "high"
        : ((phase1Data && phase1Data.email) || (phase2Data && phase2Data.email)) ? "medium"
        : "low",
      status: "success",
    };

    return merged;
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

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

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
      return res.end();
    }

    const { city, state } = location;
    send({
      type: "status",
      message: `Great! I'll search for modular home builders in ${city}, ${state}. This will do a deep scrape of every website — might take 10-15 minutes for thorough results...`,
    });

    // Step 2: Search for companies
    const startTime = Date.now();
    send({
      type: "phase",
      phase: "search",
      message: `Starting web search for modular home builders in ${city}, ${state}...`,
    });

    const companies = await searchCompanies(client, city, state, send);

    if (companies.length === 0) {
      send({
        type: "error",
        message: `No modular home builders found in ${city}, ${state}. Try a larger nearby city or check the spelling.`,
      });
      send({ type: "done" });
      return res.end();
    }

    send({
      type: "search_complete",
      message: `Found ${companies.length} companies! Now scraping their websites for contact information...`,
      count: companies.length,
    });

    // Step 3: Scrape each company
    send({
      type: "phase",
      phase: "scrape",
      message: `Scraping ${companies.length} company websites...`,
    });

    const results = [];
    const batchSize = 2; // Process 2 at a time (each does 2-phase deep scrape)

    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((company) => scrapeCompany(client, company, city, state))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const idx = i + j;
        results.push(batchResults[j]);
        const status = batchResults[j].status === "success" ? "✓" : "⚠";
        send({
          type: "scrape_progress",
          message: `[${idx + 1}/${companies.length}] ${batchResults[j].name || companies[idx].name} ${status}`,
          current: idx + 1,
          total: companies.length,
          percent: Math.round(((idx + 1) / companies.length) * 100),
        });
      }
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
