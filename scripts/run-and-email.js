/**
 * run-and-email.js
 * 放到 follow-builders/scripts/ 目录下
 * ESM 格式（匹配 repo 的 "type": "module"）
 */

import nodemailer from 'nodemailer';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── 你的自定义关注列表 ───────────────────────────────────────────
const CUSTOM_X_ACCOUNTS = [
  // 3D Gen / Spatial AI
  { handle: 'YuanmingH',     name: '胡渊鸣 (Meshy CEO)' },
  { handle: 'drfeifei',      name: 'Fei-Fei Li (World Labs)' },
  { handle: 'ZiyangXie_',    name: 'Ziyang Xie (3DV & World Models)' },

  // AI Research / Lab leads
  { handle: 'ilyasut',       name: 'Ilya Sutskever' },
  { handle: 'demishassabis',  name: 'Demis Hassabis (DeepMind)' },
  { handle: 'david_silver',   name: 'David Silver (DeepMind)' },
  { handle: 'sainingxie',    name: 'Saining Xie' },
  { handle: 'tinghuizhou',   name: 'Tinghui Zhou' },
  { handle: 'liuziwei7',     name: 'Ziwei Liu' },
  { handle: 'jiajunwu_cs',   name: 'Jiajun Wu' },

  // AI Infra / Systems
  { handle: 'simon_mo_',     name: 'Simon Mo (vLLM)' },
  { handle: 'istoica05',     name: 'Ion Stoica (Databricks/Anyscale)' },
  { handle: 'rogerw0108',    name: 'Roger Wang (Inferact/vLLM)' },
  { handle: 'KaichaoYou',    name: 'Kaichao You (Inferact/vLLM)' },

  // Meta FAIR
  { handle: 'DavidJFan',     name: 'David Fan (Meta FAIR)' },
  { handle: 'zhuokaiz',      name: 'Zhuokai Zhao (Meta)' },

  // XR / Spatial Computing
  { handle: 'dtupper',       name: 'tupper (VRChat)' },

  // Founders / VC
  { handle: 'zoink',         name: 'Dylan Field (Figma)' },
  { handle: 'boztank',       name: 'Boz (Meta VP AR/VR)' },
  { handle: 'xuwu',          name: 'Xu Wu' },
  { handle: 'zarazhangrui',  name: 'Zara Zhang' },

  // 通用 AI builders
  { handle: 'karpathy',      name: 'Andrej Karpathy' },
  { handle: 'sama',          name: 'Sam Altman' },
  { handle: 'swyx',          name: 'Swyx' },
  { handle: 'mattturck',     name: 'Matt Turck' },
  { handle: 'venturetwins',  name: 'Justine Moore' },
  { handle: 'garrytan',      name: 'Garry Tan' },
  { handle: 'AmandaAskell',  name: 'Amanda Askell (Anthropic)' },
];

// ─── 播客列表 ─────────────────────────────────────────────────────
const PODCASTS = [
  { name: 'Latent Space',          channelId: 'UCHzRR946dbHBaXs9_qPVOtg' },
  { name: 'No Priors',             channelId: 'UC9sIobxS3GV_qgemoMQdNdg' },
  { name: 'Unsupervised Learning', channelId: 'UCMFMvwJM_iFMqWJkZcCRGgg' },
];

// ─── 主函数 ────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 开始抓取内容...');

  try {
    execSync('node fetch-content.js', {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env }
    });
  } catch (e) {
    console.warn('⚠️  fetch-content 出错，继续用空内容:', e.message);
  }

  const rawPath = join(__dirname, '../output/raw-content.json');
  let rawContent = {};
  if (existsSync(rawPath)) {
    rawContent = JSON.parse(readFileSync(rawPath, 'utf8'));
  } else {
    console.log('⚠️  未找到 raw-content.json，使用空内容继续');
  }

  const digest = await generateChineseDigest(rawContent);
  await sendEmail(digest);
  console.log('✅ 摘要已发送到邮箱');
}

// ─── Kimi API 生成中文摘要 ─────────────────────────────────────────
async function generateChineseDigest(rawContent) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const prompt = `你是一个专注于 AI、3D 生成、空间计算领域的投资人助手。
以下是今日从 X（Twitter）和播客抓取的原始内容。
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

原始内容：
${JSON.stringify(rawContent, null, 2).slice(0, 8000)}

注意：如果某类内容为空，跳过该部分即可，不要生成占位文字。`;

  const apiKey = process.env.GEMINI_API_KEY || '';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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
    return `<pre>${JSON.stringify(rawContent, null, 2)}</pre>`;
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
