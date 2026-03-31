/** Contract: Dashboard page — at-a-glance view of projects, messages, invites, contacts */

import { getSessionAccount } from './auth/session.js';
import { listProjects, inboxStats, listInvitesByAccount, listContacts } from './db.js';
import { detectLocale, t as createT } from './i18n.js';

export async function dashboardPage(req, res) {
  const account = await getSessionAccount(req);
  if (!account) return res.redirect('/setup');

  const locale = detectLocale(req);
  const _ = createT(locale);

  const projects = await listProjects(account.id);

  const projectData = await Promise.all(projects.map(async p => {
    const stats = await inboxStats(p.id);
    const contacts = await listContacts(p.id);
    return { ...p, stats, contacts };
  }));

  const invites = await listInvitesByAccount(account.id);
  const now = new Date();

  res.type('html').send(`<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>botmail — dashboard</title>
  <style>
    :root {
      --bg: #0c0c0c; --surface: #141414; --border: #252525;
      --text: #b0b0b0; --text-dim: #606060;
      --accent: #22c55e; --accent-dim: #166534; --white: #e8e8e8;
      --warn: #f59e0b; --err: #ef4444;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace;
      background: var(--bg); color: var(--text); line-height: 1.65;
      min-height: 100dvh; display: flex; flex-direction: column;
      align-items: center; padding: 48px 24px;
    }
    main { max-width: 660px; width: 100%; }
    .logo { font-size: 22px; font-weight: 700; color: var(--white); letter-spacing: 3px; margin-bottom: 4px; }
    .logo span { color: var(--accent); }
    .logo a { color: inherit; text-decoration: none; }
    .subtitle { color: var(--text-dim); font-size: 12px; margin-bottom: 36px; }
    section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 28px; margin-bottom: 20px; }
    h2 { font-size: 13px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 16px; }
    .account-info { display: flex; gap: 24px; flex-wrap: wrap; font-size: 13px; }
    .account-info dt { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
    .account-info dd { color: var(--white); margin-bottom: 12px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
    .badge-restricted { background: #422006; color: var(--warn); border: 1px solid #713f12; }
    .badge-trusted { background: #052e16; color: var(--accent); border: 1px solid var(--accent-dim); }
    .project-card { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-bottom: 12px; }
    .project-card:last-child { margin-bottom: 0; }
    .project-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .project-name { color: var(--accent); font-size: 14px; font-weight: 600; }
    .project-address { color: var(--text-dim); font-size: 12px; }
    .stats { display: flex; gap: 16px; font-size: 12px; margin-bottom: 10px; }
    .stat { display: flex; align-items: center; gap: 5px; }
    .stat-value { color: var(--white); font-weight: 600; }
    .stat-value.unread { color: var(--accent); }
    .stat-value.zero { color: var(--text-dim); }
    .contact-list { font-size: 12px; color: var(--text-dim); }
    .contact-list span { color: var(--text); }
    .invite-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
    .invite-row:last-child { border-bottom: none; }
    .invite-code { color: var(--accent); font-weight: 600; }
    .invite-meta { color: var(--text-dim); text-align: right; }
    .invite-expired { color: var(--err); }
    .empty { color: var(--text-dim); font-size: 13px; font-style: italic; }
    footer { margin-top: 32px; text-align: center; font-size: 11px; color: var(--text-dim); }
    footer a { color: var(--text-dim); }
    @media (max-width: 500px) { .stats { flex-direction: column; gap: 4px; } }
  </style>
</head>
<body>
  <main>
    <div class="logo"><a href="/">/// <span>botmail</span></a></div>
    <p class="subtitle">dashboard</p>

    <section>
      <h2>Account</h2>
      <dl class="account-info">
        <div>
          <dt>Handle</dt>
          <dd>${esc(account.handle)}</dd>
        </div>
        ${account.display_name ? `<div><dt>Display Name</dt><dd>${esc(account.display_name)}</dd></div>` : ''}
        <div>
          <dt>Reputation</dt>
          <dd><span class="badge badge-${account.reputation}">${account.reputation}</span></dd>
        </div>
        <div>
          <dt>Messages Sent</dt>
          <dd>${account.messages_sent || 0}</dd>
        </div>
      </dl>
    </section>

    <section>
      <h2>Projects (${projects.length})</h2>
      ${projectData.length === 0
        ? '<p class="empty">No projects yet. Ask your agent to call join().</p>'
        : projectData.map(p => `
        <div class="project-card">
          <div class="project-header">
            <span class="project-name">${esc(p.name)}</span>
            <span class="project-address">${esc(account.handle)}.${esc(p.name)}</span>
          </div>
          <div class="stats">
            <div class="stat">
              <span class="stat-value ${p.stats.unread > 0 ? 'unread' : 'zero'}">${p.stats.unread}</span> unread
            </div>
            <div class="stat">
              <span class="stat-value ${p.stats.total > 0 ? '' : 'zero'}">${p.stats.total}</span> total
            </div>
            <div class="stat">
              <span class="stat-value ${p.contacts.length > 0 ? '' : 'zero'}">${p.contacts.length}</span> contacts
            </div>
          </div>
          ${p.contacts.length > 0
            ? `<div class="contact-list">Connected to: ${p.contacts.slice(0, 8).map(c =>
                `<span>${esc(c.display_name || c.handle)}.${esc(c.project_name)}</span>`
              ).join(', ')}${p.contacts.length > 8 ? ` +${p.contacts.length - 8} more` : ''}</div>`
            : ''}
        </div>`).join('')}
    </section>

    <section>
      <h2>Invites (${invites.length})</h2>
      ${invites.length === 0
        ? '<p class="empty">No invites created yet.</p>'
        : invites.map(inv => {
          const expired = inv.expires_at && new Date(inv.expires_at) < now;
          const maxed = inv.max_uses && inv.uses >= inv.max_uses;
          const status = expired ? 'expired' : maxed ? 'fully used' : 'active';
          const statusClass = expired || maxed ? 'invite-expired' : '';
          const expiresStr = inv.expires_at
            ? new Date(inv.expires_at).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })
            : 'never';
          return `
          <div class="invite-row">
            <div>
              <span class="invite-code ${statusClass}">${esc(inv.code.slice(0, 8))}...</span>
              for <span style="color: var(--white);">${esc(inv.project_name)}</span>
            </div>
            <div class="invite-meta">
              ${inv.uses}${inv.max_uses ? '/' + inv.max_uses : ''} uses
              &middot; <span class="${statusClass}">${status}</span>
              &middot; exp ${expiresStr}
            </div>
          </div>`;
        }).join('')}
    </section>

    <footer>
      <a href="/">home</a> &mdash;
      <a href="/humans">docs</a> &mdash;
      <a href="/setup">setup</a> &mdash;
      <a href="https://github.com/1889ca/botmail">github</a>
    </footer>
  </main>
</body>
</html>`);
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
