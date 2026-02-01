// --- THE "TEXT SCAN" SCRAPER (DEBUG MODE) ---
async function getGoldRate() {
    // 1. Manual Override
    if (MANUAL_RATE) return MANUAL_RATE;

    // 2. Cache Check (1 hour)
    if (CACHED_RATE && (Date.now() - LAST_FETCH_TIME < 60 * 60 * 1000)) {
        return CACHED_RATE;
    }

    console.log("⏳ Scraper: Launching browser...");
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            ]
        });
        
        const page = await browser.newPage();
        
        await page.goto('https://www.goodreturns.in/gold-rates/chennai.html', { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });

        // TRICK: Scroll down to trigger lazy loading
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(r => setTimeout(r, 1000));

        // --- UPDATED DEBUG LOGIC ---
        const result = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            const pattern = /24K\s+Gold[\s\S]*?₹\s*([\d,]+)/i;
            
            const match = bodyText.match(pattern);
            
            return {
                match: match,
                price: match ? match[1] : null,
                fullText: bodyText // Return the whole text to Node.js console
            };
        });

        await browser.close();

        // LOGGING FOR DEBUGGING
        if(result.match) {
            console.log("🔍 Scraper matched pattern:", result.match);
        }
        if (result.price) {
            const cleanRate = parseFloat(result.price.replace(/,/g, '').trim());
            console.log(`🔎 Raw Scraped Number: ${cleanRate}`);

            if (!isNaN(cleanRate) && cleanRate > 5000 && cleanRate < 50000) {
                CACHED_RATE = cleanRate;
                LAST_FETCH_TIME = Date.now();
                console.log(`✅ Success (24K): ₹${cleanRate}`);
                return cleanRate;
            }
        } else {
            console.log("⚠️ Scraper could not match pattern!");
            console.log("--- DEBUG: WEBSITE TEXT START ---");
            // Log the first 2000 characters to see what the scraper saw
            console.log(result.fullText.substring(0, 2000)); 
            console.log("--- DEBUG: WEBSITE TEXT END ---");
            console.log("💡 TIP: Check if '24 Carat' and '1 Gram' are far apart in the text above.");
        }

    } catch (error) {
        console.error("❌ Scraper Error:", error.message);
        if (browser) await browser.close();
    }

    return CACHED_RATE; 
}
