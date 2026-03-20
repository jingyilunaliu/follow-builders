#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Rettiwt } from 'rettiwt-api';

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const TWEET_LOOKBACK_HOURS = 336;   // 14天，覆盖 Rettiwt guest 模式返回数据不保证最新的问题
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {}, seenVideos: {} };
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf-8'));
  } catch {
    return { seenTweets: {}, seenVideos: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenVideos)) {
    if (ts < cutoff) delete state.seenVideos[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

async function fetchXContent(xAccounts, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  const rettiwt = new Rettiwt();

  console.error(`  Lookback cutoff: ${cutoff.toISOString()}`);
  console.error(`  SeenTweets count: ${Object.keys(state.seenTweets).length}`);

  for (const account of xAccounts) {
    try {
      const userDetails = await rettiwt.user.details(account.handle);
      if (!userDetails) {
        errors.push(`Rettiwt: User not found: @${account.handle}`);
        continue;
      }

      const timeline = await rettiwt.user.timeline(userDetails.id, 10);
      const allTweets = (timeline?.list || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      console.error(`  @${account.handle}: ${allTweets.length} tweets fetched`);

      // Debug: print dates of fetched tweets
      if (allTweets.length > 0) {
        const dates = allTweets.slice(0, 3).map(t => t.createdAt).join(', ');
        console.error(`    Latest tweet dates: ${dates}`);
      }

      const newTweets = [];
      for (const tweet of allTweets) {
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        const tweetDate = new Date(tweet.createdAt);
        if (tweetDate < cutoff) continue;
        if (state.seenTweets[tweet.id]) continue;
        if ((tweet.fullText || tweet.text || '').startsWith('RT @')) continue;

        newTweets.push({
          id: tweet.id,
          text: tweet.fullText || tweet.text || '',
          createdAt: tweet.createdAt,
          url: `https://x.com/${account.handle}/status/${tweet.id}`,
          likes: tweet.likeCount || 0,
          retweets: tweet.retweetCount || 0,
          replies: tweet.replyCount || 0,
        });

        state.seenTweets[tweet.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      console.error(`    → ${newTweets.length} new tweets kept`);
      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        tweets: newTweets
      });

      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      errors.push(`Rettiwt: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

async function fetchYouTubeContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    try {
      let videosUrl;
      if (podcast.type === 'youtube_playlist') {
        videosUrl = `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`;
      } else {
        videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      }

      const videosRes = await fetch(videosUrl, { headers: { 'x-api-key': apiKey } });
      if (!videosRes.ok) {
        errors.push(`YouTube: Failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) continue;
        try {
          const metaRes = await fetch(`${SUPADATA_BASE}/youtube/video?id=${videoId}`, { headers: { 'x-api-key': apiKey } });
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          allCandidates.push({ podcast, videoId, title: meta.title || 'Untitled', publishedAt: meta.uploadDate || meta.publishedAt || meta.date || null });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          errors.push(`YouTube: Error fetching metadata for ${videoId}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`YouTube: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  const withinWindow = allCandidates
    .filter(v => v.publishedAt && new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  const selected = withinWindow[0];
  if (!selected) return [];

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${selected.videoId}`;
    const transcriptRes = await fetch(
      `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': apiKey } }
    );
    if (!transcriptRes.ok) {
      errors.push(`YouTube: Failed to get transcript: HTTP ${transcriptRes.status}`);
      return [];
    }
    const transcriptData = await transcriptRes.json();
    state.seenVideos[selected.videoId] = Date.now();
    return [{
      source: 'podcast',
      name: selected.podcast.name,
      title: selected.title,
      videoId: selected.videoId,
      url: `https://youtube.com/watch?v=${selected.videoId}`,
      publishedAt: selected.publishedAt,
      transcript: transcriptData.content || ''
    }];
  } catch (err) {
    errors.push(`YouTube: Error fetching transcript: ${err.message}`);
    return [];
  }
}

async function main() {
  const supadataKey = process.env.SUPADATA_API_KEY;
  if (!supadataKey) { console.error('SUPADATA_API_KEY not set'); process.exit(1); }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  console.error('Fetching X/Twitter content via Rettiwt (guest mode)...');
  const xContent = await fetchXContent(sources.x_accounts, state, errors);
  console.error(`  Found ${xContent.length} builders with new tweets`);

  const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
  await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent,
    stats: { xBuilders: xContent.length, totalTweets },
    errors: errors.filter(e => e.startsWith('Rettiwt')).length > 0 ? errors.filter(e => e.startsWith('Rettiwt')) : undefined
  }, null, 2));

  console.error('Fetching YouTube content...');
  const podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
  console.error(`  Found ${podcasts.length} new episodes`);

  await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    lookbackHours: PODCAST_LOOKBACK_HOURS,
    podcasts,
    stats: { podcastEpisodes: podcasts.length },
    errors: errors.filter(e => e.startsWith('YouTube')).length > 0 ? errors.filter(e => e.startsWith('YouTube')) : undefined
  }, null, 2));

  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors:`);
    errors.forEach(e => console.error('   -', e));
  }
}

main().catch(err => { console.error('Feed generation failed:', err.message); process.exit(1); });
