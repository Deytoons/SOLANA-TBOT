require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const bs58 = require('bs58');
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');

// === Database Setup (db_2.json) ===
const DB_FILE = path.join(__dirname, 'db.json');
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = { users: [], trades: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  const data = fs.readFileSync(DB_FILE);
  return JSON.parse(data);
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function getUser(telegramId) {
  const db = loadDB();
  return db.users.find(u => u.telegramId === telegramId);
}
function upsertUser(user) {
  const db = loadDB();
  user.lastActive = new Date().toISOString();
  const index = db.users.findIndex(u => u.telegramId === user.telegramId);
  if (index === -1) {
    db.users.push(user);
  } else {
    db.users[index] = user;
  }
  saveDB(db);
  return user;
}
function addTrade(trade) {
  const db = loadDB();
  db.trades.push(trade);
  saveDB(db);
  return trade; 
}
function getTrades(telegramId, limit = 10) {
  const db = loadDB();
  return db.trades
    .filter(t => t.telegramId === telegramId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
}

// === Puppeteer Wallet Creation Function ===
// (Remains unchanged)

async function createWalletViaPuppeteer() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
      
  try {
    const page = await browser.newPage();
    await page.goto('https://pumpportal.fun/trading-api/setup', {
      waitUntil: 'networkidle0'
    });
    await page.waitForSelector('#wallet-button', { timeout: 10000 });
    await page.click('#wallet-button');
    console.log("Clicked wallet creation button.");
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.waitForSelector('#wallet-address', { timeout: 10000 });
    const walletAddress = await page.evaluate(() => {
      const elem = document.getElementById('wallet-address');
      return elem ? elem.innerText.trim() : null;
    });
    await page.waitForSelector('#private-key', { timeout: 10000 });
    const privateKey = await page.evaluate(() => {
      const elem = document.getElementById('private-key');
      return elem ? elem.innerText.trim() : null;
    });
    await page.waitForSelector('#api-key', { timeout: 10000 });
    const apiKey = await page.evaluate(() => {
      const elem = document.getElementById('api-key');
      return elem ? elem.innerText.trim() : null;
    });
    return {
      wallet: {
        address: walletAddress,
        privateKey: privateKey
      },
      apiKey: apiKey
    };
  } catch (error) {
    console.error("Error extracting wallet data via Puppeteer:", error);
    throw error;
  } finally {
    await browser.close();
  }
}

// === Fee Transaction Function ===
async function sendFeeTransaction(user, feeInSOL, connection) {
  // Use the user’s wallet private key (Base58 encoded)
  const privateKeyBase58 = user.wallet.privateKey;
  
  // Decode the secret key using bs58 (handles both default and non-default export)
  const secretKeyUint8Array = bs58.default 
    ? bs58.default.decode(privateKeyBase58) 
    : bs58.decode(privateKeyBase58);
  
  // Create the keypair from the secret key
  const senderKeypair = web3.Keypair.fromSecretKey(secretKeyUint8Array);
  
  // Define the fee receiver address (destination)
  const feeAddress = '52rG3pPMbZETgbdfvdF69BoYLQF1zeFKrfkUdJvG5iV4';
  const receiverPublicKey = new web3.PublicKey(feeAddress);
  
  // Convert fee in SOL to lamports (1 SOL = 1e9 lamports)
  const feeLamports = Math.round(feeInSOL * web3.LAMPORTS_PER_SOL);
  
  // Create a transaction with a transfer instruction
  const transaction = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: senderKeypair.publicKey,
      toPubkey: receiverPublicKey,
      lamports: feeLamports,
    })
  );
  
  // Sign and send the transaction using the sender's keypair
  const signature = await web3.sendAndConfirmTransaction(
    connection,
    transaction,
    [senderKeypair]
  );
  
  return signature;
}


// === Telegram Bot & Solana Setup ===
const pumpPortalApiKey = process.env.PUMP_PORTAL_API_KEY;
const telegramToken = process.env.MR_TOMISIN_TELEGRAM_BOT_TOKEN;
const solanaRpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const tradeFeePercent = process.env.TRADE_FEE_PERCENT || 0.25;

