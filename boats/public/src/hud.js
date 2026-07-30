import { BOATS, MONSTER_BY_ID, CREW, crewCost } from '/shared/config.js';

// All DOM in one place. The 3D layer never touches innerHTML.

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(actions) {
    this.actions = actions;       // { sell, repair, hire, buy, respawn, chat, closeDock }
    this.el = {
      hud: $('hud'), name: $('hud-name'), boat: $('hud-boat'), gold: $('hud-gold'),
      xpFill: $('hud-xp-fill'), level: $('hud-level'),
      hullFill: $('hull-fill'), hullText: $('hull-text'),
      crew: $('crew-stat'), hold: $('hold-stat'), speed: $('speed-stat'),
      cargo: $('cargo-list'), log: $('event-log'), chatLog: $('chat-log'), chatInput: $('chat-input'),
      charge: $('charge-fill'), chargeLabel: $('charge-label'),
      strain: $('strain'), strainFill: $('strain-fill'), strainText: $('strain-text'),
      fishBar: $('fish-progress'), fishFill: $('fish-progress-fill'),
      strike: $('strike'), catchCard: $('catch-card'),
      catchName: $('catch-name'), catchKg: $('catch-kg'),
      catchValue: $('catch-value'), catchBlurb: $('catch-blurb'),
      prompt: $('prompt'), reticle: $('reticle'),
      dock: $('dock'), dockGold: $('dock-gold'), dockCargo: $('dock-cargo'), dockBoats: $('dock-boats'),
      repairBtn: $('repair-btn'), repairNote: $('repair-note'),
      crewBtn: $('crew-btn'), crewNote: $('crew-note'), sellBtn: $('sell-btn'),
      death: $('death'), deathDetail: $('death-detail'), deathLosses: $('death-losses'),
      leaderboard: $('leaderboard'), leaderboardBody: $('leaderboard-body'),
      targetTag: $('target-tag'), targetName: $('target-name'), targetFill: $('target-fill'),
    };
    this.state = null;

    $('sell-btn').onclick = () => actions.dock('sell');
    $('repair-btn').onclick = () => actions.dock('repair');
    $('crew-btn').onclick = () => actions.dock('crew');
    $('dock-close').onclick = () => actions.closeDock();
    $('respawn-btn').onclick = () => actions.respawn();

    this.el.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.el.chatInput.value.trim();
        if (text) actions.chat(text);
        this.closeChat();
      } else if (e.key === 'Escape') {
        this.closeChat();
      }
    });
  }

  show() { this.el.hud.hidden = false; }

  /* ------------------------------------------------------------ vitals */

  setSelf(s) {
    this.state = s;
    const boat = BOATS[s.tier];
    this.el.name.textContent = s.name;
    this.el.boat.textContent = boat.name;
    this.el.gold.textContent = s.gold.toLocaleString();
    this.el.level.textContent = `Lv ${s.level}`;
    const span = Math.max(1, s.xpNext - s.xpPrev);
    const pct = Math.max(0, Math.min(1, (s.xp - s.xpPrev) / span));
    this.el.xpFill.style.right = `${(1 - pct) * 100}%`;
    this.setHull(s.hull, s.hullMax);
    this.el.crew.textContent = `👤 ${s.crew}/${s.crewMax}`;
    const used = s.cargo.reduce((a, c) => a + c.slots, 0);
    const fish = s.cargo.reduce((a, c) => a + (c.fish ? 1 : 0), 0);
    this.el.hold.textContent = fish ? `📦 ${used}/${s.hold}  🐟 ${fish}` : `📦 ${used}/${s.hold}`;
    this.el.cargo.replaceChildren(
      ...s.cargo.filter((c) => !c.fish).map((c) => {
        const d = document.createElement('div');
        d.textContent = `${c.name} · ${c.bounty.toLocaleString()}g`;
        return d;
      })
    );
    if (!this.el.dock.hidden) this.renderDock();
  }

  setHull(hull, max) {
    const pct = Math.max(0, Math.min(1, hull / max));
    this.el.hullFill.style.right = `${(1 - pct) * 100}%`;
    this.el.hullFill.className = pct < 0.25 ? 'crit' : pct < 0.55 ? 'warn' : '';
    this.el.hullText.textContent = `${Math.max(0, Math.round(hull))} / ${max}`;
  }

  setSpeed(knots) { this.el.speed.textContent = `⚓ ${knots.toFixed(1)} kn`; }

  setCharge(v) {
    this.el.charge.style.right = `${(1 - v) * 100}%`;
    this.el.charge.classList.toggle('full', v >= 0.999);
    this.el.reticle.classList.toggle('charging', v > 0.02);
  }

  setLocked(on) { this.el.reticle.classList.toggle('locked', on); }

  setStrain(tether) {
    if (!tether) { this.el.strain.hidden = true; return; }
    this.el.strain.hidden = false;
    const v = Math.max(0, Math.min(1, tether.strain / 100));
    this.el.strainFill.style.right = `${(1 - v) * 100}%`;
    this.el.strainFill.classList.toggle('crit', v > 0.72);
    this.el.strainText.textContent = v > 0.72
      ? 'ROPE STRAINING — ease off'
      : `rope ${Math.round(tether.dist)}m · ${Math.round(tether.length)}m out`;
  }

  /**
   * Fishing borrows the harpoon's two gauges on purpose: the charge bar is the
   * cast, the strain bar is the line. One vocabulary for "hold it, but not too
   * hard".
   */
  setFishing(f) {
    if (!f || !f.active) {
      this.el.fishBar.hidden = true;
      this.el.strike.hidden = true;
      if (this.fishingWasActive) {
        this.el.chargeLabel.textContent = 'harpoon';
        this.el.strain.hidden = true;
      }
      this.fishingWasActive = false;
      return;
    }
    this.fishingWasActive = true;
    this.el.chargeLabel.textContent = 'cast';
    this.setCharge(f.charge);

    const fighting = f.fighting;
    this.el.strain.hidden = !fighting;
    this.el.fishBar.hidden = !fighting;
    if (fighting) {
      const t = f.tension;
      this.el.strainFill.style.right = `${(1 - t) * 100}%`;
      this.el.strainFill.classList.toggle('crit', t > 0.82);
      this.el.strainText.textContent = f.running
        ? 'IT IS RUNNING — let it go'
        : t > 0.62 ? 'holding hard — good' : 'line';
      this.el.fishFill.style.right = `${(1 - f.progress) * 100}%`;
    }
    this.el.strike.hidden = f.phase !== 'bite';
  }

  showCatch(species, kg, value) {
    this.el.catchName.textContent = species.name;
    this.el.catchKg.textContent = kg.toFixed(2);
    this.el.catchValue.textContent = value.toLocaleString();
    this.el.catchBlurb.textContent = species.blurb || '';
    this.el.catchCard.hidden = false;
    clearTimeout(this._catchTimer);
    this._catchTimer = setTimeout(() => { this.el.catchCard.hidden = true; }, 2600);
  }

  setPrompt(html) {
    if (!html) { this.el.prompt.hidden = true; return; }
    this.el.prompt.hidden = false;
    this.el.prompt.innerHTML = html;
  }

  /** Floating monster health above whatever you are currently fighting. */
  setTarget(name, hpPct, screen) {
    if (!screen) { this.el.targetTag.hidden = true; return; }
    this.el.targetTag.hidden = false;
    this.el.targetName.textContent = name;
    this.el.targetFill.style.width = `${Math.max(0, hpPct)}%`;
    this.el.targetTag.style.left = `${screen.x}px`;
    this.el.targetTag.style.top = `${screen.y}px`;
  }

  /* -------------------------------------------------------------- feed */

  log(text, kind = 'info') {
    const div = document.createElement('div');
    div.className = `ev ${kind}`;
    div.textContent = text;
    this.el.log.appendChild(div);
    while (this.el.log.children.length > 7) this.el.log.firstChild.remove();
    setTimeout(() => {
      div.classList.add('fade');
      setTimeout(() => div.remove(), 600);
    }, kind === 'big' || kind === 'sink' ? 9000 : 6000);
  }

  chat(name, text, mine) {
    const div = document.createElement('div');
    div.className = 'chat-line';
    const b = document.createElement('b');
    b.textContent = `${name}: `;
    if (mine) b.style.color = 'var(--gold)';
    div.append(b, document.createTextNode(text));
    this.el.chatLog.appendChild(div);
    while (this.el.chatLog.children.length > 6) this.el.chatLog.firstChild.remove();
    setTimeout(() => div.remove(), 22000);
  }

  openChat() {
    this.el.chatInput.hidden = false;
    this.el.chatInput.value = '';
    this.el.chatInput.focus();
    document.exitPointerLock?.();
  }

  closeChat() {
    this.el.chatInput.hidden = true;
    this.el.chatInput.blur();
    this.actions.chatClosed?.();
  }

  get chatOpen() { return !this.el.chatInput.hidden; }

  damageNumber(screen, amount, crit = false) {
    const el = document.createElement('div');
    el.className = `dmg-num${crit ? ' crit' : ''}`;
    el.textContent = Math.round(amount);
    el.style.left = `${screen.x}px`;
    el.style.top = `${screen.y}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  /* -------------------------------------------------------------- dock */

  openDock() {
    this.el.dock.hidden = false;
    this.renderDock();
    document.exitPointerLock?.();
  }

  closeDock() { this.el.dock.hidden = true; }
  get dockOpen() { return !this.el.dock.hidden; }

  renderDock() {
    const s = this.state;
    if (!s) return;
    this.el.dockGold.textContent = s.gold.toLocaleString();

    if (s.cargo.length) {
      // Monsters get a row each; fish are grouped by species with a count.
      const rows = [];
      const fishGroups = new Map();
      for (const c of s.cargo) {
        if (c.fish) {
          const g = fishGroups.get(c.id) || { name: c.name, n: 0, gold: 0, kg: 0 };
          g.n++; g.gold += c.bounty; g.kg += c.kg || 0;
          fishGroups.set(c.id, g);
        } else {
          const type = MONSTER_BY_ID[c.id];
          rows.push({ label: type ? type.name : c.name, gold: c.bounty, note: '' });
        }
      }
      for (const g of fishGroups.values()) {
        rows.push({ label: `${g.name} ×${g.n}`, gold: g.gold, note: `${g.kg.toFixed(1)} kg` });
      }
      this.el.dockCargo.replaceChildren(...rows.map((r) => {
        const row = document.createElement('div');
        row.className = 'catch';
        const name = document.createElement('span');
        name.textContent = r.label;
        const note = document.createElement('small');
        note.textContent = r.note;
        note.style.color = 'var(--dim)';
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = `${r.gold.toLocaleString()}g`;
        row.append(name, note, val);
        return row;
      }));
      const total = s.cargo.reduce((a, c) => a + c.bounty, 0);
      this.el.sellBtn.textContent = `Sell the hold — ${total.toLocaleString()}g`;
      this.el.sellBtn.disabled = false;
    } else {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'The hold is empty. The buyers are waiting.';
      this.el.dockCargo.replaceChildren(p);
      this.el.sellBtn.textContent = 'Nothing to sell';
      this.el.sellBtn.disabled = true;
    }

    const missing = s.hullMax - s.hull;
    const repairCost = Math.ceil(missing * CREW.repairPerPoint);
    this.el.repairBtn.textContent = missing > 0 ? `${repairCost.toLocaleString()}g` : 'Sound';
    this.el.repairBtn.disabled = missing <= 0;
    this.el.repairNote.textContent = missing > 0
      ? `${Math.round(missing)} points of hull to make good`
      : 'Hull is sound';

    const hireCost = crewCost(s.tier);
    const needCrew = s.crewMax - s.crew;
    this.el.crewBtn.textContent = needCrew > 0 ? `${hireCost.toLocaleString()}g` : 'Full';
    this.el.crewBtn.disabled = needCrew <= 0 || s.gold < hireCost;
    this.el.crewNote.textContent = needCrew > 0
      ? `${needCrew} berth${needCrew > 1 ? 's' : ''} empty — crew turn the winch faster`
      : 'Every berth filled';

    this.el.dockBoats.replaceChildren(...BOATS.map((b, tier) => {
      const card = document.createElement('div');
      const owned = tier === s.tier;
      const past = tier < s.tier;
      const locked = s.level < b.level;
      const tradeIn = s.tier > 0 ? BOATS[s.tier].price * 0.3 : 0;
      const cost = Math.max(0, Math.round(b.price - tradeIn));
      card.className = `hull-card${owned ? ' owned' : ''}${locked && !past ? ' locked' : ''}`;
      const spec = document.createElement('div');
      spec.className = 'spec';
      spec.innerHTML = `<span>hull <b>${b.hull}</b></span><span>crew <b>${b.crew}</b></span>
        <span>speed <b>${b.speed}</b></span><span>harpoon <b>${b.harpoonDamage}</b></span>
        <span>rope <b>${b.rope}m</b></span><span>hold <b>${b.hold}</b></span>`;
      const h4 = document.createElement('h4');
      h4.textContent = b.name;
      const blurb = document.createElement('div');
      blurb.className = 'blurb';
      blurb.textContent = b.blurb;
      card.append(h4, blurb, spec);
      if (owned) {
        const tag = document.createElement('div');
        tag.className = 'tagline';
        tag.textContent = 'Your command';
        card.append(tag);
      } else if (past) {
        const tag = document.createElement('div');
        tag.className = 'blurb';
        tag.textContent = 'Beneath you now.';
        card.append(tag);
      } else {
        const btn = document.createElement('button');
        if (locked) {
          btn.textContent = `Needs level ${b.level}`;
          btn.disabled = true;
        } else {
          btn.textContent = `${cost.toLocaleString()}g`;
          btn.disabled = s.gold < cost;
          btn.onclick = () => this.actions.dock('buy', tier);
        }
        card.append(btn);
      }
      return card;
    }));
  }

  /* ------------------------------------------------------- death & board */

  showDeath(msg) {
    this.el.deathDetail.textContent = `${msg.by} broke your ${msg.boat} apart.`;
    const losses = [];
    losses.push(`<li>Your <b>${msg.boat}</b> — gone</li>`);
    if (msg.cargo) losses.push(`<li><b>${msg.cargo}</b> catch in the hold — sunk with it</li>`);
    if (msg.gold) losses.push(`<li><b>${msg.gold.toLocaleString()}g</b> paid to the families</li>`);
    this.el.deathLosses.innerHTML = losses.join('');
    this.el.death.hidden = false;
    document.exitPointerLock?.();
  }

  hideDeath() { this.el.death.hidden = true; }

  toggleLeaderboard() { this.el.leaderboard.hidden = !this.el.leaderboard.hidden; }

  get leaderboardOpen() { return !this.el.leaderboard.hidden; }

  setLeaderboard(rows, myId) {
    this.el.leaderboardBody.replaceChildren(...rows.map((r, i) => {
      const tr = document.createElement('tr');
      if (r.id === myId) tr.className = 'me';
      tr.innerHTML = `<td class="n">${i + 1}</td><td>${escapeHtml(r.name)}</td>
        <td>${BOATS[r.tier].name}</td><td class="g">Lv ${r.level}</td>`;
      return tr;
    }));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
