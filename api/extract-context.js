// Vercel serverless function to extract context from search queries
// This offloads OpenAI API calls from the Flutter app's main thread

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS headers for Flutter web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { query } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
      console.error('OPENAI_API_KEY not configured');
      // Return basic context without OpenAI
      return res.status(200).json({
        destination: null,
        occasion: null,
        timePeriod: null,
        season: null,
        specificMonths: null,
        originalQuery: query,
        contextExplanation: `Showing results for: ${query}`,
      });
    }

    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1; // 1-12
    const currentYear = currentDate.getFullYear();
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const prompt = `You are a helpful shopping assistant. Analyze the following user search query and extract contextual information.

User Query: "${query}"

Current Date: ${monthNames[currentMonth - 1]} ${currentYear}

Extract the following information from the query:
1. Destination (if mentioned): e.g., "New York", "Paris", "Mumbai"
2. Occasion type: "trip", "wedding", "event", "party", "vacation", etc.
3. Time period: Determine if the user is planning for:
   - Current month (this month)
   - Next 2 months
   - Next 3 months
   - Specific months mentioned
4. Season: If time period suggests a season, identify it (winter, spring, summer, fall)
5. Specific months: If months are mentioned, list them as numbers (1-12)

IMPORTANT: If the user mentions a trip or travel, assume they need items for that time period. 
If no specific time is mentioned but a destination is given, suggest items suitable for the next 2-3 months.

Respond ONLY with a valid JSON object in this exact format:
{
  "destination": "destination name or null",
  "occasion": "occasion type or null",
  "timePeriod": "currentMonth" | "nextTwoMonths" | "nextThreeMonths" | "nextSixMonths" | "specificMonths" | null,
  "season": "winter" | "spring" | "summer" | "fall" | null,
  "specificMonths": [1, 2, 3] or null,
  "contextExplanation": "Human-readable explanation like 'Showing results for your trip to New York in the next 2 months'"
}

If information cannot be determined, use null. Be concise and accurate.`;

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that extracts contextual information from user queries. Always respond with valid JSON only.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('OpenAI API error:', response.status, errorData);
      
      // Return basic context on error
      return res.status(200).json({
        destination: null,
        occasion: null,
        timePeriod: null,
        season: null,
        specificMonths: null,
        originalQuery: query,
        contextExplanation: `Showing results for: ${query}`,
      });
    }

    const data = await response.json();
    const content = data.choices[0].message.content;

    // Extract JSON from response (handle markdown code blocks if present)
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.substring(7);
    }
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.substring(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.substring(0, jsonStr.length - 3);
    }
    jsonStr = jsonStr.trim();

    const context = JSON.parse(jsonStr);
    context.originalQuery = query;

    return res.status(200).json(context);
  } catch (error) {
    console.error('Error extracting context:', error);
    
    // Return basic context on any error
    return res.status(200).json({
      destination: null,
      occasion: null,
      timePeriod: null,
      season: null,
      specificMonths: null,
      originalQuery: req.body?.query || '',
      contextExplanation: `Showing results for: ${req.body?.query || ''}`,
    });
  }
}