const bot = new TelegramBot(telegramToken, { polling: true });
const connection = new Connection(solanaRpcUrl);

// In-memory session storage.
const userSessions = {};
const BOT_STATES = {
  IDLE: 0,
  AWAITING_AMOUNT: 1,
  AWAITING_MARKET_CAP: 2,
  MONITORING: 3 
};
// Use an object to store timeout IDs (for dynamic intervals).
const monitoringIntervals = {};

// === Helper Message ===
const HELP_MESSAGE = `
🤖 *Market Cap Trader Bot Help*

*Commands:*
• /start - Initialize your profile. A wallet and API key will be created for you.
• /help - Show this help message.
• /myAddy - Get your wallet (public) address so you can fund it.
• /myPKey - Get your wallet's private key.
• /tradehistory - Show your recent trades (including final market cap for completed trades).
• /status - Check current active trade monitoring (refreshes current market cap).
• /cancel - Cancel the current trade.
• /confirm - Execute a buy order with the entered trade details.

*Workflow:*
1. Send /start. A wallet and API key will be created for you via Pump Portal’s setup page.
2. Fund your wallet using the address from /myAddy.
3. Send a valid Solana token address (44 characters) to begin a trade.
4. Provide the SOL amount you wish to spend.
5. Enter the target market cap (e.g. "250000" or "245k") at which you want to sell.
6. Confirm with /confirm to execute the trade.
7. The bot will monitor market cap (refreshing every few seconds), and when your target is reached, it automatically sells.
8. Love the bot? Send a tip (SOL) to:
\`\`\`
52rG3pPMbZETgbdfvdF69BoYLQF1zeFKrfkUdJvG5iV4
\`\`\`
`;

// === Bot Command Handlers ===

// /start - Create user profile and wallet.
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();
  let user = getUser(chatId);
  if (!user) {
    try {
      const data = await createWalletViaPuppeteer();
      user = {
        telegramId: chatId,
        wallet: { 
          address: data.wallet.address,
          privateKey: data.wallet.privateKey
        },
        apiKey: data.apiKey,
        username: msg.from.username || "",
        lastActive: new Date().toISOString()
      };
      upsertUser(user);
      bot.sendMessage(chatId,
`🚀 *Welcome to Market Cap Trader Bot!*

A new wallet has been created for you.

*Wallet Address:* \`\`\`
${user.wallet.address}
\`\`\`

*API Key:* \`\`\`
${user.wallet.privateKey}
\`\`\`

Fund your wallet using the above address.
Send me a valid Solana token address to start a new trade.
Type /help for further instructions.`, { parse_mode: "Markdown" });
    } catch (error) {
      console.error("Error during wallet setup:", error);
      bot.sendMessage(chatId, "❌ Error creating wallet. Please try again later.");
    }
  } else {
    upsertUser(user);
    bot.sendMessage(chatId, "🚀 *Welcome back!* Send me a valid Solana token address to start a new trade.\nType /help for instructions.", { parse_mode: "Markdown" });
  }
});

// /help - Display instructions.
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id.toString();
  bot.sendMessage(chatId, HELP_MESSAGE, { parse_mode: "Markdown" });
});

// /myAddy - Show wallet public address.
bot.onText(/\/myAddy/, (msg) => {
  const chatId = msg.chat.id.toString();
  const user = getUser(chatId);
  if (!user || !user.wallet || !user.wallet.address) {
    bot.sendMessage(chatId, "❌ Wallet not set up. Please use /start to create your wallet.");
    return;
  }
  bot.sendMessage(chatId, `*Your wallet address is:*\n\`\`\`
${user.wallet.address}
\`\`\``, { parse_mode: "Markdown" });
});

// /myPKey - Show wallet private key.
bot.onText(/\/myPKey/, (msg) => {
  const chatId = msg.chat.id.toString();
  const user = getUser(chatId);
  if (!user || !user.wallet || !user.wallet.privateKey) {
    bot.sendMessage(chatId, "❌ Wallet not set up. Please use /start to create your wallet.");
    return;
  }
  bot.sendMessage(chatId, `*Your wallet private key is:*\n\`\`\`
${user.wallet.privateKey}
\`\`\``, { parse_mode: "Markdown" });
});

