const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const https = require("https"); // ✨ 內建神仙套件，保證免安裝、絕對不失聯！
const { AsyncLocalStorage } = require("async_hooks");

const app = express();
const PORT = process.env.PORT || 8080; 
const productionDb = new sqlite3.Database(path.join(__dirname, "assets.db"));
const demoDb = new sqlite3.Database(path.join(__dirname, "demo-assets.db"));
const dbContext = new AsyncLocalStorage();

// ==========================================
// 🔑 LINE 密碼填寫特區 (已經幫妳把Token鎖死在這裡，網頁不用再看到了)
// ==========================================
const LINE_CHANNEL_ACCESS_TOKEN = "DavSzTF3CHtq9KElIv9N+qBnI1vRfk3to1cyLJiJxavnmbmUaPziu1HVIuyLu3G/N6yImWVK3/Ek9evgTgCHgD8kWqP9EYLKkG6d4GWbvKVGXER/8/aANoukWp5JzqnG+PGUZ7Bj3rIvFN7berOpTQdB04t89/1O/w1cDnyilFU=";
const MY_LINE_USER_ID = "Uc56ad3eb8804726b20ed6e93323e6d4f"; 
const LINE_RECIPIENTS = {
    me: { label: "我", userId: "Uc56ad3eb8804726b20ed6e93323e6d4f" },
    husband: { label: "老公", userId: "U704dbfdc13c0bfbbf4496c614bb0c22b" }
};
const FUGLE_API_KEY = process.env.FUGLE_API_KEY || "NDgyNzI2OWQtMmNkMy00ZjA2LTg0MWItYzE1MGFlOWRmYzQ4IDNiN2JlNjU3LTkwYmUtNGI5ZC05NGYwLTk3NDEwZDE0YjJiZg==";
// ==========================================

app.use(express.json());
app.use((req, res, next) => {
    if (req.path.startsWith("/demo/webhook/line")) {
        req.url = req.url.replace(/^\/demo\/webhook\/line/, "/webhook/line");
        return dbContext.run({ db: demoDb, label: "Demo" }, next);
    }
    if (req.path.startsWith("/demo/api")) {
        req.url = req.url.replace(/^\/demo\/api/, "/api");
        return dbContext.run({ db: demoDb, label: "Demo" }, next);
    }
    if (req.path.startsWith("/api")) {
        return dbContext.run({ db: productionDb, label: "正式" }, next);
    }
    next();
});
app.use(express.static(__dirname));
app.get(["/demo", "/demo/"], (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

function activeDb() {
    return dbContext.getStore()?.db || productionDb;
}

function runWithDb(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
    });
}

function allWithDb(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
}

function run(sql, params = []) {
    return runWithDb(activeDb(), sql, params);
}

function all(sql, params = []) {
    return allWithDb(activeDb(), sql, params);
}

