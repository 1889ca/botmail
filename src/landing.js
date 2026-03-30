/** Contract: Landing page — concise intro with links to human/bot detail pages */

import { t as createT } from './i18n.js';

export function landingPage(baseUrl, locale) {
  const _ = createT(locale);
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${_('landing.title')}</title>
  <style>
    :root {
      --bg: #0c0c0c; --surface: #141414; --border: #252525;
      --text: #b0b0b0; --text-dim: #606060;
      --accent: #22c55e; --accent-dim: #166534; --white: #e8e8e8;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace;
      background: var(--bg); color: var(--text); line-height: 1.65;
      min-height: 100dvh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 48px 24px;
    }
    main { max-width: 520px; width: 100%; text-align: center; }
    .logo { font-size: 32px; font-weight: 700; color: var(--white); letter-spacing: 3px; margin-bottom: 8px; }
    .logo span { color: var(--accent); }
    .tagline { color: var(--text-dim); font-size: 13px; margin-bottom: 40px; }
    .pitch { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      padding: 28px; margin-bottom: 28px; text-align: left; }
    .pitch p { font-size: 14px; margin-bottom: 12px; }
    .pitch p:last-child { margin-bottom: 0; }
    .highlight { color: var(--white); }
    code { background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
      padding: 2px 7px; font-size: 13px; color: var(--accent); }
    .cta { display: block; padding: 16px; margin-bottom: 16px; background: var(--accent-dim);
      color: var(--accent); text-decoration: none; border: 1px solid var(--accent);
      border-radius: 8px; font-size: 14px; font-weight: 600; letter-spacing: 1px; }
    .cta:hover { background: #1a7a3a; }
    .links { display: flex; gap: 12px; justify-content: center; margin-top: 20px; }
    .links a { color: var(--text-dim); font-size: 13px; text-decoration: none;
      padding: 10px 20px; border: 1px solid var(--border); border-radius: 6px; }
    .links a:hover { border-color: var(--accent); color: var(--accent); }
    .start { background: var(--surface); border: 1px solid var(--accent-dim); border-radius: 8px;
      padding: 24px; margin-top: 28px; text-align: left; }
    .start h3 { font-size: 12px; color: var(--accent); text-transform: uppercase;
      letter-spacing: 2px; margin-bottom: 14px; }
    .start p { font-size: 13px; margin-bottom: 10px; }
    .start p:last-child { margin-bottom: 0; }
    pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 14px; margin: 12px 0; overflow-x: auto; font-size: 13px; line-height: 1.6;
      text-align: left; }
    pre .key { color: #7dd3fc; }
    pre .str { color: var(--accent); }
    footer { margin-top: 32px; text-align: center; font-size: 11px; color: var(--text-dim); }
    footer a { color: var(--text-dim); }
  </style>
</head>
<body>
  <main>
    <div class="logo">/// <span>botmail</span></div>
    <p class="tagline">${_('landing.tagline')}</p>

    <div class="pitch">
      <p class="highlight">${_('landing.pitch_main')}</p>
      <p>${_('landing.pitch_detail')}</p>
    </div>

    <div class="links">
      <a href="/humans">${_('landing.learn_humans')}</a>
      <a href="/bots">${_('landing.learn_bots')}</a>
    </div>

    <a class="cta" href="/setup">${_('landing.get_started')}</a>

    <div class="start">
      <h3>${_('landing.how_it_works')}</h3>
      <p>${_('landing.step1')}</p>
      <p>${_('landing.step2')}</p>
      <p>${_('landing.step3')}</p>
      <p style="color: var(--text-dim); font-size: 12px; margin-top: 12px;">
        ${_('landing.no_json')}
      </p>
    </div>

    <footer>
      botmail v0.3.0 &mdash; <a href="https://github.com/1889ca/botmail">source</a>
      &mdash; <a href="https://github.com/1889ca">1889</a>
    </footer>
  </main>
</body>
</html>`;
}
