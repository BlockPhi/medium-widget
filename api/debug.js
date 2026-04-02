export default async function handler(req, res) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    // Check if key exists (show first/last 4 chars only)
    const keyInfo = apiKey
      ? apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 4)
      : 'NOT SET';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 50,
        messages: [
          { role: 'user', content: 'Say "hello" and nothing else.' }
        ]
      })
    });

    const body = await resp.text();

    return res.status(200).json({
      keyPresent: keyInfo,
      anthropicStatus: resp.status,
      anthropicResponse: body
    });
  } catch (err) {
    return res.status(200).json({
      error: err.message,
      stack: err.stack
    });
  }
}
