import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const FEED_URL = 'https://medium.com/feed/@jackgreencrypto';
const RSS_API = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(FEED_URL);
const CACHE_KEY = 'medium-articles-v4';
const SUMMARY_PREFIX = 'ai3:';
const CACHE_TTL = 60 * 60;

/**
 * Model fallback chain — uses aliases that auto-update when Anthropic
 * releases new versions. No hardcoded date-stamped model IDs.
 * If the first model 404s, tries the next one down the list.
 */
const MODEL_CHAIN = [
  'claude-sonnet-4-latest',     // alias → always points to newest Sonnet 4.x
  'claude-3-5-sonnet-latest',   // fallback alias → Sonnet 3.5
  'claude-sonnet-4-20250514',   // pinned version that works today as last resort
];

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateReadTime(html) {
  const text = stripHtml(html);
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(1, Math.round(words / 238));
}

function extractImg(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)/);
  return m ? m[1].replace(/^\/\//, 'https://') : '';
}

/**
 * Call Anthropic Messages API with automatic model fallback.
 * Tries each model in MODEL_CHAIN until one succeeds.
 */
async function callClaude(prompt) {
  let lastError = null;

  for (const model of MODEL_CHAIN) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      return data.content[0].text.trim();
    }

    const errBody = await resp.text();

    // Only retry on 404 (model not found) — any other error (auth, rate limit, etc.) should fail fast
    if (resp.status !== 404) {
      throw new Error('Anthropic API ' + resp.status + ': ' + errBody);
    }

    lastError = 'Model ' + model + ' not found';
    console.warn(lastError + ', trying next...');
  }

  throw new Error('All models failed. Last: ' + lastError);
}

/**
 * Generate a 2-3 sentence summary using Claude
 */
async function generateSummary(title, content) {
  const text = stripHtml(content).substring(0, 3000);
  return callClaude(
    'Summarize this article in exactly 2-3 concise sentences (max 200 characters total). Be specific about the key insight or thesis. No filler, no "this article discusses". Write as if for a financial professional.\n\nTitle: ' + title + '\n\nContent: ' + text
  );
}

async function getArticlesWithSummaries(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await redis.get(CACHE_KEY);
    if (cached) return cached;
  }

  const res = await fetch(RSS_API);
  if (!res.ok) throw new Error('RSS fetch failed');
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'RSS error');

  const articles = [];

  for (const item of data.items) {
    const articleId = Buffer.from(item.link).toString('base64').substring(0, 40);
    const summaryKey = SUMMARY_PREFIX + articleId;

    let summary = forceRefresh ? null : await redis.get(summaryKey);

    if (!summary) {
      try {
        summary = await generateSummary(item.title, item.description || item.content || '');
        await redis.set(summaryKey, summary);
      } catch (err) {
        console.error('Summary failed [' + item.title + ']:', err.message);
        // Fallback: extract first 2 sentences from content
        const text = stripHtml(item.description || '');
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
        summary = sentences.slice(0, 2).join(' ').substring(0, 200).trim() || '';
      }
    }

    const content = item.description || item.content || '';

    articles.push({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      image: extractImg(content),
      readTime: estimateReadTime(content),
      summary: summary,
      author: {
        name: 'Jack',
        avatar: 'https://www.blockphi.com/images/Jack.jpg'
      }
    });
  }

  await redis.set(CACHE_KEY, articles, { ex: CACHE_TTL });
  return articles;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const forceRefresh = req.query.refresh === '1';
    const articles = await getArticlesWithSummaries(forceRefresh);
    return res.status(200).json({ status: 'ok', items: articles });
  } catch (err) {
    console.error('API error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