// /tradehistory - Show recent trades.
bot.onText(/\/tradehistory/, (msg) => {
  const chatId = msg.chat.id.toString();
  const trades = getTrades(chatId);
  if (!trades || trades.length === 0) {
    bot.sendMessage(chatId, "No trade history found.");
    return;
  }
  let response = "*Your recent trades:*";
  trades.forEach(trade => {
    response += `\n\n*Token:* ${trade.tokenSymbol || trade.tokenAddress}`;
    response += `\n*Buy Amount:* ${trade.buyAmount} SOL`;
    response += `\n*Target Market Cap:* $${formatNumber(trade.targetMarketCap)}`;
    if(trade.finalMarketCap)
      response += `\n*Final Market Cap:* $${formatNumber(trade.finalMarketCap)}`;
    response += `\n*Status:* ${trade.status}`;
    response += `\n*Date:* ${new Date(trade.timestamp).toLocaleString()}`;
  });
  bot.sendMessage(chatId, response, { parse_mode: "Markdown" });
});

// /status - Display current trade monitoring info with fresh data
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const session = userSessions[chatId];
  if (!session || session.state !== BOT_STATES.MONITORING) {
    bot.sendMessage(chatId, "No active monitoring session.");
    return;
  }
  try {
    const user = getUser(chatId);
    const [tokenInfo, balance] = await Promise.all([
      getTokenInfo(session.tokenAddress),
      getTokenBalance(user.wallet.address, session.tokenAddress)
    ]);
    
    const currentMarketCap = tokenInfo.marketCap;
    const balanceUSD = (balance * tokenInfo.price).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD'
    });

    bot.sendMessage(chatId, 
      `📊 *Current Monitoring:*\n` +
      `*Token:* ${session.tokenSymbol || session.tokenAddress}\n` +
      `*Balance:* ${balance?.toFixed(2) || 'Unknown'} (${balanceUSD})\n` +
      `*Bought:* ${session.buyAmount} SOL\n` +
      `*Target Market Cap:* $${formatNumber(session.targetMarketCap)}\n` +
      `*Current Market Cap:* $${formatNumber(currentMarketCap)}\n` +
      `*Price:* $${tokenInfo.price.toFixed(4)}\n` +
      `*Status:* Actively monitoring...`, { parse_mode: "Markdown" });
  } catch(e) {
    bot.sendMessage(chatId, "Error retrieving current market data.");
  }
});