function parseMemoTags(memo) {
    const text = String(memo || "").trim();
    if (/^(買入|賣出)\s+[0-9A-Z]+\s+\(/.test(text)) return [];
    return [...new Set(text
        .split(/[,，、]/)
        .map(tag => tag.trim())
        .filter(Boolean))];
}

async function syncTagsForRecord(sourceType, sourceId, memo) {
    await run("DELETE FROM transaction_tags WHERE source_type = ? AND source_id = ?", [sourceType, sourceId]);
    const tags = parseMemoTags(memo);
    for (const tag of tags) {
        await run("INSERT OR IGNORE INTO transaction_tags (source_type, source_id, tag) VALUES (?, ?, ?)", [sourceType, sourceId, tag]);
    }
}

function toTwseStockCode(stockCode) {
    const rawCode = String(stockCode || "").trim().toUpperCase();
    if (!rawCode) return null;

    const codeMatch = rawCode.match(/^([0-9]{4,6}[A-Z]{0,2})(?:\.(?:TW|TWO))?$/);
    return codeMatch ? codeMatch[1] : null;
}

function isDemoContext() {
    return dbContext.getStore()?.label === "Demo";
}

function environmentLabel() {
    return isDemoContext() ? "DEMO" : "正式";
}

function resolveLineRecipient(recipient = "me", forceMe = false) {
    if (forceMe) return LINE_RECIPIENTS.me;
    return LINE_RECIPIENTS[recipient] || LINE_RECIPIENTS.me;
}

function taipeiDateString() {
    const twTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    return `${twTime.getFullYear()}-${String(twTime.getMonth() + 1).padStart(2, "0")}-${String(twTime.getDate()).padStart(2, "0")}`;
}

const DEFAULT_TX_CATEGORIES = {
    "支出": [
        { label: "餐飲食宿", icon: "🍔" },
        { label: "購物治裝", icon: "👗" },
        { label: "生活雜費", icon: "🏠" },
        { label: "固定支出", icon: "📅" },
        { label: "育兒支出", icon: "🍼" },
        { label: "保險醫療", icon: "🏥" },
        { label: "交通出行", icon: "🚗" },
        { label: "休閒娛樂", icon: "🎉" },
        { label: "投資出款", icon: "📉" },
        { label: "其他支出", icon: "💸" }
    ],
    "收入": [
        { label: "薪資收入", icon: "💰" },
        { label: "投資獲利", icon: "📈" },
        { label: "獎金紅包", icon: "🧧" },
        { label: "其他收入", icon: "✨" }
    ]
};

const STOCK_NAME_FALLBACK = {
    "1802": "台玻",
    "00631L": "元大台灣50正2",
    "A36004": "安聯台灣科技基金"
};

function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                ...headers
            }
        };
        https.get(url, options, (response) => {
            let data = "";
            response.on("data", (chunk) => { data += chunk; });
            response.on("end", () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(data || `HTTP ${response.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error("解析股價資料失敗"));
                }
            });
        }).on("error", reject);
    });
}

function parsePrice(value) {
    const price = Number(String(value || "").replace(/,/g, ""));
    return Number.isFinite(price) && price > 0 ? price : null;
}

function formatTwseDate(rawDate) {
    const value = String(rawDate || "");
    if (/^[0-9]{8}$/.test(value)) {
        return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    }
    if (/^[0-9]{7}$/.test(value)) {
        const year = Number(value.slice(0, 3)) + 1911;
        return `${year}-${value.slice(3, 5)}-${value.slice(5, 7)}`;
    }
    return value;
}

function normalizeStockName(value) {
    return String(value || "").trim();
}

function lookupStockName(stockCode) {
    const rawCode = String(stockCode || "").trim().toUpperCase();
    const twseCode = toTwseStockCode(rawCode);
    return STOCK_NAME_FALLBACK[rawCode] || (twseCode ? (STOCK_NAME_FALLBACK[twseCode] || "") : "");
}

function parseStockTransactionMemo(memo) {
    const match = String(memo || "").match(/^(買入|賣出)\s+([0-9A-Z]+)\s+\(([0-9.]+)(?:股|單位)?\/(?:單價|市價)([0-9.]+)\)/);
    if (!match) return null;
    const shares = Number(match[3]);
    const price = Number(match[4]);
    if (!Number.isFinite(shares) || shares <= 0) return null;
    return {
        action: match[1],
        stockCode: match[2].toUpperCase(),
        shares,
        price: Number.isFinite(price) ? price : null
    };
}

async function rebuildStockPosition(stockId, stockSnapshot = null) {
    if (!stockId) return;

    const rows = await all("SELECT * FROM transactions WHERE stock_ref_id = ? ORDER BY date, id", [stockId]);
    if (rows.length === 0) {
        await run("DELETE FROM stocks WHERE id = ?", [stockId]);
        return;
    }

    let accountId = stockSnapshot?.account_id || rows[0].account_id;
    let stockCode = stockSnapshot?.stock_code || "";
    let stockName = stockSnapshot?.stock_name || "";
    let shares = 0;
    let cost = 0;
    let lastDate = stockSnapshot?.date || rows[rows.length - 1].date;

    for (const row of rows) {
        const parsed = parseStockTransactionMemo(row.memo);
        if (!parsed) continue;
        accountId = row.account_id || accountId;
        stockCode = stockCode || parsed.stockCode;
        lastDate = row.date || lastDate;

        if (parsed.action === "買入") {
            const amount = Number(row.amount);
            const nextShares = shares + parsed.shares;
            cost = nextShares > 0 ? ((shares * cost) + amount) / nextShares : 0;
            shares = nextShares;
        } else if (parsed.action === "賣出") {
            shares = Math.max(0, shares - parsed.shares);
        }
    }

    if (!stockCode || shares <= 0) {
        await run("DELETE FROM stocks WHERE id = ?", [stockId]);
        return;
    }

    stockName = stockName || lookupStockName(stockCode);
    const conflict = (await all(
        "SELECT * FROM stocks WHERE account_id = ? AND stock_code = ? AND id <> ?",
        [accountId, stockCode, stockId]
    ))[0];
    if (conflict) {
        await run("UPDATE transactions SET stock_ref_id = ? WHERE stock_ref_id = ?", [conflict.id, stockId]);
        await run("DELETE FROM stocks WHERE id = ?", [stockId]);
        await rebuildStockPosition(conflict.id, conflict);
        return;
    }

    const existing = (await all("SELECT id FROM stocks WHERE id = ?", [stockId]))[0];
    if (existing) {
        await run(`
            UPDATE stocks
            SET account_id = ?, stock_code = ?, stock_name = COALESCE(NULLIF(?, ''), stock_name),
                shares = ?, cost = ?, date = ?
            WHERE id = ?
        `, [accountId, stockCode, stockName, shares, cost, lastDate, stockId]);
    } else {
        await run(`
            INSERT INTO stocks (id, account_id, stock_code, stock_name, shares, cost, market_price, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [stockId, accountId, stockCode, stockName, shares, cost, stockSnapshot?.market_price || cost, lastDate]);
    }
}

function formatQuoteTimeFromTimestamp(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return "";

    const milliseconds = raw > 10000000000000 ? Math.floor(raw / 1000) : raw;
    const quoteTime = new Date(milliseconds);
    if (Number.isNaN(quoteTime.getTime())) return "";

    return quoteTime.toLocaleTimeString("zh-TW", {
        timeZone: "Asia/Taipei",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

async function fetchFugleRealtimePrices(stockCodes) {
    if (!FUGLE_API_KEY) {
        throw new Error("尚未設定 FUGLE_API_KEY");
    }

    const entries = await Promise.all(stockCodes.map(async (stock) => {
        const url = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(stock.twseCode)}`;
        try {
            const quote = await fetchJson(url, { "X-API-KEY": FUGLE_API_KEY });
            const price =
                parsePrice(quote.lastPrice) ||
                parsePrice(quote.lastTrade?.price) ||
                parsePrice(quote.closePrice) ||
                parsePrice(quote.previousClose);

            if (!price) return null;

            const quoteTime = formatQuoteTimeFromTimestamp(
                quote.lastUpdated || quote.lastTrade?.time || quote.closeTime || quote.total?.time
            );

            return [stock.twseCode, {
                price,
                name: normalizeStockName(quote.name),
                source: "Fugle 富果即時行情",
                quoteDate: quote.date || taipeiDateString(),
                quoteTime
            }];
        } catch (err) {
            console.warn(`⚠️ Fugle ${stock.twseCode} 讀取失敗:`, err.message);
            return null;
        }
    }));

    return Object.fromEntries(entries.filter(Boolean));
}

async function fetchFugleIntradayCandles(stock) {
    if (!FUGLE_API_KEY) {
        throw new Error("尚未設定 FUGLE_API_KEY");
    }

    const candleUrl = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles/${encodeURIComponent(stock.twseCode)}?timeframe=1&sort=asc`;
    const quoteUrl = `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(stock.twseCode)}`;
    const [data, quote] = await Promise.all([
        fetchJson(candleUrl, { "X-API-KEY": FUGLE_API_KEY }),
        fetchJson(quoteUrl, { "X-API-KEY": FUGLE_API_KEY }).catch(err => {
            console.warn(`⚠️ Fugle ${stock.twseCode} 昨收讀取失敗:`, err.message);
            return {};
        })
    ]);
    const previousClose = parsePrice(quote.previousClose) || parsePrice(data.previousClose);
    const candles = (data.data || [])
        .map(candle => {
            const close = parsePrice(candle.close);
            if (!close) return null;
            const candleDate = new Date(candle.date);
            const label = Number.isNaN(candleDate.getTime())
                ? String(candle.date || "")
                : candleDate.toLocaleTimeString("zh-TW", {
                    timeZone: "Asia/Taipei",
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit"
                });

            return {
                time: candle.date,
                label,
                open: parsePrice(candle.open),
                high: parsePrice(candle.high),
                low: parsePrice(candle.low),
                close,
                volume: Number(candle.volume || 0),
                average: parsePrice(candle.average)
            };
        })
        .filter(Boolean);

    return {
        symbol: stock.stockCode,
        name: normalizeStockName(quote.name) || normalizeStockName(data.name) || stock.stockName || lookupStockName(stock.stockCode),
        date: data.date || taipeiDateString(),
        source: "Fugle 富果 1分K",
        previousClose,
        referencePrice: previousClose || null,
        referenceLabel: previousClose ? "昨收" : "",
        data: candles
    };
}

async function fetchTwseRealtimePrices(stockCodes) {
    const channels = stockCodes.flatMap(s => [`tse_${s.twseCode}.tw`, `otc_${s.twseCode}.tw`]);
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels.join("|"))}&json=1&delay=0&_=${Date.now()}`;
    
    const data = await fetchJson(url, { Referer: "https://mis.twse.com.tw/stock/index.jsp" });
    const priceMap = {};
    
    (data.msgArray || []).forEach(row => {
        const price = parsePrice(row.z) || parsePrice(row.pz) || parsePrice(row.y);
        if (row.c && price) {
            priceMap[row.c] = {
                price,
                name: normalizeStockName(row.n),
                source: "TWSE MIS 看盤價",
                quoteDate: formatTwseDate(row.d),
                quoteTime: row.t || row.ot || ""
            };
        }
    });
    return priceMap;
}

async function fetchTwseClosingPrices() {
    const twseData = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
    const priceMap = {};
    twseData.forEach(row => {
        const price = parsePrice(row.ClosingPrice);
        if (row.Code && price) {
            priceMap[row.Code] = {
                price,
                name: normalizeStockName(row.Name || row.NameOfSecurities || row.SecurityName),
                source: "TWSE 最新收盤價",
                quoteDate: formatTwseDate(row.Date),
                quoteTime: "收盤"
            };
        }
    });
    return priceMap;
}

async function fetchTwseStockNames() {
    const twseData = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
    const nameMap = {};
    twseData.forEach(row => {
        const name = normalizeStockName(row.Name || row.NameOfSecurities || row.SecurityName);
        if (row.Code && name) nameMap[row.Code] = name;
    });
    return nameMap;
}

// 🚀 LINE Messaging API 專用精緻 Flex Message 發送功能 (法式燕麥奶茶色卡片)
function sendLineFlexMessage(userId, title, content, highlightColor = "#b59f86") {
    return new Promise((resolve, reject) => {
        if (!LINE_CHANNEL_ACCESS_TOKEN || !userId) {
            reject(new Error("尚未設定 LINE Channel Access Token 或接收者 ID"));
            return;
        }

        const payload = JSON.stringify({
            to: userId,
            messages: [{
                type: "flex",
                altText: `【Asset Alert】${title}`,
                contents: {
                    type: "bubble",
                    size: "mega",
                    styles: { header: { backgroundColor: "#fbfaf8" }, body: { backgroundColor: "#ffffff" } },
                    header: {
                        type: "box", layout: "vertical", paddingAll: "20px",
                        contents: [{ type: "text", text: title, weight: "bold", size: "lg", color: highlightColor }]
                    },
                    body: {
                        type: "box", layout: "vertical", paddingAll: "20px",
                        contents: [
                            { type: "text", text: content, wrap: true, size: "sm", color: "#443e38" },
                            { type: "separator", margin: "xl", color: "#f0ede9" },
                            { type: "text", text: "💡 Avis's Asset Alert 💋", size: "xxs", color: "#b5a89e", margin: "md" }
                        ]
                    }
                }
            }]
        });

        const options = {
            hostname: "api.line.me",
            port: 443,
            path: "/v2/bot/message/push",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (lineRes) => {
            let data = "";
            lineRes.on("data", (chunk) => data += chunk);
            lineRes.on("end", () => {
                console.log("✨ LINE 推播回應：", data || lineRes.statusCode);
                if (lineRes.statusCode >= 200 && lineRes.statusCode < 300) {
                    resolve({ status: lineRes.statusCode, body: data });
                } else {
                    reject(new Error(data || `LINE API 回應 ${lineRes.statusCode}`));
                }
            });
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

function replyLineMessages(replyToken, messages) {
    return new Promise((resolve, reject) => {
        if (!LINE_CHANNEL_ACCESS_TOKEN || !replyToken) {
            reject(new Error("尚未設定 LINE Channel Access Token 或 replyToken"));
            return;
        }

        const payload = JSON.stringify({
            replyToken,
            messages
        });

        const options = {
            hostname: "api.line.me",
            port: 443,
            path: "/v2/bot/message/reply",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (lineRes) => {
            let data = "";
            lineRes.on("data", (chunk) => data += chunk);
            lineRes.on("end", () => {
                if (lineRes.statusCode >= 200 && lineRes.statusCode < 300) {
                    resolve({ status: lineRes.statusCode, body: data });
                } else {
                    reject(new Error(data || `LINE Reply API 回應 ${lineRes.statusCode}`));
                }
            });
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

function replyLineText(replyToken, text) {
    return replyLineMessages(replyToken, [{ type: "text", text }]);
}

function quickReplyItem(label, data) {
    const shortLabel = String(label).slice(0, 20);
    return {
        type: "action",
        action: {
            type: "postback",
            label: shortLabel,
            data,
            displayText: shortLabel
        }
    };
}

function replyLineQuickReply(replyToken, text, items) {
    return replyLineMessages(replyToken, [{
        type: "text",
        text,
        quickReply: { items: items.slice(0, 13) }
    }]);
}

async function getLineTxSession(userId) {
    const rows = await all("SELECT * FROM line_tx_sessions WHERE user_id = ?", [userId]);
    return rows[0] || null;
}

async function saveLineTxSession(userId, fields) {
    const current = await getLineTxSession(userId);
    const next = {
        step: current?.step || "",
        account_id: current?.account_id || null,
        tx_type: current?.tx_type || null,
        category: current?.category || null,
        ...fields
    };

    await run(`
        INSERT INTO line_tx_sessions (user_id, step, account_id, tx_type, category, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
            step = excluded.step,
            account_id = excluded.account_id,
            tx_type = excluded.tx_type,
            category = excluded.category,
            updated_at = datetime('now')
    `, [userId, next.step, next.account_id, next.tx_type, next.category]);
}

async function clearLineTxSession(userId) {
    await run("DELETE FROM line_tx_sessions WHERE user_id = ?", [userId]);
}

function normalizeLineTxType(value) {
    if (value === "1" || value === "支出") return "支出";
    if (value === "2" || value === "收入") return "收入";
    return null;
}

async function getTransactionCategories(type) {
    const rows = await all(
        "SELECT id, type, label, icon, sort_order FROM categories WHERE type = ? ORDER BY sort_order, id",
        [type]
    ).catch(() => []);
    if (rows.length) return rows;
    return (DEFAULT_TX_CATEGORIES[type] || []).map((item, idx) => ({
        id: null,
        type,
        label: item.label,
        icon: item.icon,
        sort_order: idx
    }));
}

async function promptLineAccountingMode(userId, replyToken) {
    await clearLineTxSession(userId);
    return replyLineQuickReply(replyToken, "請輸入或點選：\n1：紀錄支出\n2：紀錄收入", [
        quickReplyItem("1 紀錄支出", "action=line_start&type=%E6%94%AF%E5%87%BA"),
        quickReplyItem("2 紀錄收入", "action=line_start&type=%E6%94%B6%E5%85%A5")
    ]);
}

async function startLineAccounting(userId, replyToken, txTypeValue) {
    const txType = normalizeLineTxType(txTypeValue);
    if (!txType) {
        return promptLineAccountingMode(userId, replyToken);
    }

    await clearLineTxSession(userId);
    const accounts = await all("SELECT id, name, balance FROM accounts ORDER BY type, id DESC");
    if (accounts.length === 0) {
        return replyLineText(replyToken, "目前還沒有帳戶，請先到系統的「設定」新增帳戶。");
    }

    await saveLineTxSession(userId, { step: "account", tx_type: txType, account_id: null, category: null });
    const items = accounts.map(account => quickReplyItem(account.name, `action=line_account&account_id=${account.id}`));
    return replyLineQuickReply(replyToken, `準備紀錄${txType}\n請選擇帳戶：`, items);
}

async function askLineCategory(userId, replyToken, accountId) {
    const account = (await all("SELECT id, name FROM accounts WHERE id = ?", [accountId]))[0];
    if (!account) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "找不到這個帳戶，請重新輸入 1 或 2 再試一次。");
    }

    const session = await getLineTxSession(userId);
    const txType = normalizeLineTxType(session?.tx_type) || "支出";
    await saveLineTxSession(userId, { step: "category", account_id: account.id, tx_type: txType, category: null });
    const categories = await getTransactionCategories(txType);
    const items = categories.slice(0, 12).map(category =>
        quickReplyItem(`${category.icon || ""} ${category.label}`.trim(), `action=line_category&category=${encodeURIComponent(category.label)}`)
    );
    items.push(quickReplyItem("取消", "action=line_cancel"));
    return replyLineQuickReply(replyToken, `帳戶：${account.name}\n請選擇${txType}分類：`, items);
}

async function askLineAmount(userId, replyToken, category) {
    const session = await getLineTxSession(userId);
    if (!session?.account_id || !session?.tx_type) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "記帳流程已中斷，請重新輸入 1 或 2。");
    }

    await saveLineTxSession(userId, { step: "amount", category });
    return replyLineText(replyToken, `分類：${category}\n請輸入交易金額，例如 120。\n要取消請輸入「取消」。`);
}

async function finishLineAmount(userId, replyToken, text) {
    const session = await getLineTxSession(userId);
    if (!session || session.step !== "amount" || !session.account_id || !session.tx_type || !session.category) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "記帳流程已中斷，請重新輸入 1 或 2。");
    }

    const amount = Number(String(text).replace(/[$,，\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
        return replyLineText(replyToken, "請輸入正確金額，例如 120。要取消請輸入「取消」。");
    }

    const account = (await all("SELECT id, name FROM accounts WHERE id = ?", [session.account_id]))[0];
    if (!account) {
        await clearLineTxSession(userId);
        return replyLineText(replyToken, "找不到這個帳戶，請重新輸入 1 或 2 再試一次。");
    }

    try {
        await run("BEGIN TRANSACTION");
        await run(
            "INSERT INTO transactions (account_id, type, category, amount, date, memo) VALUES (?, ?, ?, ?, ?, ?)",
            [session.account_id, session.tx_type, session.category, amount, taipeiDateString(), "LINE 快速記帳"]
        );
        await run(
            "UPDATE accounts SET balance = balance + ? WHERE id = ?",
            [session.tx_type === "收入" ? amount : -amount, session.account_id]
        );
        await run("COMMIT");
        await clearLineTxSession(userId);

        const sign = session.tx_type === "收入" ? "+" : "-";
        return replyLineText(
            replyToken,
            `[${environmentLabel()}] 已完成記帳：\n${account.name}\n${session.tx_type} / ${session.category}\n${sign}$${amount.toLocaleString("zh-TW")}`
        );
    } catch (err) {
        await run("ROLLBACK").catch(() => {});
        throw err;
    }
}

async function handleLineWebhook(req, res) {
    const events = req.body.events || [];
    res.sendStatus(200);

    for (const event of events) {
        const userId = event.source?.userId;
        if (!userId) continue;
        const replyToken = event.replyToken;

        console.log("======================================");
        console.log("💖 抓到 LINE User ID 囉！");
        console.log("👉 " + userId);
        console.log("======================================");

        if (!replyToken) continue;

        try {
            if (event.type === "postback") {
                const params = new URLSearchParams(event.postback?.data || "");
                const action = params.get("action");

                if (action === "line_start") {
                    await startLineAccounting(userId, replyToken, params.get("type"));
                } else if (action === "line_account") {
                    await askLineCategory(userId, replyToken, Number(params.get("account_id")));
                } else if (action === "line_type") {
                    const session = await getLineTxSession(userId);
                    const txType = normalizeLineTxType(params.get("type"));
                    if (session?.account_id) {
                        if (txType) await saveLineTxSession(userId, { tx_type: txType });
                        await askLineCategory(userId, replyToken, session.account_id);
                    } else {
                        await startLineAccounting(userId, replyToken, txType);
                    }
                } else if (action === "line_category") {
                    await askLineAmount(userId, replyToken, params.get("category"));
                } else if (action === "line_cancel") {
                    await clearLineTxSession(userId);
                    await replyLineText(replyToken, "已取消 LINE 快速記帳。");
                }
                continue;
            }

            if (event.type === "message" && event.message?.type === "text") {
                const text = String(event.message.text || "").trim();
                if (text === "取消") {
                    await clearLineTxSession(userId);
                    await replyLineText(replyToken, "已取消 LINE 快速記帳。");
                    continue;
                }

                const session = await getLineTxSession(userId);
                if (session?.step === "amount") {
                    await finishLineAmount(userId, replyToken, text);
                    continue;
                }

                if (text === "1" || text === "2") {
                    await startLineAccounting(userId, replyToken, text);
                    continue;
                }

                if (text === "記帳" || text === "快速記帳" || text.includes("記帳")) {
                    await promptLineAccountingMode(userId, replyToken);
                    continue;
                }

                await replyLineQuickReply(replyToken, `輸入 1 紀錄支出，輸入 2 紀錄收入。\n\n你的 LINE userId：\n${userId}`, [
                    quickReplyItem("1 紀錄支出", "action=line_start&type=%E6%94%AF%E5%87%BA"),
                    quickReplyItem("2 紀錄收入", "action=line_start&type=%E6%94%B6%E5%85%A5")
                ]);
            }
        } catch (e) {
            console.error("❌ LINE webhook 處理失敗:", e.message);
            await replyLineText(replyToken, "LINE 快速記帳暫時失敗，請稍後再試。")
                .catch(err => console.error("❌ LINE webhook 回覆失敗:", err.message));
        }
    }
}

// 初始化資料庫
function initializeDatabase(database, label) {
    database.serialize(() => {
    database.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            balance REAL NOT NULL DEFAULT 0
        )
    `);

    database.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,
            memo TEXT,
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    database.run(`
        CREATE TABLE IF NOT EXISTS transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_account_id INTEGER NOT NULL,
            to_account_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            date TEXT NOT NULL,
            memo TEXT,
            FOREIGN KEY(from_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY(to_account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    database.run(`
        CREATE TABLE IF NOT EXISTS stocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            stock_code TEXT NOT NULL,
            stock_name TEXT,
            shares REAL NOT NULL,
            cost REAL NOT NULL,
            market_price REAL,
            market_price_source TEXT,
            market_price_date TEXT,
            market_price_time TEXT,
            date TEXT,
            UNIQUE(account_id, stock_code),
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    // ✨ 建立 LINE 月定時推播設定表
    database.run(`CREATE TABLE IF NOT EXISTS notify_settings (id INTEGER PRIMARY KEY CHECK (id = 1), push_time TEXT DEFAULT '21:30', credit_card_day INTEGER DEFAULT 25, monthly_enabled INTEGER DEFAULT 1, daily_msg TEXT DEFAULT '', card_msg TEXT DEFAULT '')`);
    database.run(`INSERT OR IGNORE INTO notify_settings (id, push_time, credit_card_day, monthly_enabled, daily_msg, card_msg) VALUES (1, '21:30', 25, 1, '', '重要通知！今天記得檢查信用卡費並繳清唷！💳')`);
    database.run(`CREATE TABLE IF NOT EXISTS line_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, day_of_month INTEGER NOT NULL, push_time TEXT NOT NULL, message TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT 'me', enabled INTEGER NOT NULL DEFAULT 1, last_sent_key TEXT)`);
    database.run(`
        CREATE TABLE IF NOT EXISTS line_tx_sessions (
            user_id TEXT PRIMARY KEY,
            step TEXT NOT NULL,
            account_id INTEGER,
            tx_type TEXT,
            category TEXT,
            updated_at TEXT
        )
    `);

    database.run(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            label TEXT NOT NULL,
            icon TEXT DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            UNIQUE(type, label)
        )
    `);

    database.run(`
        CREATE TABLE IF NOT EXISTS transaction_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_type TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            UNIQUE(source_type, source_id, tag)
        )
    `);
    database.run(`
        CREATE TABLE IF NOT EXISTS budgets (
            category TEXT PRIMARY KEY,
            amount REAL NOT NULL DEFAULT 0
        )
    `);
    database.run(`
        CREATE TABLE IF NOT EXISTS budget_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_name TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            categories TEXT NOT NULL DEFAULT '[]'
        )
    `);
    database.all("SELECT category, amount FROM budgets WHERE amount > 0", (err, rows) => {
        if (err || !rows) return;
        rows.forEach(row => {
            const groupName = `${row.category}預算`;
            database.get("SELECT id FROM budget_groups WHERE group_name = ?", [groupName], (existingErr, existing) => {
                if (existingErr || existing) return;
                database.run(
                    "INSERT INTO budget_groups (group_name, amount, categories) VALUES (?, ?, ?)",
                    [groupName, Number(row.amount || 0), JSON.stringify([row.category])]
                );
            });
        });
    });
    database.run("DELETE FROM transaction_tags WHERE tag LIKE '買入 %' OR tag LIKE '賣出 %'");

    Object.entries(DEFAULT_TX_CATEGORIES).forEach(([type, items]) => {
        items.forEach((item, idx) => {
            database.run(
                "INSERT OR IGNORE INTO categories (type, label, icon, sort_order) VALUES (?, ?, ?, ?)",
                [type, item.label, item.icon, idx]
            );
        });
    });

    database.all("SELECT id, memo FROM transactions WHERE memo IS NOT NULL AND memo <> ''", (err, rows) => {
        if (err || !rows) return;
        rows.forEach(row => {
            parseMemoTags(row.memo).forEach(tag => {
                database.run(
                    "INSERT OR IGNORE INTO transaction_tags (source_type, source_id, tag) VALUES (?, ?, ?)",
                    ["transaction", row.id, tag]
                );
            });
        });
    });
    database.all("SELECT id, memo FROM transfers WHERE memo IS NOT NULL AND memo <> ''", (err, rows) => {
        if (err || !rows) return;
        rows.forEach(row => {
            parseMemoTags(row.memo).forEach(tag => {
                database.run(
                    "INSERT OR IGNORE INTO transaction_tags (source_type, source_id, tag) VALUES (?, ?, ?)",
                    ["transfer", row.id, tag]
                );
            });
        });
    });

    database.all("PRAGMA table_info(notify_settings)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'monthly_enabled')) {
            database.run("ALTER TABLE notify_settings ADD COLUMN monthly_enabled INTEGER DEFAULT 1");
        }
    });
    database.get("SELECT COUNT(*) as count FROM line_reminders", (err, row) => {
        if (err || !row || row.count > 0) return;
        database.get("SELECT * FROM notify_settings WHERE id = 1", (settingsErr, settings) => {
            if (settingsErr || !settings || !settings.card_msg) return;
            database.run(
                "INSERT INTO line_reminders (name, day_of_month, push_time, message, recipient, enabled) VALUES (?, ?, ?, ?, ?, ?)",
                ["信用卡費提醒", settings.credit_card_day || 25, settings.push_time || "21:30", settings.card_msg, "me", Number(settings.monthly_enabled ?? 1)]
            );
        });
    });

    database.all("PRAGMA table_info(line_reminders)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'recipient')) {
            database.run("ALTER TABLE line_reminders ADD COLUMN recipient TEXT NOT NULL DEFAULT 'me'");
        }
    });

    database.all("PRAGMA table_info(transactions)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'stock_ref_id')) {
            database.run("ALTER TABLE transactions ADD COLUMN stock_ref_id INTEGER");
        }
    });

    database.all("PRAGMA table_info(stocks)", (err, cols) => {
        if (!err && cols && !cols.some(c => c.name === 'stock_name')) {
            database.run("ALTER TABLE stocks ADD COLUMN stock_name TEXT");
        }
        if (!err && cols && !cols.some(c => c.name === 'market_price')) {
            database.run("ALTER TABLE stocks ADD COLUMN market_price REAL");
        }
        if (!err && cols && !cols.some(c => c.name === 'market_price_source')) {
            database.run("ALTER TABLE stocks ADD COLUMN market_price_source TEXT");
        }
        if (!err && cols && !cols.some(c => c.name === 'market_price_date')) {
            database.run("ALTER TABLE stocks ADD COLUMN market_price_date TEXT");
        }
        if (!err && cols && !cols.some(c => c.name === 'market_price_time')) {
            database.run("ALTER TABLE stocks ADD COLUMN market_price_time TEXT");
        }
    });

    Object.entries(STOCK_NAME_FALLBACK).forEach(([code, name]) => {
        database.run("UPDATE stocks SET stock_name = ? WHERE stock_code = ? AND (stock_name IS NULL OR stock_name = '')", [name, code]);
    });

    console.log(`🔒 ${label}看盤價資產大腦配置完畢！`);
    });
}

initializeDatabase(productionDb, "正式版");
initializeDatabase(demoDb, "Demo 版");

// 🎯 核心定時排程（每分鐘起來檢查有沒有到設定時間）
setInterval(() => {
    try {
        const twTime = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Taipei"}));
        const todayDate = twTime.getDate(); 
        const currentTime = `${String(twTime.getHours()).padStart(2, '0')}:${String(twTime.getMinutes()).padStart(2, '0')}`;
        const scheduleKey = `${twTime.getFullYear()}-${twTime.getMonth() + 1}-${todayDate}-${currentTime}`;

        for (const { database, label } of [
            { database: productionDb, label: "正式版" },
            { database: demoDb, label: "Demo 版" }
        ]) {
            database.all("SELECT * FROM line_reminders WHERE enabled = 1 AND day_of_month = ? AND push_time = ?", [todayDate, currentTime], async (err, reminders) => {
                if (err || !reminders) return;

                for (const reminder of reminders) {
                    const reminderKey = `${reminder.id}-${scheduleKey}`;
                    if (reminder.last_sent_key === reminderKey) continue;
                    await runWithDb(database, "UPDATE line_reminders SET last_sent_key = ? WHERE id = ?", [reminderKey, reminder.id]).catch(() => {});
                    const recipient = resolveLineRecipient(reminder.recipient, label === "Demo 版");
                    await sendLineFlexMessage(recipient.userId, `🚨 ${reminder.name}`, reminder.message, "#8c755e")
                        .catch(e => console.error(`❌ LINE ${label}月定時推播失敗:`, e.message));
                }
            });
        }
    } catch (e) { console.error("排程執行失敗:", e); }
}, 60 * 1000);

// 🔔 LINE 固定提醒清單 API
function normalizeReminderBody(body) {
    const name = String(body.name || "").trim();
    const day = Number(body.day_of_month);
    const pushTime = String(body.push_time || "").trim();
    const message = String(body.message || "").trim();
    const recipient = LINE_RECIPIENTS[body.recipient] ? body.recipient : "me";
    const enabled = body.enabled ? 1 : 0;
    if (!name) throw new Error("請輸入提醒名稱");
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("每月日期請輸入 1 到 31");
    if (!/^[0-2][0-9]:[0-5][0-9]$/.test(pushTime)) throw new Error("請選擇正確提醒時間");
    if (!message) throw new Error("請輸入提醒內容");
    return { name, day, pushTime, message, recipient, enabled };
}

app.get("/api/line-reminders", async (req, res) => {
    try {
        res.json(await all("SELECT * FROM line_reminders ORDER BY day_of_month, push_time, id"));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/line-reminders", async (req, res) => {
    try {
        const r = normalizeReminderBody(req.body);
        await run("INSERT INTO line_reminders (name, day_of_month, push_time, message, recipient, enabled) VALUES (?, ?, ?, ?, ?, ?)", [r.name, r.day, r.pushTime, r.message, r.recipient, r.enabled]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/line-reminders/:id", async (req, res) => {
    try {
        const r = normalizeReminderBody(req.body);
        await run("UPDATE line_reminders SET name = ?, day_of_month = ?, push_time = ?, message = ?, recipient = ?, enabled = ? WHERE id = ?", [r.name, r.day, r.pushTime, r.message, r.recipient, r.enabled, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/line-reminders/:id", async (req, res) => {
    try {
        await run("DELETE FROM line_reminders WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

function normalizeCategoryBody(body) {
    const type = normalizeLineTxType(body.type);
    const label = String(body.label || "").trim();
    const icon = String(body.icon || "").trim().slice(0, 4);
    const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;
    if (!type) throw new Error("類型請選擇支出或收入");
    if (!label) throw new Error("請輸入類別名稱");
    return { type, label, icon, sortOrder };
}

async function renameCategoryReferences(oldLabel, nextLabel) {
    if (!oldLabel || !nextLabel || oldLabel === nextLabel) return;

    await run("UPDATE transactions SET category = ? WHERE category = ?", [nextLabel, oldLabel]);
    await run("UPDATE line_tx_sessions SET category = ? WHERE category = ?", [nextLabel, oldLabel]);

    const oldBudgets = await all("SELECT amount FROM budgets WHERE category = ?", [oldLabel]);
    if (oldBudgets.length) {
        await run(`
            INSERT INTO budgets (category, amount) VALUES (?, ?)
            ON CONFLICT(category) DO UPDATE SET amount = excluded.amount
        `, [nextLabel, Number(oldBudgets[0].amount || 0)]);
        await run("DELETE FROM budgets WHERE category = ?", [oldLabel]);
    }

    const groups = await all("SELECT id, categories FROM budget_groups WHERE categories LIKE ?", [`%${oldLabel}%`]);
    for (const group of groups) {
        const parsed = parseBudgetGroup(group);
        if (!parsed.categories.includes(oldLabel)) continue;
        const nextCategories = [...new Set(parsed.categories.map(category => category === oldLabel ? nextLabel : category))];
        await run("UPDATE budget_groups SET categories = ? WHERE id = ?", [JSON.stringify(nextCategories), group.id]);
    }
}

app.get("/api/categories", async (req, res) => {
    try {
        res.json(await all("SELECT id, type, label, icon, sort_order FROM categories ORDER BY type DESC, sort_order, id"));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/categories", async (req, res) => {
    try {
        const c = normalizeCategoryBody(req.body);
        const maxRow = (await all("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM categories WHERE type = ?", [c.type]))[0];
        const sortOrder = Number.isFinite(Number(req.body.sort_order)) ? c.sortOrder : Number(maxRow?.max_order || 0) + 1;
        const result = await run(
            "INSERT INTO categories (type, label, icon, sort_order) VALUES (?, ?, ?, ?)",
            [c.type, c.label, c.icon, sortOrder]
        );
        res.status(201).json({ id: result.lastID });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/categories/:id", async (req, res) => {
    try {
        const c = normalizeCategoryBody(req.body);
        const oldCategory = (await all("SELECT type, label FROM categories WHERE id = ?", [req.params.id]))[0];
        if (!oldCategory) return res.status(404).json({ error: "找不到這個類別" });

        await run("BEGIN TRANSACTION");
        await run(
            "UPDATE categories SET type = ?, label = ?, icon = ?, sort_order = ? WHERE id = ?",
            [c.type, c.label, c.icon, c.sortOrder, req.params.id]
        );
        await renameCategoryReferences(oldCategory.label, c.label);
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/categories/:id", async (req, res) => {
    try {
        await run("DELETE FROM categories WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/budgets", async (req, res) => {
    try {
        res.json(await all("SELECT category, amount FROM budgets ORDER BY category"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/budgets", async (req, res) => {
    try {
        const category = String(req.body.category || "").trim();
        const amount = Number(req.body.amount || 0);
        if (!category) return res.status(400).json({ error: "請選擇預算分類" });
        if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "預算金額不可小於 0" });

        await run(`
            INSERT INTO budgets (category, amount) VALUES (?, ?)
            ON CONFLICT(category) DO UPDATE SET amount = excluded.amount
        `, [category, amount]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function normalizeBudgetGroupBody(body) {
    const id = Number(body.id || 0);
    const groupName = String(body.group_name || "").trim();
    const amount = Number(body.amount || 0);
    const categories = Array.isArray(body.categories)
        ? body.categories.map(category => String(category || "").trim()).filter(Boolean)
        : String(body.categories || "")
            .split(/[,，、]/)
            .map(category => category.trim())
            .filter(Boolean);

    if (!groupName) throw new Error("請輸入預算群組名稱");
    if (!Number.isFinite(amount) || amount < 0) throw new Error("群組預算金額不可小於 0");
    if (!categories.length) throw new Error("請至少勾選一個支出分類");

    return {
        id: Number.isFinite(id) && id > 0 ? id : null,
        groupName,
        amount,
        categories: [...new Set(categories)]
    };
}

function parseBudgetGroup(row) {
    let categories = [];
    try {
        categories = JSON.parse(row.categories || "[]");
    } catch (err) {
        categories = String(row.categories || "").split(/[,，、]/).map(category => category.trim()).filter(Boolean);
    }
    return {
        id: row.id,
        group_name: row.group_name,
        amount: Number(row.amount || 0),
        categories: Array.isArray(categories) ? categories : []
    };
}

app.get("/api/budget-groups", async (req, res) => {
    try {
        const rows = await all("SELECT id, group_name, amount, categories FROM budget_groups ORDER BY id");
        res.json(rows.map(parseBudgetGroup));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/budget-groups", async (req, res) => {
    try {
        const id = Number(req.body.id || 0);
        if (req.body.delete || req.body.action === "delete") {
            if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "找不到要刪除的預算群組" });
            await run("DELETE FROM budget_groups WHERE id = ?", [id]);
            return res.json({ success: true });
        }

        const group = normalizeBudgetGroupBody(req.body);
        if (group.id) {
            await run(
                "UPDATE budget_groups SET group_name = ?, amount = ?, categories = ? WHERE id = ?",
                [group.groupName, group.amount, JSON.stringify(group.categories), group.id]
            );
        } else {
            const result = await run(
                "INSERT INTO budget_groups (group_name, amount, categories) VALUES (?, ?, ?)",
                [group.groupName, group.amount, JSON.stringify(group.categories)]
            );
            group.id = result.lastID;
        }
        res.json({ success: true, id: group.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 舊 API 保留給舊前端，不再作為主要功能
app.get("/api/notify-settings", (req, res) => {
    activeDb().get("SELECT * FROM notify_settings WHERE id = 1", (err, row) => { 
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { push_time: '21:30', credit_card_day: 25, monthly_enabled: 1, card_msg: '' }); 
    });
});

app.post("/api/send-line-message", async (req, res) => {
    try {
        const message = String(req.body.message || "").trim();
        const recipient = resolveLineRecipient(req.body.recipient, isDemoContext());
        if (!message) return res.status(400).json({ error: "訊息不能空白" });
        await sendLineFlexMessage(recipient.userId, `💬 即時助理醒給${recipient.label}`, message, "#b59f86");
        res.json({ success: true });
    } catch (err) {
        console.error("❌ LINE 即時推播失敗:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 📈 股票即時看盤價大對接
app.post("/api/stocks/update-market-prices", async (req, res) => {
    try {
        console.log("🚀 正在更新台股行情...");
        const currentStocks = await all("SELECT DISTINCT stock_code FROM stocks");
        if (currentStocks.length === 0) {
            return res.json({ success: true, updated: 0 });
        }

        const stockCodes = currentStocks
            .map(s => ({
                stockCode: s.stock_code,
                twseCode: toTwseStockCode(s.stock_code)
            }))
            .filter(s => s.twseCode);

        if (stockCodes.length === 0) {
            return res.json({ success: true, updated: 0, skipped: currentStocks.length });
        }

        let priceMap = {};
        const usedSources = [];

        try {
            const fugleMap = await fetchFugleRealtimePrices(stockCodes);
            if (Object.keys(fugleMap).length > 0) {
                priceMap = { ...priceMap, ...fugleMap };
                usedSources.push("Fugle 富果即時行情");
            }
        } catch (err) {
            console.warn("⚠️ Fugle 富果行情未使用，改用 TWSE 備援:", err.message);
        }

        let missingStockCodes = stockCodes.filter(s => !priceMap[s.twseCode]);
        try {
            if (missingStockCodes.length > 0) {
                const twseMap = await fetchTwseRealtimePrices(missingStockCodes);
                if (Object.keys(twseMap).length > 0) {
                    priceMap = { ...priceMap, ...twseMap };
                    usedSources.push("TWSE MIS 看盤價");
                }
            }
        } catch (err) {
            console.warn("⚠️ TWSE MIS 看盤價讀取失敗，改用最新收盤價:", err.message);
        }

        missingStockCodes = stockCodes.filter(s => !priceMap[s.twseCode]);
        if (missingStockCodes.length > 0) {
            const closingMap = await fetchTwseClosingPrices();
            let closingCount = 0;
            missingStockCodes.forEach(s => {
                if (closingMap[s.twseCode]) {
                    priceMap[s.twseCode] = closingMap[s.twseCode];
                    closingCount++;
                }
            });
            if (closingCount > 0) usedSources.push("TWSE 最新收盤價");
        }

        let nameMap = {};
        try {
            nameMap = await fetchTwseStockNames();
        } catch (err) {
            console.warn("⚠️ TWSE 股票中文名稱讀取失敗:", err.message);
        }

        await run("BEGIN TRANSACTION");
        let updateCount = 0;
        for (let s of stockCodes) {
            const quote = priceMap[s.twseCode];
            if (quote) {
                const stockName = quote.name || nameMap[s.twseCode] || lookupStockName(s.stockCode);
                await run(`
                    UPDATE stocks 
                    SET market_price = ?, stock_name = COALESCE(NULLIF(?, ''), stock_name), market_price_source = ?, market_price_date = ?, market_price_time = ?
                    WHERE stock_code = ?
                `, [quote.price, stockName, quote.source, quote.quoteDate, quote.quoteTime, s.stockCode]);
                updateCount++;
            }
        }
        await run("COMMIT");
        const source = [...new Set(usedSources)].join(" / ") || "無可用行情來源";
        console.log(`✨ 成功幫妳把 ${updateCount} 檔持股更新到 ${source}！`);
        res.json({ success: true, updated: updateCount, skipped: currentStocks.length - stockCodes.length, source });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        console.error("❌ 台股行情更新失敗:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 🏦 帳戶管理 API
app.post("/api/accounts", async (req, res) => {
    try {
        const { name, type, balance = 0 } = req.body;
        let mappedType = type;
        if (type.includes("信用卡")) mappedType = "信用卡";
        else if (type.includes("現金")) mappedType = "身上現金";
        if (type.includes("銀行") || type.includes("戶頭")) mappedType = "銀行戶頭";
        if (type.includes("證券") || type.includes("投資")) mappedType = "證券投資";

        const result = await run("INSERT INTO accounts (name, type, balance) VALUES (?, ?, ?)", [name, mappedType, Number(balance)]);
        res.status(201).json({ id: result.lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/accounts", async (req, res) => {
    try {
        res.json(await all("SELECT * FROM accounts ORDER BY type, id DESC"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/accounts/:id", async (req, res) => {
    try {
        await run("UPDATE accounts SET name = ?, balance = ? WHERE id = ?", [req.body.name, Number(req.body.balance), req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/accounts/:id", async (req, res) => {
    try {
        await run("PRAGMA foreign_keys = ON");
        await run("DELETE FROM accounts WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 📜 全域歷史明細
app.get("/api/global-history", async (req, res) => {
    try {
        const txs = await all(`
            SELECT id, 'transaction' as r_type, account_id, type, category, amount, date, memo,
                   (SELECT name FROM accounts WHERE id=account_id) as account_name,
                   IFNULL((SELECT GROUP_CONCAT(tag) FROM transaction_tags WHERE source_type='transaction' AND source_id=transactions.id), '') as tags
            FROM transactions
        `);
        const tfOut = await all(`
            SELECT t.id, 'transfer_out' as r_type, t.from_account_id as account_id, '轉出' as type, a2.name as category, t.amount, t.date, t.memo,
                   a1.name as account_name,
                   IFNULL((SELECT GROUP_CONCAT(tag) FROM transaction_tags WHERE source_type='transfer' AND source_id=t.id), '') as tags
            FROM transfers t
            JOIN accounts a1 ON t.from_account_id = a1.id
            JOIN accounts a2 ON t.to_account_id = a2.id
        `);
        const tfIn = await all(`
            SELECT t.id, 'transfer_in' as r_type, t.to_account_id as account_id, '轉入' as type, a1.name as category, t.amount, t.date, t.memo,
                   a2.name as account_name,
                   IFNULL((SELECT GROUP_CONCAT(tag) FROM transaction_tags WHERE source_type='transfer' AND source_id=t.id), '') as tags
            FROM transfers t
            JOIN accounts a1 ON t.from_account_id = a1.id
            JOIN accounts a2 ON t.to_account_id = a2.id
        `);

        const history = [...txs, ...tfOut, ...tfIn].sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/tags", async (req, res) => {
    try {
        const rows = await all("SELECT DISTINCT tag FROM transaction_tags WHERE tag NOT LIKE '買入 %' AND tag NOT LIKE '賣出 %' ORDER BY tag");
        res.json(rows.map(row => row.tag));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 💸 交易收支 API
app.post("/api/transactions", async (req, res) => {
    try {
        const { account_id, type, category, amount, date, memo } = req.body;
        await run("BEGIN TRANSACTION");
        const result = await run("INSERT INTO transactions (account_id, type, category, amount, date, memo) VALUES (?, ?, ?, ?, ?, ?)", [account_id, type, category, Number(amount), date, memo]);
        await syncTagsForRecord("transaction", result.lastID, memo);
        await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [type === "收入" ? Number(amount) : -Number(amount), account_id]);
        await run("COMMIT");
        res.status(201).json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 🔄 帳戶轉帳 API
app.post("/api/transfers", async (req, res) => {
    try {
        const { from_account_id, to_account_id, amount, date, memo } = req.body;
        if (from_account_id === to_account_id) return res.status(400).json({ error: "不能轉帳給同一個帳戶" });

        await run("BEGIN TRANSACTION");
        const result = await run("INSERT INTO transfers (from_account_id, to_account_id, amount, date, memo) VALUES (?, ?, ?, ?, ?)", [from_account_id, to_account_id, Number(amount), date, memo]);
        await syncTagsForRecord("transfer", result.lastID, memo);
        await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [Number(amount), from_account_id]);
        await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [Number(amount), to_account_id]);
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 📈 股票倉位 API
app.post("/api/stocks", async (req, res) => {
    try {
        const { account_id, stock_code, type, shares, price, total_cost, date } = req.body;
        const normalizedStockCode = String(stock_code || "").trim().toUpperCase();
        const qty = Number(shares);
        const totalAmount = Math.round(Number(total_cost));
        const inputPrice = Number(price);
        const inputCost = totalAmount / qty;
        const targetDate = date || new Date().toISOString().slice(0, 10);
        const fallbackStockName = lookupStockName(normalizedStockCode);

        if (!normalizedStockCode) return res.status(400).json({ error: "請輸入投資標的代號" });

        await run("BEGIN TRANSACTION");
        const rows = await all("SELECT * FROM stocks WHERE account_id = ? AND stock_code = ?", [account_id, normalizedStockCode]);
        const stock = rows[0];
        let stockId = stock ? stock.id : null;

        if (type === "買進") {
            if (stock) {
                const nextShares = stock.shares + qty;
                const nextCost = ((stock.shares * stock.cost) + totalAmount) / nextShares;
                await run("UPDATE stocks SET shares = ?, cost = ?, stock_name = COALESCE(NULLIF(stock_name, ''), ?), date = ? WHERE id = ?", [nextShares, nextCost, fallbackStockName, targetDate, stock.id]);
            } else {
                const insRes = await run("INSERT INTO stocks (account_id, stock_code, stock_name, shares, cost, market_price, date) VALUES (?, ?, ?, ?, ?, ?, ?)", [account_id, normalizedStockCode, fallbackStockName, qty, inputCost, inputPrice, targetDate]);
                stockId = insRes.lastID;
            }
            await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [totalAmount, account_id]);
            await run("INSERT INTO transactions (account_id, type, category, amount, date, memo, stock_ref_id) VALUES (?, '支出', '投資出款', ?, ?, ?, ?)", [account_id, totalAmount, targetDate, `買入 ${normalizedStockCode} (${qty}股/單價${price})`, stockId]);
        } else {
            if (!stock || stock.shares < qty) {
                await run("ROLLBACK");
                return res.status(400).json({ error: "持股庫存不足" });
            }
            if (stock.shares === qty) {
                await run("DELETE FROM stocks WHERE id = ?", [stock.id]);
            } else {
                await run("UPDATE stocks SET shares = ?, date = ? WHERE id = ?", [stock.shares - qty, targetDate, stock.id]);
            }
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [totalAmount, account_id]);
            await run("INSERT INTO transactions (account_id, type, category, amount, date, memo, stock_ref_id) VALUES (?, '收入', '投資獲利', ?, ?, ?, ?)", [account_id, totalAmount, targetDate, `賣出 ${normalizedStockCode} (${qty}股/單價${price})`, stock.id]);
        }
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 📜 歷史帳目修改 API
app.put("/api/history/:r_type/:id", async (req, res) => {
    try {
        const { r_type, id } = req.params;
        const { date, category, memo, amount, account_id } = req.body;
        const newAmt = Number(amount);
        const nextAccountId = Number(account_id);

        await run("BEGIN TRANSACTION");
        if (r_type === 'transaction') {
            const old = (await all("SELECT * FROM transactions WHERE id = ?", [id]))[0];
            if (!old) {
                await run("ROLLBACK");
                return res.status(404).json({ error: "找不到這筆流水帳" });
            }
            const targetAccountId = Number.isFinite(nextAccountId) && nextAccountId > 0 ? nextAccountId : old.account_id;
            const targetAccount = (await all("SELECT id FROM accounts WHERE id = ?", [targetAccountId]))[0];
            if (!targetAccount) {
                await run("ROLLBACK");
                return res.status(400).json({ error: "找不到要改成的帳戶" });
            }

            const oldDiff = old.type === "收入" ? -old.amount : old.amount;
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [oldDiff, old.account_id]);

            const newDiff = old.type === "收入" ? newAmt : -newAmt;
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [newDiff, targetAccountId]);
            await run("UPDATE transactions SET account_id=?, date=?, category=?, memo=?, amount=? WHERE id=?", [targetAccountId, date, category, memo, newAmt, id]);
            await syncTagsForRecord("transaction", id, memo);
            if (old.stock_ref_id) await rebuildStockPosition(old.stock_ref_id);
        } else {
            const old = (await all("SELECT * FROM transfers WHERE id = ?", [id]))[0];
            if (!old) {
                await run("ROLLBACK");
                return res.status(404).json({ error: "找不到這筆轉帳紀錄" });
            }
            const nextFromAccountId = r_type === "transfer_out" && Number.isFinite(nextAccountId) && nextAccountId > 0
                ? nextAccountId
                : old.from_account_id;
            const nextToAccountId = r_type === "transfer_in" && Number.isFinite(nextAccountId) && nextAccountId > 0
                ? nextAccountId
                : old.to_account_id;
            if (nextFromAccountId === nextToAccountId) {
                await run("ROLLBACK");
                return res.status(400).json({ error: "轉出與轉入帳戶不能相同" });
            }
            const transferAccounts = await all("SELECT id FROM accounts WHERE id IN (?, ?)", [nextFromAccountId, nextToAccountId]);
            if (transferAccounts.length < 2) {
                await run("ROLLBACK");
                return res.status(400).json({ error: "找不到要改成的帳戶" });
            }

            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [old.amount, old.from_account_id]);
            await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [old.amount, old.to_account_id]);

            await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [newAmt, nextFromAccountId]);
            await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [newAmt, nextToAccountId]);
            await run("UPDATE transfers SET from_account_id=?, to_account_id=?, date=?, memo=?, amount=? WHERE id=?", [nextFromAccountId, nextToAccountId, date, memo, newAmt, id]);
            await syncTagsForRecord("transfer", id, memo);
        }
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

// 🗑️ 歷史帳目銷毀與餘額回溯 API
app.delete("/api/history/:r_type/:id", async (req, res) => {
    try {
        const { r_type, id } = req.params;
        await run("BEGIN TRANSACTION");
        if (r_type === 'transaction') {
            const old = (await all("SELECT * FROM transactions WHERE id = ?", [id]))[0];
            if (old) {
                const stockSnapshot = old.stock_ref_id ? (await all("SELECT * FROM stocks WHERE id = ?", [old.stock_ref_id]))[0] : null;
                const diff = old.type === "收入" ? -old.amount : old.amount;
                await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [diff, old.account_id]);
                await run("DELETE FROM transactions WHERE id = ?", [id]);
                await run("DELETE FROM transaction_tags WHERE source_type = ? AND source_id = ?", ["transaction", id]);
                if (old.stock_ref_id) await rebuildStockPosition(old.stock_ref_id, stockSnapshot);
            }
        } else {
            const old = (await all("SELECT * FROM transfers WHERE id = ?", [id]))[0];
            if (old) {
                await run("UPDATE accounts SET balance = balance + ? WHERE id = ?", [old.amount, old.from_account_id]);
                await run("UPDATE accounts SET balance = balance - ? WHERE id = ?", [old.amount, old.to_account_id]);
                await run("DELETE FROM transfers WHERE id = ?", [id]);
                await run("DELETE FROM transaction_tags WHERE source_type = ? AND source_id = ?", ["transfer", id]);
            }
        }
        await run("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await run("ROLLBACK").catch(()=>{});
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/stocks", async (req, res) => {
    try {
        res.json(await all(`
            SELECT
                MIN(s.id) AS id,
                MIN(s.account_id) AS account_id,
                s.stock_code,
                COALESCE(MAX(NULLIF(s.stock_name, '')), '') AS stock_name,
                SUM(s.shares) AS shares,
                CASE
                    WHEN SUM(s.shares) > 0 THEN SUM(s.shares * s.cost) / SUM(s.shares)
                    ELSE 0
                END AS cost,
                COALESCE(MAX(s.market_price), 0) AS market_price,
                MAX(s.market_price_date) AS market_price_date,
                MAX(s.market_price_source) AS market_price_source,
                MAX(s.market_price_time) AS market_price_time,
                MAX(s.date) AS date,
                GROUP_CONCAT(DISTINCT a.name) AS account_name
            FROM stocks s
            JOIN accounts a ON s.account_id = a.id
            GROUP BY s.stock_code
            ORDER BY s.stock_code
        `));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/stocks/intraday-charts", async (req, res) => {
    try {
        if (!FUGLE_API_KEY) {
            return res.status(400).json({ error: "尚未設定 FUGLE_API_KEY，無法讀取 Fugle 分時圖" });
        }

        const holdings = await all(`
            SELECT stock_code, COALESCE(MAX(stock_name), '') AS stock_name
            FROM stocks
            GROUP BY stock_code
            ORDER BY stock_code
        `);
        const stockCodes = holdings.map(s => ({
            stockCode: s.stock_code,
            stockName: s.stock_name,
            twseCode: toTwseStockCode(s.stock_code)
        }));
        const tradableStocks = stockCodes.filter(s => s.twseCode);
        const skipped = stockCodes
            .filter(s => !s.twseCode)
            .map(s => ({ symbol: s.stockCode, name: s.stockName || lookupStockName(s.stockCode) }));

        const charts = await Promise.all(tradableStocks.map(async stock => {
            try {
                return await fetchFugleIntradayCandles(stock);
            } catch (err) {
                return {
                    symbol: stock.stockCode,
                    name: stock.stockName || lookupStockName(stock.stockCode),
                    date: taipeiDateString(),
                    source: "Fugle 富果 1分K",
                    data: [],
                    error: err.message
                };
            }
        }));

        res.json({ success: true, charts, skipped });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(["/webhook/line", "/api/webhook"], (req, res) => {
    res.json({
        ok: true,
        message: "LINE webhook endpoint is ready. Set LINE Developers Webhook URL to this URL and send POST events here.",
        paths: ["/webhook/line", "/api/webhook"]
    });
});
app.post(["/webhook/line", "/api/webhook"], handleLineWebhook);

app.listen(PORT, () => {
    console.log(`🎉 旗艦完全體大腦已在 Port ${PORT} 完美開機！`);
    console.log(`🔗 LINE Webhook ready: /webhook/line 或 /api/webhook`);
});
