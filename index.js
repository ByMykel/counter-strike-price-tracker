const SteamCommunity = require("steamcommunity");
const fs = require("fs");
const dir = `./static`;
const dirPrices = `./static/prices`;
const ITEMS_API_BASE_URL =
    "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en";
const MARKET_BASE_URL = "https://steamcommunity.com/market";
const STATE_FILE = "state.json";

const START_TIME = Date.now();
const MAX_DURATION = 3600 * 1000 * 5.5;

let errorFound = false;

if (process.argv.length != 4) {
    console.error(
        `Missing input arguments, expected 4 got ${process.argv.length}`
    );
    process.exit(1);
}

if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
}

if (!fs.existsSync(dirPrices)) {
    fs.mkdirSync(dirPrices);
}

let community = new SteamCommunity();

console.log("Logging into Steam community....");

community.login(
    {
        accountName: process.argv[2],
        password: process.argv[3],
        disableMobile: true,
    },
    async (err) => {
        if (err) {
            console.log("login:", err);
            return;
        }

        try {
            console.log("Loading items...");
            const items = await getAllItemNames();
            console.log(`Processing ${items.length} items.`);
            const state = loadState();
            const lastIndex = (state.lastIndex || 0) % items.length;
            await processItems(items.slice(lastIndex), lastIndex);

            const prices = await loadPrices();
            const newPrices = {
                ...prices,
                ...priceDataByItemHashName,
            };
            const orderedNewPrices = Object.keys(newPrices)
                .sort()
                .reduce((acc, key) => {
                    acc[key] = newPrices[key];
                    return acc;
                }, {});

            // Save price data to one json file
            fs.writeFile(
                `${dirPrices}/latest.json`,
                JSON.stringify(orderedNewPrices, null, 4),
                (err) => err && console.error(err)
            );
        } catch (error) {
            console.error("An error occurred while processing items:", error);
        }
    }
);

// Price data by item hash name
const priceDataByItemHashName = {};

function loadPrices() {
    if (fs.existsSync(`${dirPrices}/latest.json`)) {
        const data = fs.readFileSync(`${dirPrices}/latest.json`);
        return JSON.parse(data);
    }
    return {};
}

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE);
        return JSON.parse(data);
    }
    return {};
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function getAllItemNames() {
    return Promise.all([
        fetch(`${ITEMS_API_BASE_URL}/skins_not_grouped.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/stickers.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/crates.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/agents.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/keys.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/patches.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/graffiti.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/music_kits.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/collectibles.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
        fetch(`${ITEMS_API_BASE_URL}/keychains.json`)
            .then((res) => res.json())
            .then((res) => res.map((item) => item.market_hash_name)),
    ]).then((results) => results.flat().filter(Boolean));
}

async function fetchPrice(name) {
    return new Promise((resolve, reject) => {
        community.request.get(
            `${MARKET_BASE_URL}/pricehistory/?appid=730&market_hash_name=${encodeURIComponent(
                name
            )}`,
            (err, res) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    if (res.statusCode == 429) {
                        errorFound = true;
                        console.log(
                            "[ERROR]",
                            res.statusCode,
                            res.statusMessage
                        );
                        console.log(
                            `${MARKET_BASE_URL}/pricehistory/?appid=730&market_hash_name=${encodeURIComponent(
                                name
                            )}`
                        );
                        resolve({ prices: [], lastEver: null });
                    }

                    const prices = (JSON.parse(res.body).prices || []).map(
                        ([time, value, volume]) => ({
                            time: Date.parse(time),
                            value,
                            volume: parseInt(volume),
                        })
                    );
                    resolve({
                        prices,
                        lastEver: prices.length > 0 ? prices[prices.length - 1].value : null
                    });
                } catch (parseError) {
                    reject(parseError);
                }
            }
        );
    });
}

async function processBatch(batch) {
    const promises = batch.map((name) =>
        fetchPrice(name)
            .then(({ prices, lastEver }) => {
                if (prices.length > 0) {
                    priceDataByItemHashName[name] = {
                        steam: getMedianPrice(prices, lastEver)
                    };
                }
            })
            .catch((error) => console.log(`Error processing ${name}:`, error))
    );
    await Promise.all(promises);
}

async function processItems(items, startIndex, batchSize = 1) {
    // Calculate delay based on rate limit
    const requestsPerMinute = 20;
    // Calculate delay needed after each batch to adhere to the rate limit
    // Note: If batchSize is larger than the rate limit, this will result in a negative delay,
    // which should be handled as well (e.g., by setting a minimum batchSize or adjusting the logic accordingly).
    const delayPerBatch = (60 / requestsPerMinute) * batchSize * 1000; // Convert to milliseconds

    for (let i = 0; i < items.length; i += batchSize) {
        const currentTime = Date.now();
        if (currentTime - START_TIME >= MAX_DURATION) {
            console.log("Max duration reached. Stopping the process.");
            saveState({ lastIndex: startIndex + i });
            return;
        }

        const batch = items.slice(i, i + batchSize);
        await processBatch(batch);

        if (errorFound) {
            return;
        }

        console.log(
            `Processed batch ${i / batchSize + 1}/${Math.ceil(
                items.length / batchSize
            )}`
        );

        saveState({ lastIndex: startIndex + i + batchSize });

        // Add a delay to respect the rate limit, only if there are more batches to process
        if (i + batchSize < items.length) {
            console.log(
                `Waiting for ${
                    delayPerBatch / 1000
                } seconds to respect rate limit...`
            );
            await new Promise((resolve) => setTimeout(resolve, delayPerBatch));
        }
    }
}

function getMedianPrice(data, lastEver) {
    const now = Date.now();

    const calculateMedian = (days) => {
        const limit = now - days * 24 * 60 * 60 * 1000;
        const prices = [];

        for (const { time, value, volume } of data) {
            if (time >= limit) {
                for (let i = 0; i < volume; i++) {
                    prices.push(value);
                }
            }
        }

        if (prices.length === 0) return null;

        prices.sort((a, b) => a - b);

        const mid = Math.floor(prices.length / 2);
        return prices.length % 2 === 0
            ? (prices[mid - 1] + prices[mid]) / 2
            : prices[mid];
    };

    return {
        last_24h: calculateMedian(1),
        last_7d: calculateMedian(7),
        last_30d: calculateMedian(30),
        last_90d: calculateMedian(90),
        last_ever: lastEver
    };
}
