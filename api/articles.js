import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';

const redis = Redis.fromEnv();
const anthropic = new Anthropic();

const FEED_URL = 'https://medium.com/feed/@jackgreencrypto';
const RSS_API = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(FEED_URL);
const CACHE_KEY = 'medium-articles-v2';
const SUMMARY_PREFIX = 'ai-summary:'; // v2 prefix to invalidate old fallback summaries
const CACHE_TTL = 60 * 60; // 1 hour — RSS check frequency

/**
 * Strip HTML tags → plain text
 */
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

/**
 * Estimate read time (words / 238 wpm)
 */
function estimateReadTime(html) {
  const text = stripHtml(html);
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(1, Math.round(words / 238));
}

/**
 * Extract first image from HTML
 */
function extractImg(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)/);
  return m ? m[1].replace(/^\/\//, 'https://') : '';
}

/**
 * Generate a 2-3 sentence summary using Claude
 */
async function generateSummary(title, content) {
  const text = stripHtml(content).substring(0, 3000); // limit context

  const message = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 150,
    messages: [
      {
        role: 'user',
        content: `Summarize this article in exactly 2-3 concise sentences (max 200 characters total). Be specific about the key insight or thesis. No filler, no "this article discusses". Write as if for a financial professional.\n\nTitle: ${title}\n\nContent: ${text}`
      }
    ]
  });

  return message.content[0].text.trim();
}

/**
 * Process all articles: fetch RSS, generate summaries for new ones, cache everything
 */
async function getArticlesWithSummaries(forceRefresh = false) {
  // Check cache first (skip if force refresh)
  if (!forceRefresh) {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      return cached;
    }
  }

  // Fetch RSS feed
  const res = await fetch(RSS_API);
  if (!res.ok) throw new Error('RSS fetch failed');
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || 'RSS error');

  const articles = [];

  for (const item of data.items) {
    const articleId = Buffer.from(item.link).toString('base64').substring(0, 40);
    const summaryKey = `${SUMMARY_PREFIX}${articleId}`;

    // Check if we already have an AI summary cached for this specific article
    let summary = forceRefresh ? null : await redis.get(summaryKey);

    if (!summary) {
      // Generate new summary with Claude
      try {
        summary = await generateSummary(item.title, item.description || item.content || '');
        // Cache individual summary permanently (it never changes)
        await redis.set(summaryKey, summary);
      } catch (err) {
        console.error('Summary generation failed for:', item.title, err.message);
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

  // Cache the full response for 1 hour (so we don't re-fetch RSS constantly)
  await redis.set(CACHE_KEY, articles, { ex: CACHE_TTL });

  return articles;
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const forceRefresh = req.query.refresh === '1';
    const articles = await getArticlesWithSummaries(forceRefresh);
    return res.status(200).json({
      status: 'ok',
      items: articles
    });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch articles'
    });
  }
}
