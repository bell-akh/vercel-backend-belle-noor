// Vercel serverless function to enrich products with AI-generated keywords
// This improves context-based search by adding relevant keywords to products

import admin from 'firebase-admin';

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
  try {
    // Get Firebase credentials from environment variable
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
    
    if (!serviceAccount) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set');
    }

    const serviceAccountJson = JSON.parse(serviceAccount);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountJson),
    });
  } catch (error) {
    console.error('Error initializing Firebase Admin:', error);
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      batchSize = 10,  // Process products in batches
      dryRun = false,  // If true, don't update Firestore, just return keywords
      productId = null // If provided, only process this product
    } = req.body;

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    // Get products from Firestore
    let productsQuery = db.collection('shop_products');
    
    if (productId) {
      // Process single product
      const productDoc = await productsQuery.doc(productId).get();
      if (!productDoc.exists) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const products = [{ id: productDoc.id, ...productDoc.data() }];
      return await processProducts(products, openaiApiKey, dryRun, res);
    }

    // Get all products (or limit for testing)
    const snapshot = await productsQuery.get();
    const allProducts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`Found ${allProducts.length} products to process`);

    // Process in batches
    const results = {
      total: allProducts.length,
      processed: 0,
      updated: 0,
      errors: [],
      dryRun
    };

    for (let i = 0; i < allProducts.length; i += batchSize) {
      const batch = allProducts.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(allProducts.length / batchSize)}`);

      for (const product of batch) {
        try {
          const metadata = await generateKeywords(
            product.name || '',
            product.desc || product.description || '',
            product.category || '',
            openaiApiKey
          );

          if (!dryRun) {
            // Update product in Firestore with keywords, season, and bestFor
            const updateData = {
              keywords: metadata.keywords || [],
              season: metadata.season || 'ALL_SEASON',
              bestFor: metadata.bestFor || [],
              keywordsUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('shop_products').doc(product.id).update(updateData);
            results.updated++;
          }

          results.processed++;
        } catch (error) {
          console.error(`Error processing product ${product.id}:`, error);
          results.errors.push({
            productId: product.id,
            productName: product.name,
            error: error.message
          });
        }
      }

      // Add delay between batches to avoid rate limits
      if (i + batchSize < allProducts.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return res.status(200).json({
      success: true,
      message: dryRun 
        ? `Generated keywords for ${results.processed} products (dry run - no updates)` 
        : `Updated ${results.updated} products with keywords`,
      results
    });

  } catch (error) {
    console.error('Error in enrich-products:', error);
    return res.status(500).json({ 
      error: 'Internal Server Error',
      message: error.message 
    });
  }
}

async function processProducts(products, openaiApiKey, dryRun, res) {
  const results = {
    products: [],
    errors: []
  };

  for (const product of products) {
    try {
      const metadata = await generateKeywords(
        product.name || '',
        product.desc || product.description || '',
        product.category || '',
        openaiApiKey
      );

      if (!dryRun) {
        await db.collection('shop_products').doc(product.id).update({
          keywords: metadata.keywords || [],
          season: metadata.season || 'ALL_SEASON',
          bestFor: metadata.bestFor || [],
          keywordsUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      results.products.push({
        id: product.id,
        name: product.name,
        keywords: metadata.keywords,
        season: metadata.season,
        bestFor: metadata.bestFor
      });
    } catch (error) {
      results.errors.push({
        productId: product.id,
        error: error.message
      });
    }
  }

  return res.status(200).json({
    success: true,
    dryRun,
    results
  });
}

async function generateKeywords(name, description, category, apiKey) {
  const prompt = `You are a product tagging assistant for an e-commerce store. Analyze a product and generate structured metadata.

Product Name: "${name}"
Category: "${category}"
Description: "${description.substring(0, 500)}" ${description.length > 500 ? '...' : ''}

Analyze this product and return a JSON object with:
1. "keywords": Array of 10-15 relevant search keywords (material, style, use case, etc.)
2. "season": One of "SUMMER", "WINTER", or "ALL_SEASON" based on when this product is best worn
3. "bestFor": Array of one or more from: "DATE", "CASUAL", "OFFICIAL_PURPOSE", "FESTIVE", "PARTY" - select all that apply

Season Guidelines:
- SUMMER: Light fabrics, sleeveless, shorts, breathable materials, beach wear
- WINTER: Warm fabrics, jackets, sweaters, wool, thermal wear
- ALL_SEASON: Versatile items that work year-round

Best For Guidelines:
- DATE: Romantic, elegant, special occasion wear
- CASUAL: Everyday wear, comfortable, relaxed
- OFFICIAL_PURPOSE: Formal, professional, office-appropriate
- FESTIVE: Traditional, celebration, cultural events
- PARTY: Fun, trendy, night-out wear

Return ONLY a valid JSON object in this exact format:
{
  "keywords": ["cotton", "casual", "summer", "comfortable"],
  "season": "SUMMER",
  "bestFor": ["CASUAL", "DATE"]
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that generates product metadata. Always respond with valid JSON objects only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.5,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();

    // Extract JSON array from response
    let jsonStr = content;
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

    const metadata = JSON.parse(jsonStr);
    
    // Validate structure
    if (typeof metadata !== 'object' || metadata === null) {
      throw new Error('OpenAI returned invalid format - expected object');
    }

    // Validate and clean keywords
    let keywords = [];
    if (Array.isArray(metadata.keywords)) {
      keywords = metadata.keywords
        .filter(k => typeof k === 'string' && k.trim().length > 0)
        .map(k => k.toLowerCase().trim())
        .slice(0, 15);
    }

    // Validate season
    const validSeasons = ['SUMMER', 'WINTER', 'ALL_SEASON'];
    const season = validSeasons.includes(metadata.season) 
      ? metadata.season 
      : 'ALL_SEASON';

    // Validate bestFor
    const validBestFor = ['DATE', 'CASUAL', 'OFFICIAL_PURPOSE', 'FESTIVE', 'PARTY'];
    let bestFor = [];
    if (Array.isArray(metadata.bestFor)) {
      bestFor = metadata.bestFor
        .filter(b => validBestFor.includes(b))
        .slice(0, 5); // Limit to 5
    }

    return {
      keywords,
      season,
      bestFor: bestFor.length > 0 ? bestFor : ['CASUAL'] // Default to CASUAL if empty
    };

  } catch (error) {
    console.error('Error generating keywords:', error);
    throw error;
  }
}