// === Trade Flow (Non-command messages) ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (text?.startsWith('/') || !text) return;

  if (!userSessions[chatId]) {
    userSessions[chatId] = {
      state: BOT_STATES.IDLE,
      tokenAddress: null,
      tokenSymbol: null,
      buyAmount: null,
      targetMarketCap: null,
      buyTx: null,
      tokenAmount: null
    };
  }
  const session = userSessions[chatId];

  if (session.state === BOT_STATES.IDLE && text.length === 44) {
    try {
      new PublicKey(text);
      session.tokenAddress = text;
      session.state = BOT_STATES.AWAITING_AMOUNT;
      try {
        const tokenInfo = await getTokenInfo(text);
        session.tokenSymbol = tokenInfo.symbol || 'Unknown';
        // Get formatted market cap
        const formattedMarketCap = `$${formatNumber(tokenInfo.marketCap)}`;
        
        bot.sendMessage(chatId, 
          `✅ Token detected!\n\n` +
          `*Symbol:* ${session.tokenSymbol}\n` +
          `*Current Market Cap:* ${formattedMarketCap}\n\n` +
          `How much SOL do you want to spend on this trade?`,
          { parse_mode: "Markdown" }
        );
        // bot.sendMessage(chatId, `Token detected: ${session.tokenSymbol}\nHow much SOL do you want to spend on this trade?`);
      } catch {
        bot.sendMessage(chatId, "How much SOL do you want to spend on this trade?");
      }
    } catch (e) {
      bot.sendMessage(chatId, "⚠️ That doesn't look like a valid Solana address. Please try again.");
    }
  }
  else if (session.state === BOT_STATES.AWAITING_AMOUNT) {
    const amount = parseFloat(text);
    if (isNaN(amount)) {
      bot.sendMessage(chatId, "Please enter a valid number (e.g., 0.1 or 1.5).");
      return;
    }
    if (amount <= 0) {
      bot.sendMessage(chatId, "Amount must be greater than 0.");
      return;
    }
    session.buyAmount = amount;
    session.state = BOT_STATES.AWAITING_MARKET_CAP;
    bot.sendMessage(chatId, "At what market cap (in USD) should I sell the tokens?\nFor example: \"250000\" or \"245k\"");
  }
  else if (session.state === BOT_STATES.AWAITING_MARKET_CAP) {
    let marketCap = parseMarketCapInput(text);
    if (marketCap === null || marketCap <= 0) {
      bot.sendMessage(chatId, "Please enter a valid positive market cap (e.g., 250000 or 245k).");
      return;
    }
    session.targetMarketCap = marketCap;
    bot.sendMessage(chatId, 
      `📋 *Trade Details:*\n` +
      `*Token:* ${session.tokenSymbol || session.tokenAddress}\n` +
      `*Buy Amount:* ${session.buyAmount} SOL\n` +
      `*Sell Target:* $${formatNumber(session.targetMarketCap)} market cap\n\n` +
      `Type /confirm to proceed or /cancel to abort.`, { parse_mode: "Markdown" });
  }
});

// /confirm - Execute the buy order.
bot.onText(/\/confirm/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const session = userSessions[chatId];
  if (!session || session.state !== BOT_STATES.AWAITING_MARKET_CAP) {
    bot.sendMessage(chatId, "No pending trade to confirm.");
    return;
  }
  const user = getUser(chatId);
  if (!user || !user.apiKey || !user.wallet || !user.wallet.address) {
    bot.sendMessage(chatId, "❌ Wallet not set up correctly. Please use /start to create your wallet.");
    return;
  }  
  try {
    bot.sendMessage(chatId, "🔄 Executing buy order...");
    const buyResponse = await fetch(`https://pumpportal.fun/api/trade?api-key=${user.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "buy",
        mint: session.tokenAddress,
        amount: session.buyAmount,
        denominatedInSol: "true",
        slippage: 10,
        priorityFee: 0.00005,
        pool: "auto"
      })
    });
    const buyData = await buyResponse.json();
    if (buyData.error) throw new Error(buyData.error);
    session.buyTx = buyData.signature;
    session.state = BOT_STATES.MONITORING;
    
    // Calculate approximate token amount purchased.
    try {
      const tokenInfo = await getTokenInfo(session.tokenAddress);
      const solPrice = await getSOLPrice();
      const approxTokens = session.buyAmount * solPrice / tokenInfo.price;
      session.tokenAmount = approxTokens;
    } catch (e) {
      console.error("Couldn't calculate token amount:", e);
    }
    
    addTrade({
      telegramId: chatId,
      tokenAddress: session.tokenAddress,
      tokenSymbol: session.tokenSymbol || session.tokenAddress,
      buyAmount: session.buyAmount,
      targetMarketCap: session.targetMarketCap,
      buyTx: session.buyTx,
      tokenAmount: session.tokenAmount,
      status: 'pending',
      timestamp: new Date().toISOString()
    });
    
    bot.sendMessage(chatId, 
      `✅ Buy order executed!\n*Token:* ${session.tokenSymbol || session.tokenAddress}\n*Amount:* ~${session.tokenAmount ? formatNumber(session.tokenAmount) : 'unknown'} tokens\n*TX:* [View on Solscan](https://solscan.io/tx/${session.buyTx})\n\nNow monitoring market cap. I'll sell when it reaches $${formatNumber(session.targetMarketCap)}.`, { parse_mode: "Markdown" });
    
    startMarketCapMonitoring(chatId, session);
  } catch (error) {
    console.error(error);
    bot.sendMessage(chatId, `❌ Error executing trade: ${error.message}`);
    resetSession(chatId);
  }
});

// /cancel - Cancel the current trade.
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id.toString();
  resetSession(chatId);
  bot.sendMessage(chatId, "Trade cancelled. Send a new token address to start again.");
});

