const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const https = require("https");

const OUTPUT_PATH = path.resolve(__dirname, "..", "static", "latest.json");

const DELAY_MS = 5000;
const MAX_RETRIES = 5;
const PAGE_SIZE = 10;
const MAX_RUNTIME_MS = 90 * 60 * 1000; // 90 minutes
const SAVE_EVERY = 100; // checkpoint every N items

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadExisting() {
    try {
        if (fs.existsSync(OUTPUT_PATH)) {
            const data = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8"));
            return {
                prices:
                    data.prices && typeof data.prices === "object"
                        ? data.prices
                        : {},
                resumeFrom: data.metadata?.resume_from || 0,
            };
        }
    } catch {
        // Corrupted file — start fresh
    }
    return { prices: {}, resumeFrom: 0 };
}

function save(prices, resumeFrom = 0) {
    const sorted = {};
    for (const key of Object.keys(prices).sort()) {
        sorted[key] = prices[key];
    }

    const metadata = {
        updated_at: new Date().toISOString(),
        currency: "USD",
        item_count: Object.keys(sorted).length,
    };

    if (resumeFrom > 0) {
        metadata.resume_from = resumeFrom;
    }

    const output = { metadata, prices: sorted };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output));
    console.log(
        `Saved ${output.metadata.item_count} prices to latest.json` +
            (resumeFrom > 0 ? ` (will resume from ${resumeFrom})` : "")
    );
}

function fetchJSON(url, cookies) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            {
                headers: {
                    Cookie: cookies.join("; "),
                    Accept: "application/json",
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    reject(
                        new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`)
                    );
                    res.resume();
                    return;
                }

                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`Invalid JSON: ${err.message}`));
                    }
                });
            }
        );
        req.on("error", reject);
    });
}

async function fetchWithRetry(url, cookies, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetchJSON(url, cookies);
        } catch (err) {
            console.error(
                `Attempt ${attempt + 1}/${retries + 1} failed: ${err.message}`
            );
            if (attempt === retries) throw err;
            await delay(DELAY_MS * Math.pow(2, attempt));
        }
    }
}

async function fetchAllPrices(cookies) {
    const { prices, resumeFrom } = loadExisting();
    const existingCount = Object.keys(prices).length;
    if (existingCount > 0) {
        console.log(
            `Loaded ${existingCount} existing prices from latest.json`
        );
    }

    let start = resumeFrom;
    if (start > 0) {
        console.log(`Resuming from offset ${start}`);
    }

    // Save on interrupt
    let interrupted = false;
    const onExit = () => {
        if (interrupted) return;
        interrupted = true;
        console.log("\nInterrupted — saving progress...");
        save(prices, start);
        process.exit(0);
    };
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);

    const startTime = Date.now();
    let totalCount = Infinity;
    let rateLimitRetries = 0;
    let itemsSinceLastSave = 0;

    console.log("Fetching CS2 market prices...");

    try {
        while (start < totalCount) {
            // Check time budget before each request
            if (Date.now() - startTime >= MAX_RUNTIME_MS) {
                console.log("Time budget reached, saving progress for next run...");
                save(prices, start);
                return;
            }

            const url = `https://steamcommunity.com/market/search/render/?appid=730&norender=1&currency=1&count=${PAGE_SIZE}&start=${start}`;
            console.log(
                `Fetching items ${start}–${start + PAGE_SIZE}...`
            );

            const data = await fetchWithRetry(url, cookies);

            if (totalCount === Infinity) {
                totalCount = data.total_count;
                console.log(`Total items on market: ${totalCount}`);
            }

            if (!data.results || data.results.length === 0) {
                console.log("Empty results response:", JSON.stringify(data));

                if (totalCount !== Infinity && data.total_count === 0) {
                    rateLimitRetries++;
                    console.log(`Rate limited (total_count dropped to 0), attempt ${rateLimitRetries}/${MAX_RETRIES}...`);
                    save(prices, start);

                    if (rateLimitRetries >= MAX_RETRIES) {
                        console.log("Max rate limit retries reached, saving progress and exiting.");
                        return;
                    }

                    const waitTime = 60000 * Math.pow(2, rateLimitRetries - 1);
                    console.log(`Waiting ${waitTime / 1000}s before retry...`);
                    await delay(waitTime);
                    continue;
                }

                console.log("No more results, stopping.");
                break;
            }

            rateLimitRetries = 0;

            for (const item of data.results) {
                const name = item.hash_name;
                const cents = item.sell_price;
                if (name && typeof cents === "number" && cents > 0) {
                    prices[name] = cents;
                }
            }

            start += PAGE_SIZE;
            itemsSinceLastSave += data.results.length;

            // Periodic checkpoint save
            if (itemsSinceLastSave >= SAVE_EVERY) {
                console.log(`Checkpoint: saving progress at offset ${start}...`);
                save(prices, start < totalCount ? start : 0);
                itemsSinceLastSave = 0;
            }

            if (start < totalCount) {
                await delay(DELAY_MS);
            }
        }
    } catch (err) {
        console.error(`Error at offset ${start}: ${err.message}`);
        console.log("Saving progress before exit...");
        save(prices, start);
        process.exit(1);
    }

    save(prices);
    console.log("Done!");
}

if (process.argv.length !== 4) {
    console.error(
        `Missing input arguments, expected 4 got ${process.argv.length}`
    );
    console.error("Usage: node fetch-prices.js <username> <password>");
    process.exit(1);
}

const user = new SteamUser();

console.log("Logging into Steam...");

user.logOn({
    accountName: process.argv[2],
    password: process.argv[3],
    rememberPassword: true,
    logonID: 2122,
});

user.once("loggedOn", () => {
    console.log("Logged on, waiting for web session...");
});

user.once("webSession", async (sessionID, cookies) => {
    console.log("Web session obtained, starting price fetch...");

    await fetchAllPrices(cookies);
    process.exit(0);
});

user.on("error", (err) => {
    console.error("Steam login error:", err.message);
    process.exit(1);
});
