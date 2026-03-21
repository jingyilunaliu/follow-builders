#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const TWITTERAPI_BASE = 'https://api.twitterapi.io';
const TWEET_LOOKBACK_HOURS = 24;
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
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) { if (ts < cutoff) delete state.seenTweets[id]; }
  for (const [id, ts] of Object.entries(state.seenVideos)) { if (ts < cutoff) delete state.seenVideos[id]; }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  return JSON.parse(await readFile(join(SCRIPT_DIR, '..', 'config', 'default-sources.json'), 'utf-8'));
}

// -- 抓推文 (用 /last_tweets，直接传 userName，不需要 userId) ----------------
async function fetchXContent(xAccounts, apiKey, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  console.error(`  Lookback cutoff: ${cutoff.toISOString()}`);

  for (const account of xAccounts) {
    try {
      const res = await fetch(
        `${TWITTERAPI_BASE}/twitter/user/last_tweets?userName=${account.handle}&includeReplies=false`,
        { headers: { 'X-API-Key': apiKey } }
      );

      if (!res.ok) {
        errors.push(`TwitterAPI.io: failed @${account.handle}: HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 2000)); // 遇到错误多等一下
        continue;
      }

      const data = await res.json();
      const allTweets = data.tweets || [];
      console.error(`  @${account.handle}: ${allTweets.length} tweets fetched`);

      const newTweets = [];
      for (const tweet of allTweets) {
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;
        const tweetDate = new Date(tweet.createdAt);
        if (tweetDate < cutoff) break; // 按时间排序，直接跳出
        if (state.seenTweets[tweet.id]) continue;
        if ((tweet.text || '').startsWith('RT @')) continue;

        newTweets.push({
          id: tweet.id,
          text: tweet.text || '',
          createdAt: tweet.createdAt,
          url: tweet.url || `https://x.com/${account.handle}/status/${tweet.id}`,
          likes: tweet.likeCount || 0,
          retweets: tweet.retweetCount || 0,
          replies: tweet.replyCount || 0,
        });
        state.seenTweets[tweet.id] = Date.now();
      }

      if (newTweets.length > 0) {
        console.error(`    → ${newTweets.length} new tweets kept`);
        results.push({ source: 'x', name: account.name, handle: account.handle, tweets: newTweets });
      }

      await new Promise(r => setTimeout(r, 500)); // 每次请求间隔 500ms

    } catch (err) {
      errors.push(`TwitterAPI.io: error @${account.handle}: ${err.message}`);
    }
  }
  return results;
}

// -- 抓播客 -----------------------------------------------------------------
async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      const videosUrl = podcast.type === 'youtube_playlist'
        ? `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`
        : `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;

      const videosRes = await fetch(videosUrl, { headers: { 'x-api-key': apiKey } });
      if (!videosRes.ok) { errors.push(`YouTube: Failed for ${podcast.name}: HTTP ${videosRes.status}`); continue; }

      const videoIds = (await videosRes.json()).videoIds || [];
      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) continue;
        try {
          const metaRes = await fetch(`${SUPADATA_BASE}/youtube/video?id=${videoId}`, { headers: { 'x-api-key': apiKey } });
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          allCandidates.push({ podcast, videoId, title: meta.title || 'Untitled', publishedAt: meta.uploadDate || meta.publishedAt || meta.date || null });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) { errors.push(`YouTube: metadata error ${videoId}: ${err.message}`); }
      }
    } catch (err) { errors.push(`YouTube: error ${podcast.name}: ${err.message}`); }
  }

  const selected = allCandidates
    .filter(v => v.publishedAt && new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt))[0];

  if (!selected) return [];

  try {
    const transcriptRes = await fetch(
      `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${selected.videoId}`)}&text=true`,
      { headers: { 'x-api-key': apiKey } }
    );
    if (!transcriptRes.ok) { errors.push(`YouTube: transcript failed: HTTP ${transcriptRes.status}`); return []; }
    const transcriptData = await transcriptRes.json();
    state.seenVideos[selected.videoId] = Date.now();
    return [{ source: 'podcast', name: selected.podcast.name, title: selected.title, videoId: selected.videoId, url: `https://youtube.com/watch?v=${selected.videoId}`, publishedAt: selected.publishedAt, transcript: transcriptData.content || '' }];
  } catch (err) { errors.push(`YouTube: transcript error: ${err.message}`); return []; }
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

  console.error('Fetching X/Twitter content via TwitterAPI.io...');
  const xContent = await fetchXContent(sources.x_accounts, twitterApiKey, state, errors);
  const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
  console.error(`  Found ${xContent.length} builders with ${totalTweets} new tweets`);

  await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent, stats: { xBuilders: xContent.length, totalTweets },
    errors: errors.filter(e => e.startsWith('TwitterAPI')).length > 0 ? errors.filter(e => e.startsWith('TwitterAPI')) : undefined
  }, null, 2));

  console.error('Fetching YouTube content...');
  const podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
  console.error(`  Found ${podcasts.length} new episodes`);

  await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), lookbackHours: PODCAST_LOOKBACK_HOURS,
    podcasts, stats: { podcastEpisodes: podcasts.length },
    errors: errors.filter(e => e.startsWith('YouTube')).length > 0 ? errors.filter(e => e.startsWith('YouTube')) : undefined
  }, null, 2));

  await saveState(state);
  if (errors.length > 0) { console.error(`  ${errors.length} non-fatal errors:`); errors.forEach(e => console.error('   -', e)); }
}

main().catch(err => { console.error('Feed generation failed:', err.message); process.exit(1); });
