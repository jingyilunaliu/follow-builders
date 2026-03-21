#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const TWITTERAPI_BASE = 'https://api.twitterapi.io';

// 每天运行一次，lookback 稍微多于 24 小时避免漏掉边缘时段
const TWEET_LOOKBACK_HOURS = 25;
// 播客更新频率低，72 小时内有新集就推送
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {}, seenVideos: {} };
  try { return JSON.parse(await readFile(STATE_PATH, 'utf-8')); }
  catch { return { seenTweets: {}, seenVideos: {} }; }
}

async function saveState(state) {
  // 只保留 7 天内的记录，防止文件无限增大
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) { if (ts < cutoff) delete state.seenTweets[id]; }
  for (const [id, ts] of Object.entries(state.seenVideos)) { if (ts < cutoff) delete state.seenVideos[id]; }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  return JSON.parse(await readFile(join(SCRIPT_DIR, '..', 'config', 'default-sources.json'), 'utf-8'));
}

// -- 抓推文 ------------------------------------------------------------------
async function fetchXContent(xAccounts, apiKey, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  console.error(`  Twitter lookback: ${TWEET_LOOKBACK_HOURS}h，截止时间: ${cutoff.toISOString()}`);

  for (const account of xAccounts) {
    try {
      const res = await fetch(
        `${TWITTERAPI_BASE}/twitter/user/last_tweets?userName=${account.handle}&includeReplies=false`,
        { headers: { 'X-API-Key': apiKey } }
      );

      if (res.status === 429) {
        console.error(`  @${account.handle}: 速率限制，等待 10 秒...`);
        await new Promise(r => setTimeout(r, 10000));
        continue; // 跳过这个账号，不重试
      }

      if (!res.ok) {
        errors.push(`TwitterAPI.io: @${account.handle} HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const allTweets = data.tweets || [];

      const newTweets = [];
      for (const tweet of allTweets) {
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;
        const tweetDate = new Date(tweet.createdAt);
        if (tweetDate < cutoff) continue; // 超出时间窗口，跳过
        if (state.seenTweets[tweet.id]) continue; // 已推送过，跳过
        if ((tweet.text || '').startsWith('RT @')) continue; // 跳过转推

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
        console.error(`  @${account.handle}: ${newTweets.length} 条新推文`);
        results.push({ source: 'x', name: account.name, handle: account.handle, tweets: newTweets });
      }

      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      errors.push(`TwitterAPI.io: @${account.handle} 错误: ${err.message}`);
    }
  }
  return results;
}

// -- 抓播客 ------------------------------------------------------------------
async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  console.error(`  YouTube lookback: ${PODCAST_LOOKBACK_HOURS}h，截止时间: ${cutoff.toISOString()}`);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      const videosUrl = podcast.type === 'youtube_playlist'
        ? `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`
        : `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;

      const videosRes = await fetch(videosUrl, { headers: { 'x-api-key': apiKey } });
      if (!videosRes.ok) { errors.push(`YouTube: ${podcast.name} HTTP ${videosRes.status}`); continue; }

      const videoIds = (await videosRes.json()).videoIds || [];
      for (const videoId of videoIds.slice(0, 3)) {
        if (state.seenVideos[videoId]) continue;
        try {
          const metaRes = await fetch(`${SUPADATA_BASE}/youtube/video?id=${videoId}`, { headers: { 'x-api-key': apiKey } });
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          const publishedAt = meta.uploadDate || meta.publishedAt || meta.date || null;
          if (publishedAt) {
            allCandidates.push({ podcast, videoId, title: meta.title || 'Untitled', publishedAt });
          }
          await new Promise(r => setTimeout(r, 300));
        } catch (err) { errors.push(`YouTube: ${videoId} 元数据错误: ${err.message}`); }
      }
    } catch (err) { errors.push(`YouTube: ${podcast.name} 错误: ${err.message}`); }
  }

  const withinWindow = allCandidates
    .filter(v => new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)); // 最新的优先

  const results = [];
  for (const candidate of withinWindow) {
    if (state.seenVideos[candidate.videoId]) continue;
    try {
      const transcriptRes = await fetch(
        `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${candidate.videoId}`)}&text=true`,
        { headers: { 'x-api-key': apiKey } }
      );
      if (!transcriptRes.ok) { errors.push(`YouTube: transcript HTTP ${transcriptRes.status}`); continue; }
      const transcriptData = await transcriptRes.json();
      state.seenVideos[candidate.videoId] = Date.now();
      results.push({
        source: 'podcast',
        name: candidate.podcast.name,
        title: candidate.title,
        videoId: candidate.videoId,
        url: `https://youtube.com/watch?v=${candidate.videoId}`,
        publishedAt: candidate.publishedAt,
        transcript: (transcriptData.content || '').slice(0, 3000)
      });
      break; // 每次只推一集
    } catch (err) { errors.push(`YouTube: transcript 错误: ${err.message}`); }
  }

  return results;
}

// -- Main -------------------------------------------------------------------
async function main() {
  const twitterApiKey = process.env.TWITTERAPI_IO_KEY;
  const supadataKey = process.env.SUPADATA_API_KEY;
  if (!supadataKey) { console.error('SUPADATA_API_KEY not set'); process.exit(1); }
  if (!twitterApiKey) { console.error('TWITTERAPI_IO_KEY not set'); process.exit(1); }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  console.error('=== 抓取 Twitter 内容 ===');
  const xContent = await fetchXContent(sources.x_accounts, twitterApiKey, state, errors);
  const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
  console.error(`结果: ${xContent.length} 个账号有新推文，共 ${totalTweets} 条`);

  await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent,
    stats: { xBuilders: xContent.length, totalTweets },
    errors: errors.filter(e => e.startsWith('TwitterAPI')).length > 0
      ? errors.filter(e => e.startsWith('TwitterAPI')) : undefined
  }, null, 2));

  console.error('=== 抓取 YouTube 内容 ===');
  const podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
  console.error(`结果: ${podcasts.length} 个新播客集`);

  await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    lookbackHours: PODCAST_LOOKBACK_HOURS,
    podcasts,
    stats: { podcastEpisodes: podcasts.length },
    errors: errors.filter(e => e.startsWith('YouTube')).length > 0
      ? errors.filter(e => e.startsWith('YouTube')) : undefined
  }, null, 2));

  await saveState(state);

  if (errors.length > 0) {
    console.error(`=== ${errors.length} 个非致命错误 ===`);
    errors.forEach(e => console.error('  -', e));
  }
}

main().catch(err => { console.error('运行失败:', err.message); process.exit(1); });
