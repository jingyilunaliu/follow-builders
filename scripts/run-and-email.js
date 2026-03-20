/**
 * run-and-email.js
 * 放到 follow-builders/scripts/ 目录下
 * ESM 格式，对接 generate-feed.js 的输出
 */

import nodemailer from 'nodemailer';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ─── 主函数 ────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 开始抓取内容...');

  // 1. 运行 generate-feed.js 抓取推文和播客
  try {
    const result = execSync('node generate-feed.js', {
      cwd: __dirname,
      stdio: 'pipe',
      env: { ...process.env }
    });
    console.log(result.toString());
  } catch (e) {
    console.warn('⚠️  generate-feed 出错详情:');
    console.warn('stderr:', e.stderr?.toString());
    console.warn('stdout:', e.stdout?.toString());
  }

  // 2. 读取输出的 feed 文件
  let xFeed = { x: [] };
  let podcastFeed = { podcasts: [] };

  const xPath = join(ROOT, 'feed-x.json');
  const podcastPath = join(ROOT, 'feed-podcasts.json');

  if (existsSync(xPath)) {
    xFeed = JSON.parse(readFileSync(xPath, 'utf8'));
    console.log(`✅ 读取 feed-x.json: ${xFeed.x?.length || 0} 个 builder`);
  } else {
    console.log('⚠️  未找到 feed-x.json');
  }

  if (existsSync(podcastPath)) {
    podcastFeed = JSON.parse(readFileSync(podcastPath, 'utf8'));
    console.log(`✅ 读取 feed-podcasts.json: ${podcastFeed.podcasts?.length || 0} 个播客`);
  } else {
    console.log('⚠️  未找到 feed-podcasts.json');
  }

  // 3. 用 Gemini 生成中文摘要
  const digest = await generateChineseDigest(xFeed, podcastFeed);

  // 4. 发邮件
  await sendEmail(digest);
  console.log('✅ 摘要已发送到邮箱');
}

// ─── Gemini API 生成中文摘要 ──────────────────────────────────────
async function generateChineseDigest(xFeed, podcastFeed) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const xSummary = (xFeed.x || []).map(builder =>
    `@${builder.handle} (${builder.name}):\n` +
    builder.tweets.map(t => `  - ${t.text} [${t.url}]`).join('\n')
  ).join('\n\n');

  const podcastSummary = (podcastFeed.podcasts || []).map(p =>
    `${p.name}: 《${p.title}》\n transcript: ${(p.transcript || '').slice(0, 1000)}`
  ).join('\n\n');

  const hasContent = xSummary.length > 0 || podcastSummary.length > 0;

  const prompt = `你是一个专注于 AI、3D 生成、空间计算领域的投资人助手。
以下是今日从 X（Twitter）和播客抓取的内容。
请用中文生成一份简洁的每日摘要，格式如下：

---
## 🤖 twitter daily · ${today}

### 🔥 今日重点（2-3条最值得关注的动态）
[精选最重要的 2-3 条，简短说明为什么重要]

### 🐦 X 动态摘要
[按人物分组，每人 1-2 句话，只保留有实质内容的，没什么说的跳过]

### 🎙️ 播客更新
[如有新播客，每个一句话总结主题]

### 💡 投资视角小结
[从 3D 生成、空间智能、AI infra 角度，提炼 1-2 个值得关注的信号]
---

${hasContent ? `X 推文内容：\n${xSummary}\n\n播客内容：\n${podcastSummary}` : '今日暂无新内容，请生成一条简短提示说明暂无更新。'}

注意：如果某类内容为空，跳过该部分即可，不要生成占位文字。`;

  const apiKey = process.env.GEMINI_API_KEY || '';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2000 }
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    console.error('Gemini API 调用失败:', err);
    return `<p>今日内容生成失败，请检查 Gemini API 配置。</p>`;
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// ─── 发送邮件 ──────────────────────────────────────────────────────
async function sendEmail(digestMarkdown) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long', day: 'numeric'
  });

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 0 auto; padding: 20px; color: #1a1a1a; }
  h2 { color: #1a1a1a; border-bottom: 2px solid #f0f0f0; padding-bottom: 8px; }
  h3 { color: #444; margin-top: 24px; }
  p { line-height: 1.7; color: #333; }
  hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
  .footer { color: #999; font-size: 12px; margin-top: 40px; }
</style>
</head>
<body>
${digestMarkdown
  .replace(/^## (.+)$/gm, '<h2>$1</h2>')
  .replace(/^### (.+)$/gm, '<h3>$1</h3>')
  .replace(/^---$/gm, '<hr>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\n\n/g, '</p><p>')
  .replace(/^/, '<p>')
  .replace(/$/, '</p>')}
<div class="footer">由 follow-builders · ZhenFund Luna 定制版 自动生成</div>
</body>
</html>`;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: `"twitter daily" <${process.env.SMTP_USER}>`,
    to: process.env.TO_EMAIL,
    subject: `🤖 twitter daily · ${today}`,
    html,
  });
}

main().catch(err => {
  console.error('❌ 运行失败:', err);
  process.exit(1);
});
