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
        content: `Extract the city and state/province from this message. If the user is asking about modular/manufactured/prefab/tiny homes, extract the location. Reply with ONLY valid JSON: {"city": "...", "state": "...", "understood": true} or {"understood": false, "reason": "..."} if you can't understand the request.\n\nMessage: "${message}"`,
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
  const searchQueries = [
    `modular home builders ${city} ${state}`,
    `manufactured home dealers ${city} ${state}`,
    `prefab home builders ${city} ${state}`,
    `tiny home builders ${city} ${state}`,
    `panelized home builders ${city} ${state}`,
    `modular home companies near ${city} ${state}`,
  ];

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

// Scrape a single company website for contact info
async function scrapeCompany(client, company) {
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
        },
      ],
      messages: [
        {
          role: "user",
          content: `Visit this company's website and extract contact information: ${company.website}

Company name: ${company.name}

Search for their contact page, about page, and home page. Extract ONLY information that is ACTUALLY VISIBLE on their website. Do NOT guess or invent any information.

Reply with ONLY valid JSON:
{
  "name": "Official company name as shown on website",
  "website": "${company.website}",
  "email": "email if found on website, or null",
  "salesEmail": "sales-specific email if different and found, or null",
  "phone": "phone number if found on website, or null",
  "specialties": ["list of home types they build - only from: Manufactured Homes, Modular Homes, Tiny Homes, Multifamily Modular, Commercial Modular, Panelized/Kit Builders"],
  "sourceUrl": "the specific page URL where you found the contact info",
  "confidence": "high or low"
}

CRITICAL: If you cannot find an email, set it to null. NEVER guess email formats. Only include specialties explicitly mentioned on the website.`,
        },
      ],
    });

    let text = "";
    for (const block of resp.content) {
      if (block.type === "text") {
        text += block.text;
      }
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      // Validate email format if present
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        data.email = null;
      }
      if (
        data.salesEmail &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.salesEmail)
      ) {
        data.salesEmail = null;
      }
      return { ...data, status: "success" };
    }
    return { ...company, status: "parse_error", email: null, phone: null, specialties: [], confidence: "low" };
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
      message: `Great! I'll search for modular home builders in ${city}, ${state}. This might take 5-7 minutes...`,
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
    const batchSize = 3; // Process 3 at a time for speed

    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((company) => scrapeCompany(client, company))
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

app.listen(PORT, () => {
  console.log(`\n🏠 Modular Home Builder Finder`);
  console.log(`   Running at http://localhost:${PORT}`);
  console.log(
    `   API Key: ${process.env.ANTHROPIC_API_KEY ? "✓ Set" : "✗ Missing (set ANTHROPIC_API_KEY)"}`
  );
  console.log("");
});
