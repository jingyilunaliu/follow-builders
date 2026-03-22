/**
 * run-and-email.js — follow-builders/scripts/
 * 
 * 流程：
 * 1. 调用 generate-feed.js 抓取推文和播客（输出到 feed-x.json / feed-podcasts.json）
 * 2. 读取这两个文件
 * 3. 用 Gemini 生成中文摘要
 * 4. 通过 SMTP 发送到邮箱
 */

import nodemailer from 'nodemailer';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ─── 主函数 ────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 开始抓取内容...');

  // 1. 运行 generate-feed.js，stdio: inherit 让所有输出直接显示在 Actions log
  const feedResult = spawnSync('node', ['generate-feed.js'], {
    cwd: __dirname,
    stdio: 'inherit',       // ← 关键：stderr 和 stdout 都直接流出来
    env: { ...process.env }
  });

  if (feedResult.status !== 0) {
    console.warn(`⚠️  generate-feed.js 退出码: ${feedResult.status}，继续尝试读取已有 feed 文件`);
  }

  // 2. 读取 feed 文件
  let xFeed = { x: [], stats: {} };
  let podcastFeed = { podcasts: [], stats: {} };

  const xPath = join(ROOT, 'feed-x.json');
  const podcastPath = join(ROOT, 'feed-podcasts.json');

  if (existsSync(xPath)) {
    xFeed = JSON.parse(readFileSync(xPath, 'utf8'));
    console.log(`📄 feed-x.json: ${xFeed.x?.length || 0} 个 builder，${xFeed.stats?.totalTweets || 0} 条推文`);
    if (xFeed.errors?.length) console.warn('X 错误:', xFeed.errors);
  } else {
    console.log('⚠️  未找到 feed-x.json');
  }

  if (existsSync(podcastPath)) {
    podcastFeed = JSON.parse(readFileSync(podcastPath, 'utf8'));
    console.log(`📄 feed-podcasts.json: ${podcastFeed.podcasts?.length || 0} 个新播客`);
    if (podcastFeed.errors?.length) console.warn('播客错误:', podcastFeed.errors);
  } else {
    console.log('⚠️  未找到 feed-podcasts.json');
  }

  // 3. 生成摘要并发邮件
  const digest = await generateChineseDigest(xFeed, podcastFeed);
  await sendEmail(digest);
  console.log('✅ 摘要已发送到邮箱');
}

// ─── Gemini 生成中文摘要 ───────────────────────────────────────────
async function generateChineseDigest(xFeed, podcastFeed) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const builders = xFeed.x || [];
  const podcasts = podcastFeed.podcasts || [];
  const hasContent = builders.length > 0 || podcasts.length > 0;

  const xSummary = builders.map(b =>
    `@${b.handle} (${b.name}):\n` +
    (b.tweets || []).map(t => `  • ${t.text}\n    ${t.url}`).join('\n')
  ).join('\n\n');

  const podcastSummary = podcasts.map(p =>
    `【${p.name}】${p.title}\n${(p.transcript || '').slice(0, 1500)}`
  ).join('\n\n');

  const contentBlock = hasContent
    ? `=== X 推文 ===\n${xSummary}\n\n=== 播客 ===\n${podcastSummary}`
    : '今日无新内容。';

  const prompt = `你是一个专注于 AI、3D 生成、空间计算领域的投资人助手。
请基于以下内容，用中文生成每日摘要。

重要规则：
- 每条推文摘要后面必须附上原文链接，格式：[原文](URL)
- 只总结有实质内容的推文，没有内容的人直接跳过

格式：
## 🤖 twitter daily · ${today}

### 🔥 今日重点
（2-3 条最值得关注的动态，说明为什么重要，附链接）

### 🐦 X 动态
（按人物分组，**姓名 @handle**：一句话摘要 [原文](URL)）

### 💡 投资信号
（从 3D 生成、空间智能、AI infra 角度提炼 1-2 个值得关注的信号）

---
${contentBlock}`;

  const apiKey = process.env.GEMINI_API_KEY || '';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8000 }
      })
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error('Gemini 失败:', err);
    return '<p>摘要生成失败，请检查 GEMINI_API_KEY。</p>';
  }

  const data = await res.json();
  const digestText = data.candidates[0].content.parts[0].text;
  console.log("=== Gemini 输出 ===\n" + digestText + "\n=== 输出结束 ===");
  return digestText;
}

// ─── 发送邮件 ──────────────────────────────────────────────────────
async function sendEmail(digestMarkdown) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long', day: 'numeric'
  });

  // Markdown → HTML
  function mdToHtml(md) {
    // 1. 先提取链接，用占位符替换
    const links = [];
    let s = md.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
      links.push({ text, url });
      return `%%LINK${links.length - 1}%%`;
    });
    // 2. 转义 HTML 特殊字符（防止推文内容破坏结构）
    s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 3. 处理标题和结构
    s = s.replace(/^## (.+)$/gm, '§H2§$1§/H2§');
    s = s.replace(/^### (.+)$/gm, '§H3§$1§/H3§');
    s = s.replace(/^---$/gm, '§HR§');
    // 4. 粗体斜体
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // 5. 还原链接
    s = s.replace(/%%LINK(\d+)%%/g, (_, i) => {
      const { text, url } = links[parseInt(i)];
      return `<a href="${url}" style="color:#0066cc">${text}</a>`;
    });
    // 6. 段落和换行
    const lines = s.split('\n');
    let html = '';
    for (const line of lines) {
      if (line.startsWith('§H2§')) {
        html += `<h2 style="border-bottom:2px solid #f0f0f0;padding-bottom:8px;margin-top:24px">${line.slice(4, -5)}</h2>\n`;
      } else if (line.startsWith('§H3§')) {
        html += `<h3 style="color:#444;margin-top:20px">${line.slice(4, -5)}</h3>\n`;
      } else if (line === '§HR§') {
        html += `<hr style="border:none;border-top:1px solid #eee;margin:16px 0">\n`;
      } else if (line.trim() === '') {
        html += '<br>\n';
      } else {
        html += `<p style="line-height:1.75;margin:4px 0">${line}</p>\n`;
      }
    }
    return html;
  }
  const body = mdToHtml(digestMarkdown);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1a1a1a}
  h2{border-bottom:2px solid #f0f0f0;padding-bottom:8px}
  h3{color:#444;margin-top:28px}
  p,li{line-height:1.75;color:#333}
  a{color:#0066cc}
  hr{border:none;border-top:1px solid #eee;margin:20px 0}
  .footer{color:#aaa;font-size:12px;margin-top:40px;border-top:1px solid #eee;padding-top:12px}
</style></head>
<body>
${body}
<div class="footer">ZhenFund Luna · follow-builders 自动生成 · ${today}</div>
</body></html>`;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: `"twitter daily" <${process.env.SMTP_USER}>`,
    to: process.env.TO_EMAIL,
    subject: `🤖 twitter daily · ${today}`,
    html
  });
}

main().catch(err => {
  console.error('❌ 运行失败:', err);
  process.exit(1);
});