// === Add Token Balance Check Function ===
async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const connection = new Connection(solanaRpcUrl);
    const publicKey = new PublicKey(walletAddress);
    const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, { mint: new PublicKey(tokenMint) });

    if (tokenAccounts.value.length === 0) return 0;
    
    const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
    return Number(balance.value.amount) / Math.pow(10, balance.value.decimals);
  } catch (error) {
    console.error("Balance check error:", error);
    return null;
  }
}

// === Updated Monitoring & Sell Order Execution ===

// Helper: Calculate a dynamic interval (smart cooldown) based on how close we are to the target.
function getMonitoringInterval(current, target) {
  const diff = target - current;
  if (diff <= target * 0.1) {
    return 2000;  // When within 10% of the target, check every 2 seconds.
  }
  return 5000;    // Otherwise, default to every 5 seconds.
}

// Updated monitoring function using recursive setTimeout for dynamic intervals.
function startMarketCapMonitoring(chatId, session) {
  // Clear any previous timeout.
  if (monitoringIntervals[chatId]) {
    clearTimeout(monitoringIntervals[chatId]);
  }
  
  async function monitor() {
    try {
      const tokenInfo = await getTokenInfo(session.tokenAddress);
      const currentMarketCap = tokenInfo.marketCap;
      console.log(`Checking ${session.tokenSymbol || session.tokenAddress}: $${formatNumber(currentMarketCap)} / $${formatNumber(session.targetMarketCap)}`);
      
      if (currentMarketCap >= session.targetMarketCap) {
        bot.sendMessage(chatId, 
          `🎯 Target market cap reached!\n*Current:* $${formatNumber(currentMarketCap)}\n*Target:* $${formatNumber(session.targetMarketCap)}\n\nExecuting sell order...`, { parse_mode: "Markdown" });
        
        const user = getUser(chatId);
        // Execute sell order.
        const sellResponse = await fetch(`https://pumpportal.fun/api/trade?api-key=${user.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sell",
            mint: session.tokenAddress,
            amount: '100%',
            denominatedInSol: session.tokenAmount ? "false" : "true",
            slippage: 10,
            priorityFee: 0.00005,
            pool: "auto"
          })
        });
        const sellData = await sellResponse.json();
        if (sellData.error) throw new Error(sellData.error);
        
        // Get current SOL price.
        const solPrice = await getSOLPrice();
        // Approximate sale proceeds in USD.
        const saleProceedsUSD = session.tokenAmount ? session.tokenAmount * tokenInfo.price : 0;
        // Calculate fee in USD.
        const feeUSD = saleProceedsUSD * (tradeFeePercent / 100);
        // Convert fee from USD to SOL.
        const feeSOL = feeUSD / solPrice;
        
        // Send fee transaction.
        let feeTx;
        try {
          feeTx = await sendFeeTransaction(user, feeSOL, connection);
          console.log(`Fee transaction sent: ${feeTx}`);
        } catch (feeError) {
          console.error("Error sending fee transaction:", feeError);
          feeTx = "Fee transaction failed";
        }
        
        // Update trade record.
        const db = loadDB();
        db.trades = db.trades.map(trade => {
          if (trade.buyTx === session.buyTx) {
            trade.status = 'completed';
            trade.finalMarketCap = currentMarketCap;
          }
          return trade;
        });
        saveDB(db);
        
        bot.sendMessage(chatId, 
          `✅ Sell order executed!\n*TX:* [View on Solscan](https://solscan.io/tx/${sellData.signature})\n\nTrade completed successfully!`, { parse_mode: "Markdown" });
          
        // Clear timeout and reset session.
        clearTimeout(monitoringIntervals[chatId]);
        delete monitoringIntervals[chatId];
        resetSession(chatId);
      } else {
        // Schedule the next check using the dynamic interval.
        const nextInterval = getMonitoringInterval(currentMarketCap, session.targetMarketCap);
        monitoringIntervals[chatId] = setTimeout(monitor, nextInterval);
      }
    } catch (error) {
      console.error(`Monitoring error for chat ${chatId}:`, error);
      bot.sendMessage(chatId, `⚠️ Monitoring error: ${error.message}`);
      resetSession(chatId);
    }
  }
  
  // Start monitoring immediately.
  monitor();
}

function resetSession(chatId) {
  if (monitoringIntervals[chatId]) {
    clearTimeout(monitoringIntervals[chatId]);
    delete monitoringIntervals[chatId];
  }
  userSessions[chatId] = {
    state: BOT_STATES.IDLE,
    tokenAddress: null,
    tokenSymbol: null,
    buyAmount: null,
    targetMarketCap: null,
    buyTx: null,
    tokenAmount: null
  };
}

// === Helper Functions ===

// Parse market cap input (supports "k" and "m" suffixes)
function parseMarketCapInput(input) {
  input = input.trim().toLowerCase();
  if (input.endsWith('k')) {
    const num = parseFloat(input.slice(0, -1));
    return isNaN(num) ? null : num * 1000;
  }
  if (input.endsWith('m')) {
    const num = parseFloat(input.slice(0, -1));
    return isNaN(num) ? null : num * 1000000;
  }
  const num = parseFloat(input.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

// Update the formatNumber function to handle decimals better:
function formatNumber(num) {
  if (typeof num !== 'number') return 'N/A';
  return num.toLocaleString('en-US', { 
    maximumFractionDigits: 2,
    minimumFractionDigits: 0 
  }).replace(/\.00$/, '');
}

// Updated getTokenInfo function with no-cache headers and timestamp to ensure fresh data.
async function getTokenInfo(mintAddress) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}?t=${Date.now()}`;
  const response = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  const data = await response.json();
  if (!data.pairs || data.pairs.length === 0) {
    throw new Error("Token not found on DexScreener");
  }
  const pair = data.pairs[0];
  return {
    symbol: pair.baseToken.symbol,
    price: parseFloat(pair.priceUsd),
    marketCap: parseFloat(pair.fdv) || (parseFloat(pair.liquidity.usd) * 10)
  };
}

// // === Updated getTokenInfo Function with Birdeye API ===
// async function getTokenInfo(mintAddress) {
//     const apiKey = process.env.BIRDEYE_API_KEY;
//     const metaUrl = `https://public-api.birdeye.so/public/token_meta?address=${mintAddress}`;
//     const priceUrl = `https://public-api.birdeye.so/public/price?address=${mintAddress}`;

//     // Fetch token metadata
//     const metaResponse = await fetch(metaUrl, {
//         headers: { 'X-API-KEY': apiKey }
//     });
//     const metaData = await metaResponse.json();

//     if (!metaData.data || metaData.data.symbol === 'unknown') {
//         throw new Error("Token not found on Birdeye");
//     }

//     // Fetch token price
//     const priceResponse = await fetch(priceUrl, {
//         headers: { 'X-API-KEY': apiKey }
//     });
//     const priceData = await priceResponse.json();

//     if (!priceData.data?.value) {
//         throw new Error("Price data not available");
//     }

//     // Calculate market cap (FDV)
//     const decimals = metaData.data.decimals || 0;
//     const totalSupply = metaData.data.totalSupply || 0;
//     const totalSupplyAdjusted = totalSupply / Math.pow(10, decimals);
//     const marketCap = priceData.data.value * totalSupplyAdjusted;

//     return {
//         symbol: metaData.data.symbol,
//         price: priceData.data.value,
//         marketCap: marketCap
//     };
// }

async function getSOLPrice() {
  const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { headers: { "Cache-Control": "no-cache" } });
  const data = await response.json();
  return data.solana.usd;
}

console.log("Telegram bot is running...");
