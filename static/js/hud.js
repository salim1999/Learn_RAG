// RAG Academy – HUD: XP-Balken, Rang, Streak, Badges, Modus-Chip

import { h, clear, toast } from './ui.js';
import { state, subscribe, rankInfo } from './state.js';

export function initHud(root) {
  let badgesOpen = false;

  function render() {
    clear(root);
    const player = state.progress && state.progress.player;
    const r = rankInfo(player);
    const status = state.status;
    let modeChip;
    if (!status) {
      modeChip = h('span.chip.chip-off', { title: 'Server nicht erreichbar' }, h('span.dot', { 'aria-hidden': 'true' }), 'Server offline');
    } else if (status.llm_enabled) {
      modeChip = h('span.chip.chip-llm', { title: status.model ? `Modell: ${status.model}` : 'Claude ist verbunden' },
        h('span.dot', { 'aria-hidden': 'true' }), 'Claude aktiv');
    } else {
      modeChip = h('span.chip.chip-offline', { title: 'Lokale, regelbasierte Auswertung ohne LLM' },
        h('span.dot', { 'aria-hidden': 'true' }), 'Offline-Modus');
    }

    const gpuChip = status && status.gpu_enabled
      ? h('span.chip.chip-gpu', {
        title: Array.isArray(status.gpu_models) && status.gpu_models.length
          ? `GPU-Modelle: ${status.gpu_models.join(', ')}`
          : (status.gpu_models && typeof status.gpu_models === 'object' ? `GPU-Modelle: ${Object.values(status.gpu_models).join(', ')}` : 'GPU-Endpoint verbunden'),
      }, h('span.dot', { 'aria-hidden': 'true' }), 'GPU aktiv')
      : null;
    const badges = (player && player.badges) || [];
    const xpText = r.nextXp != null ? `${r.xp} / ${r.nextXp} XP` : `${r.xp} XP, höchster Rang`;

    const badgeBtn = h('button.hud-badges', {
      type: 'button',
      'aria-expanded': String(badgesOpen),
      'aria-controls': 'badge-panel',
      onclick: () => { badgesOpen = !badgesOpen; render(); },
      title: 'Abzeichen anzeigen',
    },
    h('span.hud-badge-icons', { 'aria-hidden': 'true' }, badges.length ? badges.slice(-4).map((b) => b.icon).join('') : '☆'),
    h('span.hud-badge-count', `${badges.length} Abzeichen`));

    root.append(
      h('a.brand', { href: '#/', 'aria-label': 'RAG Academy – zur Sternenkarte' },
        h('span.brand-mark', { 'aria-hidden': 'true' }), h('span.brand-name', 'RAG Academy')),
      h('div.hud-rank',
        h('div.hud-rank-row',
          h('span.hud-rank-name', r.rank),
          h('span.hud-xp-text', xpText)),
        h('div.xpbar', {
          role: 'progressbar', 'aria-label': r.nextName ? `XP bis ${r.nextName}` : 'XP',
          'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(r.frac * 100)),
        }, h('div.xpbar-fill', { style: { width: `${(r.frac * 100).toFixed(1)}%` } })),
        r.nextName ? h('span.hud-next', `Nächster Rang: ${r.nextName}`) : null),
      h('div.hud-meta',
        h('span.hud-streak', { title: 'Lerntage in Folge' },
          h('span', { 'aria-hidden': 'true' }, '🔥'), ` ${(player && player.streak_days) || 0} `,
          h('span.sr-only', 'Tage Serie'), h('span.hud-streak-label', { 'aria-hidden': 'true' }, 'Tage')),
        badgeBtn,
        modeChip,
        gpuChip),
    );

    if (badgesOpen) {
      root.appendChild(h('div.badge-panel#badge-panel', { role: 'region', 'aria-label': 'Abzeichen' },
        badges.length
          ? h('ul.badge-list', badges.map((b) => h('li.badge',
            h('span.badge-icon', { 'aria-hidden': 'true' }, b.icon || '🏅'),
            h('div', h('strong', b.name), h('p', b.description || '')))))
          : h('p.muted', 'Noch keine Abzeichen. Löse Aufgaben, um welche zu verdienen.')));
    }
  }

  subscribe((s, change) => {
    render();
    if (change && change.type === 'progress') {
      for (const b of change.newBadges || []) toast(`${b.icon || '🏅'} Neues Abzeichen: ${b.name}`, 'success', 5200);
      if (change.rankUp) toast(`Neuer Rang erreicht: ${change.rankUp}`, 'success', 5200);
    }
  });
  render();
}
