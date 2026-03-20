#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator (Luna 定制版)
// 用 Rettiwt-API guest 模式抓推文，不需要任何 Twitter API key
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Rettiwt } from 'rettiwt-api';

// -- Constants ---------------------------------------------------------------

const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 72;
const MAX_TWEETS_PER_USER = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

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

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- X/Twitter Fetching (Rettiwt guest mode) ---------------------------------

async function fetchXContent(xAccounts, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Guest mode — no API key needed
  const rettiwt = new Rettiwt();

  for (const account of xAccounts) {
    try {
      // 1. Get user details (to get user id)
      const userDetails = await rettiwt.user.details(account.handle);
      if (!userDetails) {
        errors.push(`Rettiwt: User not found: @${account.handle}`);
        continue;
      }

      // 2. Get user timeline
      const timeline = await rettiwt.user.timeline(userDetails.id);
      const allTweets = timeline?.list || [];

      // 3. Filter: within lookback window, not seen before, not retweets
      const newTweets = [];
      for (const tweet of allTweets) {
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        const tweetDate = new Date(tweet.createdAt);
        if (tweetDate < cutoff) continue;
        if (state.seenTweets[tweet.id]) continue;
        if (tweet.fullText?.startsWith('RT @')) continue; // skip retweets

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

      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        tweets: newTweets
      });

      // Be polite to avoid rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      errors.push(`Rettiwt: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- YouTube Fetching (Supadata API) -----------------------------------------

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

      const videosRes = await fetch(videosUrl, {
        headers: { 'x-api-key': apiKey }
      });

      if (!videosRes.ok) {
        errors.push(`YouTube: Failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      for (const videoId of videoIds.slice(0, 2)) {
        if (state.seenVideos[videoId]) continue;

        try {
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { 'x-api-key': apiKey } }
          );
          if (!metaRes.ok) continue;
          const meta = await metaRes.json();
          const publishedAt = meta.uploadDate || meta.publishedAt || meta.date || null;

          allCandidates.push({ podcast, videoId, title: meta.title || 'Untitled', publishedAt });
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
      errors.push(`YouTube: Failed to get transcript for ${selected.videoId}: HTTP ${transcriptRes.status}`);
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
    errors.push(`YouTube: Error fetching transcript for ${selected.videoId}: ${err.message}`);
    return [];
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const supadataKey = process.env.SUPADATA_API_KEY;

  if (!supadataKey) {
    console.error('SUPADATA_API_KEY not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets via Rettiwt guest mode
  console.error('Fetching X/Twitter content via Rettiwt (guest mode)...');
  const xContent = await fetchXContent(sources.x_accounts, state, errors);
  console.error(`  Found ${xContent.length} builders with new tweets`);

  const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
  const xFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent,
    stats: { xBuilders: xContent.length, totalTweets },
    errors: errors.filter(e => e.startsWith('Rettiwt')).length > 0
      ? errors.filter(e => e.startsWith('Rettiwt')) : undefined
  };
  await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
  console.error(`  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`);

  // Fetch podcasts
  console.error('Fetching YouTube content...');
  const podcasts = await fetchYouTubeContent(sources.podcasts, supadataKey, state, errors);
  console.error(`  Found ${podcasts.length} new episodes`);

  const podcastFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: PODCAST_LOOKBACK_HOURS,
    podcasts,
    stats: { podcastEpisodes: podcasts.length },
    errors: errors.filter(e => e.startsWith('YouTube')).length > 0
      ? errors.filter(e => e.startsWith('YouTube')) : undefined
  };
  await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
  console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);

  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors:`);
    errors.forEach(e => console.error('   -', e));
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
