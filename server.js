const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const puppeteer = require('puppeteer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = 3000;

// Path Setup
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

// Session Setup (Keeps users logged in)
app.use(session({
    secret: 'gold-tracker-secret-key', // Change this to something random
    resave: false,
    saveUninitialized: false
}));

// --- STATE MANAGEMENT (Global) ---
let CACHED_RATE = null;
let LAST_FETCH_TIME = 0;
let MANUAL_RATE = null;

// --- DATA HELPERS ---

// 1. Get All Users
function getUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE);
        return JSON.parse(data);
    } catch (e) { return []; }
}

// 2. Add New User
function addUser(username, passwordHash) {
    const users = getUsers();
    users.push({ username, password: passwordHash });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// 3. Load Specific User's Holdings
function loadUserHoldings(username) {
    const filePath = path.join(DATA_DIR, `${username}.json`);
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath));
}

// 4. Save Specific User's Holdings
function saveUserHoldings(username, data) {
    const filePath = path.join(DATA_DIR, `${username}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- AUTH MIDDLEWARE ---
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

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
        if (result.match) {
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

// --- AUTH ROUTES ---

// Login Page
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// Login Logic
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username);

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = user.username;
        res.redirect('/');
    } else {
        res.render('login', { error: 'Invalid username or password' });
    }
});

// Register Page
app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

// Register Logic
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();

    if (users.find(u => u.username === username)) {
        return res.render('register', { error: 'Username already exists' });
    }

    // Hash password before saving
    const hashedPassword = await bcrypt.hash(password, 10);
    addUser(username, hashedPassword);

    // Create empty data file for new user
    saveUserHoldings(username, []);

    res.redirect('/login');
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// --- DASHBOARD ROUTES (Protected) ---

app.get('/', requireAuth, async (req, res) => {
    // Load holdings specifically for the logged-in user
    const holdings = loadUserHoldings(req.session.user);
    const currentRate = await getGoldRate();

    let totalInvested = 0;
    let totalCurrentValue = 0;

    const processedHoldings = holdings.map(h => {
        const totalCost = h.grams * h.buyPrice;
        totalInvested += totalCost;
        const currentVal = currentRate ? (h.grams * currentRate) : 0;
        totalCurrentValue += currentVal;

        return {
            ...h, totalCost, currentValue: currentVal,
            profitLoss: currentRate ? (currentVal - totalCost) : 0
        };
    });

    res.render('index', {
        holdings: processedHoldings,
        rate: currentRate,
        isManual: !!MANUAL_RATE,
        totalInvested,
        totalCurrentValue,
        totalPL: currentRate ? (totalCurrentValue - totalInvested) : 0,
        user: req.session.user // Pass username to view
    });
});

app.post('/add', requireAuth, (req, res) => {
    const username = req.session.user;
    const holdings = loadUserHoldings(username);

    holdings.push({
        id: Date.now(),
        date: new Date().toLocaleDateString('en-GB'),
        grams: parseFloat(req.body.grams),
        buyPrice: parseFloat(req.body.price)
    });

    saveUserHoldings(username, holdings);
    res.redirect('/');
});

app.post('/edit/:id', requireAuth, (req, res) => {
    const username = req.session.user;
    let holdings = loadUserHoldings(username);
    const index = holdings.findIndex(h => h.id == req.params.id);

    if (index !== -1) {
        holdings[index].grams = parseFloat(req.body.grams);
        holdings[index].buyPrice = parseFloat(req.body.price);
        if (req.body.date) {
            const [year, month, day] = req.body.date.split('-');
            holdings[index].date = `${day}/${month}/${year}`;
        }
        saveUserHoldings(username, holdings);
    }
    res.redirect('/');
});

app.post('/delete/:id', requireAuth, (req, res) => {
    const username = req.session.user;
    let holdings = loadUserHoldings(username);
    holdings = holdings.filter(h => h.id != req.params.id);
    saveUserHoldings(username, holdings);
    res.redirect('/');
});

app.post('/set-manual', requireAuth, (req, res) => {
    const r = parseFloat(req.body.rate);
    if (r > 0) MANUAL_RATE = r;
    res.redirect('/');
});

app.get('/set-auto', requireAuth, (req, res) => {
    MANUAL_RATE = null;
    CACHED_RATE = null;
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
});