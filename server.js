import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a modular home builder research assistant. When given a location query, search the web thoroughly to find modular, manufactured, prefab, tiny, panelized, and commercial modular home builders in that area.

For each company you find, extract:
- Company name
- Website URL (their own site, not directory listings)
- Email address (only if found on their website - never guess)
- Phone number (only if found)
- Specialties (from: Modular Homes, Manufactured Homes, Tiny Homes, Prefab Homes, Panelized/Kit, Commercial Modular)

After searching, compile your findings into a markdown table with columns: Company | Website | Email | Phone | Specialties

Search multiple queries to be thorough (e.g. "modular home builders [city]", "manufactured homes [city]", "prefab builders near [city]"). Only include real companies, not directories like Yelp or BBB.`;

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ type: 'status', message: `Searching for modular home builders: "${query}"...` });

    let messages = [
      { role: 'user', content: `Find all modular home builders in or near: ${query}` }
    ];

    let turnCount = 0;
    const maxTurns = 10;

    // Multi-turn loop to handle web search tool calls
    while (turnCount < maxTurns) {
      turnCount++;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          }
        ],
        messages,
      });

      // Collect text from this turn and stream it
      let turnText = '';
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          turnText += block.text;
        }
        if (block.type === 'web_search_tool_result') {
          const searchQuery = block.content?.find(c => c.type === 'web_search_query');
          if (searchQuery) {
            send({ type: 'search', message: `Searching: "${searchQuery.query}"` });
          }
        }
      }

      if (turnText) {
        send({ type: 'text', text: turnText });
      }

      // If stop_reason is 'end_turn', we're done
      if (response.stop_reason === 'end_turn') {
        break;
      }

      // If stop_reason is 'tool_use', continue the conversation
      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        // Server-side tools are handled automatically by the API,
        // but we need to continue the conversation
        messages.push({
          role: 'user',
          content: 'Continue searching and compile all results.'
        });
        send({ type: 'status', message: `Searching... (pass ${turnCount})` });
      } else {
        break;
      }
    }

    send({ type: 'done' });
  } catch (error) {
    console.error('Search error:', error);
    send({ type: 'error', message: error.message });
  }

  res.end();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasApiKey: !!process.env.ANTHROPIC_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API Key: ${process.env.ANTHROPIC_API_KEY ? 'Set' : 'Missing (set ANTHROPIC_API_KEY)'}`);
});
