
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// --- NUCLEAR CONFIGURATION ---
const START_PAGE = 1;
const END_PAGE = 100;
// YOU ASKED FOR IT: High concurrency. 
// If this crashes your PC, lower this number.
const CONCURRENT_DOWNLOADS = 15; 

const IMG_DIR = path.join(process.cwd(), "public", "meme-templates");
const DATA_PATH = path.join(process.cwd(), "data", "memes.json");

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DATA_PATH))) fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });

async function run() {
    console.log(`
    ☢️  STARTING NUCLEAR SCRAPER
    -------------------------
    Concurrency: ${CONCURRENT_DOWNLOADS} Simultaneous Tabs
    Memory Safety: DISABLED
    Target: ${END_PAGE} Pages
    -------------------------
    `);

    const browser = await puppeteer.launch({
        headless: "new", // Fast mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1920,1080',
            // Removed memory saving flags. We are using full power.
        ]
    });

    // Load Database
    let database = [];
    try { if (fs.existsSync(DATA_PATH)) database = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch (e) {}

    const mainPage = await browser.newPage();

    for (let p = START_PAGE; p <= END_PAGE; p++) {
        try {
            console.log(`\n=== SCANNING PAGE ${p} ===`);
            const url = `https://knowyourmeme.com/categories/meme/page/${p}`;
            
            await mainPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

            // --- BRUTE FORCE SELECTOR (Fixes "0 Found") ---
            const memes = await mainPage.evaluate(() => {
                const results = [];
                const seen = new Set();
                
                // Grab every single link on the page
                document.querySelectorAll('a').forEach(a => {
                    const href = a.getAttribute('href');
                    
                    // Filter for meme links only
                    if (href && href.startsWith('/memes/') && 
                        !href.includes('/page/') && 
                        !href.includes('/categories/') && 
                        !href.includes('/photos/') &&
                        !href.includes('#')) {
                        
                        const img = a.querySelector('img');
                        const name = img ? (img.alt || img.title) : a.innerText;
                        
                        if (name && name.length > 2 && !seen.has(href)) {
                            seen.add(href);
                            results.push({ name: name.trim(), href });
                        }
                    }
                });
                return results;
            });

            if (memes.length === 0) {
                console.log("⚠️  Still found 0 memes. Saving HTML debug file...");
                const html = await mainPage.content();
                fs.writeFileSync('debug_nuclear.html', html);
                continue;
            }

            console.log(`   Found ${memes.length} memes. Launching ${CONCURRENT_DOWNLOADS} threads...`);

            // --- PARALLEL PROCESSING ---
            for (let i = 0; i < memes.length; i += CONCURRENT_DOWNLOADS) {
                const chunk = memes.slice(i, i + CONCURRENT_DOWNLOADS);
                
                // Run this chunk in parallel
                await Promise.all(chunk.map(async (meme) => {
                    if (database.some(m => m.name === meme.name)) return;

                    const tab = await browser.newPage();
                    try {
                        // Go to meme page
                        await tab.goto(`https://knowyourmeme.com${meme.href}`, { waitUntil: 'domcontentloaded', timeout: 45000 });

                        // Find High Res Image
                        const imageUrl = await tab.evaluate(() => {
                            const meta = document.querySelector('meta[property="og:image"]');
                            return meta ? meta.content : null;
                        });

                        if (imageUrl) {
                            const view = await tab.goto(imageUrl);
                            const buffer = await view.buffer();
                            
                            const safeName = meme.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().substring(0, 60);
                            const filename = `${safeName}-${Date.now()}.jpg`;
                            const dest = path.join(IMG_DIR, filename);

                            fs.writeFileSync(dest, buffer);

                            database.push({
                                id: Date.now().toString() + Math.random().toString().slice(2,5),
                                name: meme.name,
                                originalUrl: `https://knowyourmeme.com${meme.href}`,
                                localPath: `/meme-templates/${filename}`,
                                face: null,
                                createdAt: new Date().toISOString()
                            });

                            // Write immediately
                            fs.writeFileSync(DATA_PATH, JSON.stringify(database, null, 2));
                            process.stdout.write("█"); 
                        }
                    } catch (err) {
                        process.stdout.write("x");
                    } finally {
                        await tab.close();
                    }
                }));
            }

        } catch (e) {
            console.error(`   Page Error: ${e.message}`);
        }
    }

    console.log("\nDONE.");
    await browser.close();
}

run();