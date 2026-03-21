import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Anthropic } from '@anthropic-ai/sdk';
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
app.post('/api/search', async (req, res) => {
  const { query } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Find modular home builders matching: "${query}". Search across 6 types: modular, manufactured, prefab, tiny, panelized, commercial. Return CSV format: Company|Website|Email|Phone|Specialties`
        }
      ]
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
