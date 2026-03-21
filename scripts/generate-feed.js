#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const TWITTERAPI_BASE = 'https://api.twitterapi.io';
const TWEET_LOOKBACK_HOURS = 25;
const MAX_TWEETS_PER_USER = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {} };
  try { return JSON.parse(await readFile(STATE_PATH, 'utf-8')); }
  catch { return { seenTweets: {} }; }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  return JSON.parse(await readFile(join(SCRIPT_DIR, '..', 'config', 'default-sources.json'), 'utf-8'));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchXContent(xAccounts, apiKey, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  console.error(`  lookback 截止: ${cutoff.toISOString()}`);

  for (const account of xAccounts) {
    try {
      const res = await fetchWithTimeout(
        `${TWITTERAPI_BASE}/twitter/user/last_tweets?userName=${account.handle}&includeReplies=false`,
        { headers: { 'X-API-Key': apiKey } }
      );

      if (res.status === 429) {
        console.error(`  @${account.handle}: 429 速率限制，跳过`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (!res.ok) {
        errors.push(`@${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      if (account.handle === "karpathy") console.error("  @karpathy raw:", JSON.stringify(data).slice(0, 500));
      const allTweets = data.data?.tweets || data.tweets || [];

      // Debug：打印最新几条推文的时间
      if (allTweets.length > 0) {
        const latest = allTweets.slice(0, 2).map(t => t.createdAt).join(', ');
        console.error(`  @${account.handle}: ${allTweets.length} 条，最新: ${latest}`);
      } else {
        console.error(`  @${account.handle}: 0 条`);
      }

      const newTweets = [];
      for (const tweet of allTweets) {
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;
        if (new Date(tweet.createdAt) < cutoff) continue;
        if (state.seenTweets[tweet.id]) continue;
        if ((tweet.text || '').startsWith('RT @')) continue;

        newTweets.push({
          id: tweet.id,
          text: tweet.text || '',
          createdAt: tweet.createdAt,
          url: tweet.url || `https://x.com/${account.handle}/status/${tweet.id}`,
          likes: tweet.likeCount || 0,
          retweets: tweet.retweetCount || 0,
        });
        state.seenTweets[tweet.id] = Date.now();
      }

      if (newTweets.length > 0) {
        console.error(`    → ${newTweets.length} 条新推文`);
        results.push({ source: 'x', name: account.name, handle: account.handle, tweets: newTweets });
      }

      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      errors.push(`@${account.handle}: ${err.message}`);
    }
  }
  return results;
}

async function main() {
  const twitterApiKey = process.env.TWITTERAPI_IO_KEY;
  if (!twitterApiKey) { console.error('TWITTERAPI_IO_KEY not set'); process.exit(1); }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  console.error('=== 抓取 Twitter 内容 ===');
  const xContent = await fetchXContent(sources.x_accounts, twitterApiKey, state, errors);
  const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
  console.error(`结果: ${xContent.length} 个账号，${totalTweets} 条新推文`);

  await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent,
    stats: { xBuilders: xContent.length, totalTweets },
    errors: errors.length > 0 ? errors : undefined
  }, null, 2));

  // 写一个空的 feed-podcasts.json（run-and-email.js 读取时不报错）
  await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    podcasts: [],
    stats: { podcastEpisodes: 0 }
  }, null, 2));

  await saveState(state);

  if (errors.length > 0) {
    console.error(`=== ${errors.length} 个错误 ===`);
    errors.forEach(e => console.error('  -', e));
  }
}

main().catch(err => { console.error('运行失败:', err.message); process.exit(1); });
