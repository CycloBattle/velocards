'use strict';
/* =====================================================================
   Vélocards : front-end (JS pur, aucun outil de build)
   Toute la logique sensible (boosters, achats, points, récompenses,
   cadeaux, boutique, badges, validation des courses) est dans les
   fonctions SQL et les Edge Functions de Supabase. Ici on ne fait
   qu'afficher.
   ===================================================================== */

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/* ---------- Constantes d'affichage (à garder alignées avec le SQL) ---------- */
const RARITY = {
  common:    { label: 'Commune',           value: 20,   mult: 1 },
  rare:      { label: 'Rare',              value: 60,   mult: 1.1 },
  ultra:     { label: 'Ultra rare',        value: 200,  mult: 1.25 },
  legendary: { label: 'Légendaire',        value: 600,  mult: 1.5 },
  mythic:    { label: 'Mythique vintage',  value: 1500, mult: 1.75 },
};
const RARITY_ORDER = ['common', 'rare', 'ultra', 'legendary', 'mythic'];
const RARITY_COLOR = { common: '#6B7785', rare: '#2C6BD8', ultra: '#7B3FD4', legendary: '#B86A00', mythic: '#6E4A2A' };
const RECYCLE_RATE = 0.12;

/* Barème des courses d'un jour : points de base selon la place réelle (1er au 30e), 0 au-delà */
const POSITION_POINTS = [
  350, 270, 220, 150, 120, 100, 85, 72, 62, 54,
  48, 43, 39, 35, 32, 29, 26, 24, 22, 20,
  18, 16, 14, 12, 10, 8, 6, 4, 3, 2,
];
const MAX_POSITION = POSITION_POINTS.length; // 30
const CAPTAIN_MULT = 2;   // multiplicateur du capitaine...
const CAPTAIN_TOP = 10;   // ...uniquement s'il termine dans le Top 10 réel
const MYTHIC_BONUS = 40;  // bonus fixe des cartes mythiques (coureurs retraités)
const TEAM_SIZE = 8;

/* Prestige des courses : coefficient appliqué à tous les points.
   À garder aligné avec race_multiplier() dans migration_prestige.sql. */
const TIERS = {
  1: { label: 'Tier 1', long: 'Grands Tours & Monuments', mult: 2 },
  2: { label: 'Tier 2', long: 'WorldTour', mult: 1.5 },
  3: { label: 'Tier 3', long: 'ProSeries / Europe Tour', mult: 1 },
};
const tierOf = r => (TIERS[r?.tier_level] ? r.tier_level : 3);
const courseMult = r => TIERS[tierOf(r)].mult;
const fmtMult = m => `×${String(m).replace('.', ',')}`;
function tierBadge(r, { long = false } = {}) {
  const t = tierOf(r);
  return `<span class="tier t${t}" title="${esc(TIERS[t].long)} : points ${fmtMult(TIERS[t].mult)}">${t === 1 ? '★ ' : ''}${TIERS[t].label}${long ? ' · ' + esc(TIERS[t].long) : ''} · ${fmtMult(TIERS[t].mult)}</span>`;
}

/* Arrondi à l'entier inférieur, insensible aux petites erreurs de virgule flottante */
const flo = x => Math.floor(x + 1e-9);

/* Points de base d'une place (0 si hors du Top 30 ou place inconnue) */
function basePoints(pos) {
  return Number.isInteger(pos) && pos >= 1 && pos <= MAX_POSITION ? POSITION_POINTS[pos - 1] : 0;
}

/* Points d'une carte : base x rareté x capitaine (x2 si Top 10) x coefficient de la course.
   Carte mythique : bonus fixe x coefficient de la course.
   Doit rester identique à la fonction SQL validate_race. */
function cardPoints(rarity, pos, isCaptain = false, course = 1) {
  if (rarity === 'mythic') return flo(MYTHIC_BONUS * course);
  const base = basePoints(pos);
  const cap = isCaptain && Number.isInteger(pos) && pos >= 1 && pos <= CAPTAIN_TOP ? CAPTAIN_MULT : 1;
  return flo(base * (RARITY[rarity]?.mult ?? 1) * cap * course);
}

/* Calculateur du score d'une équipe à partir des résultats réels.
   - riders    : tableau de { id, rarity } (les coureurs alignés)
   - captainId : id du coureur capitaine (ou null)
   - results   : tableau de { pos, rider_id } (classement réel enregistré en base)
   - course    : coefficient de la course (1, 1.5 ou 2)
   Renvoie { cards: [{ rider_id, pos, base, mult, isCaptain, captainApplied, course, points }], total } */
function computeTeamScore(riders, captainId, results, course = 1) {
  const posByRider = new Map(results.map(r => [r.rider_id, r.pos]));
  const cards = riders.map(r => {
    const pos = posByRider.has(r.id) ? posByRider.get(r.id) : null;
    const isCaptain = r.id === captainId;
    const mythic = r.rarity === 'mythic';
    const captainApplied = isCaptain && !mythic && pos !== null && pos >= 1 && pos <= CAPTAIN_TOP;
    return {
      rider_id: r.id,
      pos,
      mythic,
      base: mythic ? MYTHIC_BONUS : basePoints(pos),
      mult: RARITY[r.rarity]?.mult ?? 1,
      isCaptain,
      captainApplied,
      course,
      points: cardPoints(r.rarity, pos, isCaptain, course),
    };
  });
  return { cards, total: cards.reduce((s, c) => s + c.points, 0) };
}

const BOOSTERS = {
  bronze: { name: 'Booster Bronze', price: 100, odds: 'Cartes communes, avec 8 % de chances d\'obtenir une rare par carte.' },
  silver: { name: 'Booster Argent', price: 300, odds: 'Communes et rares, avec 6 % de chances d\'obtenir une ultra rare par carte.' },
  gold:   { name: 'Booster Or',     price: 800, odds: 'Rare minimum, 22 % d\'ultra rares, et une fine chance de légendaire ou de mythique vintage.' },
};
const SPECIALTIES = ['sprinteur', 'grimpeur', 'rouleur', 'puncheur', 'classiques', 'complet', 'vintage'];

/* Compétences des coureurs (jauges de type ProCyclingStats).
   STAT_MAX = note qui remplit entièrement la barre (au-delà, la barre reste pleine). */
const STAT_MAX = 1000;
const STAT_DEFS = [
  { key: 'oneday',  label: 'Un jour',  color: '#8ec63f' },
  { key: 'gc',      label: 'GC',       color: '#ed1c24' },
  { key: 'tt',      label: 'TT',       color: '#49b2e8' },
  { key: 'sprint',  label: 'Sprint',   color: '#f8a13f' },
  { key: 'climber', label: 'Grimpeur', color: '#92278f' },
  { key: 'hills',   label: 'Collines', color: '#f05a92' },
];

/* Récompenses quotidiennes : dimanche (0) à vendredi (5) = Bronze, samedi (6) = Argent.
   Doit rester identique à la fonction SQL claim_daily. */
const WEEKDAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const WEEKDAYS_LONG = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const dailyType = dow => (dow === 6 ? 'silver' : 'bronze');

/* Classeur et badges (à garder alignés avec migration_badges.sql) */
const TEAM_MIN = 2;                              // une équipe compte pour un badge à partir de 2 coureurs au catalogue
const NO_TEAM = '_sans-equipe';                  // clé de la page « sans équipe » du classeur
const NO_TEAM_LABEL = 'Légendes et coureurs sans équipe';
const BADGE_TYPES = {
  cards_total:     'Nombre de cartes possédées',
  riders_distinct: 'Nombre de coureurs différents',
  nation:          'Coureurs d\'une même nation',
  rarity:          'Coureurs d\'une même rareté',
  team_complete:   'Équipe complète',
};

/* ---------- Petits outils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coin = n => `${Number(n).toLocaleString('fr-FR')} 🪙`;
const fmtDate = d => new Date(d).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const flag = cc => (cc && cc.length === 2)
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '🏁';
/* Nom du pays en français à partir du code à 2 lettres (le code lui-même si indisponible) */
const regionNames = (() => { try { return new Intl.DisplayNames(['fr'], { type: 'region' }); } catch (e) { return null; } })();
const countryName = cc => {
  if (!cc) return '';
  try { return regionNames?.of(cc.toUpperCase()) || cc; } catch (e) { return cc; }
};
const cap1 = s => String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);
const slug = n => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const IMG_EXTS = ['jpg', 'png', 'webp'];
/* Photo d'un coureur : image_url si renseignée, sinon img/riders/<nom-du-coureur>.jpg (puis .png, puis .webp) */
window.imgFallback = img => {
  const i = +img.dataset.i + 1;
  if (!img.dataset.url && i < IMG_EXTS.length) { img.dataset.i = i; img.src = `img/riders/${img.dataset.slug}.${IMG_EXTS[i]}`; }
  else img.remove();
};
function riderImg(r, lazy = true) {
  const s = slug(r.name);
  const src = r.image_url || `img/riders/${s}.${IMG_EXTS[0]}`;
  return `<img src="${esc(src)}" alt="" ${lazy ? 'loading="lazy"' : ''} data-slug="${s}" data-i="0" ${r.image_url ? 'data-url="1"' : ''} onerror="imgFallback(this)">`;
}
const initials = n => { const w = n.trim().split(/\s+/); return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
const rarityIdx = r => RARITY_ORDER.indexOf(r);
const ordinal = n => (n === 1 ? '1<sup>er</sup>' : `${n}<sup>e</sup>`);
const fmtClock = s => {
  s = Math.max(0, Math.floor(s));
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
/* Compte à rebours avec jours : « 2 j 03:12:45 » */
const fmtCountdown = s => {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), p = n => String(n).padStart(2, '0');
  return `${d > 0 ? d + ' j ' : ''}${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
/* Date ISO vers la valeur d'un champ datetime-local (heure locale) */
const toLocalInput = iso => {
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtPct = n => `${(Math.round(n * 10) / 10).toLocaleString('fr-FR')} %`;
/* Clé de comparaison de noms : sans accents, sans majuscules, espaces simplifiés */
const nameKey = n => String(n ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/* Clé de rapprochement des noms de coureurs (résultats de course) : sans accents, sans ponctuation,
   mots triés. « POGAČAR Tadej » et « Tadej Pogačar » donnent la même clé.
   Doit rester identique à matchKey() dans la fonction process-race-scores. */
const matchKey = n => String(n ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ø/gi, 'o').replace(/ł/gi, 'l').replace(/đ/gi, 'd').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').filter(Boolean).sort().join(' ');
const state = { uid: null, user: null, profile: null, unread: 0, dailyAvailable: false };
let app; // conteneur <main>

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

/* Charge toutes les lignes d'une requête par paquets de 1000 (limite de l'API Supabase).
   make() doit renvoyer une requête neuve, avec un tri stable. */
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await q(make().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3800);
}

function openModal(html, { wide = false } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  return { el: ov, box: $('.modal', ov), close };
}

function confirmBox(text, ok = 'Confirmer') {
  return new Promise(res => {
    const m = openModal(`<h3>${esc(text)}</h3><div class="row"><button class="btn" data-x>Annuler</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`);
    $('[data-x]', m.box).onclick = () => { m.close(); res(false); };
    $('[data-ok]', m.box).onclick = () => { m.close(); res(true); };
  });
}

function askNumber({ title, text = '', value = 1, min = 1, ok = 'Valider' }) {
  return new Promise(res => {
    const m = openModal(`<h3>${esc(title)}</h3><p class="muted">${text}</p>
      <label>Montant en pièces<input type="number" id="num" min="${min}" value="${value}" inputmode="numeric"></label>
      <div class="row"><button class="btn" data-x>Annuler</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`);
    const input = $('#num', m.box); input.focus(); input.select();
    $('[data-x]', m.box).onclick = () => { m.close(); res(null); };
    $('[data-ok]', m.box).onclick = () => { const v = parseInt(input.value, 10); m.close(); res(Number.isFinite(v) ? v : null); };
  });
}

/* Appel RPC avec message d'erreur lisible */
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) { toast(error.message, 'error'); return { ok: false }; }
  return { ok: true, data };
}

/* Appel d'une Edge Function Supabase.
   Renvoie { ok: true, data } si la fonction a répondu { ok: true },
   { ok: false, error } si elle a refusé (message lisible),
   { ok: false, unreachable: true, error } si elle est injoignable (non déployée, panne...). */
async function callFn(name, body) {
  try {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      return { ok: false, unreachable: true, error: `La fonction « ${name} » est injoignable. Vérifie qu'elle est bien déployée dans Supabase (Edge Functions).` };
    }
    if (!data || data.ok !== true) return { ok: false, error: data?.error || 'Réponse vide de la fonction.' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, unreachable: true, error: e?.message || String(e) };
  }
}

/* ---------- Jauges de compétences (composant réutilisable) ----------
   RiderStatsBars(rider, { compact })
   - rider   : objet avec oneday, gc, tt, sprint, climber, hills
   - compact : true = barres fines sans libellés (pour les cartes)
   Renvoie '' si le coureur n'a aucune note (toutes à 0). */
function RiderStatsBars(r, { compact = false } = {}) {
  const vals = STAT_DEFS.map(s => ({ ...s, v: Math.max(0, Number(r?.[s.key]) || 0) }));
  if (!vals.some(s => s.v > 0)) return '';
  return `<div class="rsb ${compact ? 'compact' : ''}">${vals.map(s => `<div class="rsb-row" title="${esc(s.label)} : ${s.v}">
    <span class="rsb-l">${esc(s.label)}</span>
    <span class="rsb-t"><span class="rsb-f" style="width:${Math.min(100, (s.v / STAT_MAX) * 100).toFixed(1)}%;background:${s.color}"></span></span>
    <span class="rsb-v">${s.v}</span></div>`).join('')}</div>`;
}

/* ---------- Composant carte ----------
   Options : cls (classes CSS), attrs (attributs HTML), count (×N), noStats (sans jauges), badge (ex. « ✓ Possédée ») */
function cardHTML(r, o = {}) {
  return `<div class="card r-${r.rarity} ${o.cls || ''}" ${o.attrs || ''}>
    <span class="bib">${String(r.id).padStart(3, '0')}</span>
    ${o.badge ? `<span class="own">${esc(o.badge)}</span>` : ''}
    ${o.count > 1 ? `<span class="count">×${o.count}</span>` : ''}
    <div class="art"><span class="flag">${flag(r.country)}</span><span class="mono">${esc(initials(r.name))}</span>${riderImg(r)}</div>
    <div class="meta"><strong class="nm">${esc(r.name)}</strong><span class="sp">${esc(r.specialty)}${r.team ? ' · ' + esc(r.team) : ''}</span><span class="rar">${RARITY[r.rarity].label}</span>${o.noStats ? '' : RiderStatsBars(r, { compact: true })}</div>
  </div>`;
}

/* Fenêtre de détail d'un coureur : carte + jauges complètes.
   count = nombre d'exemplaires possédés ; owned = false pour signaler une carte non possédée. */
function showRiderDetail(r, count = 0, owned = null) {
  const m = openModal(`<div class="detail">
      <div class="detail-card">${cardHTML(r, { noStats: true })}</div>
      <div class="detail-info">
        <h2>${esc(r.name)}</h2>
        <p class="muted">${flag(r.country)} ${esc(r.specialty)}${r.team ? ' · ' + esc(r.team) : ''} · ${RARITY[r.rarity].label}</p>
        ${RiderStatsBars(r) || '<p class="muted">Compétences non renseignées.</p>'}
        ${count ? `<p class="muted" style="margin-top:.8rem">Exemplaires : ${count}</p>`
          : owned === false ? '<p class="muted" style="margin-top:.8rem">Tu ne possèdes pas encore cette carte.</p>' : ''}
      </div>
    </div>
    <div class="row"><button class="btn primary" data-x>Fermer</button></div>`);
  $('[data-x]', m.box).onclick = m.close;
}

/* Tableau du barème (1er au 30e) : utilisé dans l'onglet Équipe et le Portefeuille */
function baremeTable() {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Place</th><th class="num">Points de base</th><th class="num">Capitaine ×${CAPTAIN_MULT}</th></tr></thead>
    <tbody>${POSITION_POINTS.map((v, i) => `<tr><td>${ordinal(i + 1)}</td><td class="num">${v}</td>
      <td class="num">${i + 1 <= CAPTAIN_TOP ? v * CAPTAIN_MULT : '–'}</td></tr>`).join('')}
    <tr><td>Au-delà de la ${MAX_POSITION}<sup>e</sup></td><td class="num">0</td><td class="num">–</td></tr></tbody>
  </table></div>`;
}

/* ---------- Badges : texte de la condition, progression, icône, galerie ---------- */
function criteriaText(b) {
  const v = b.criteria_value, t = b.criteria_target || '';
  switch (b.criteria_type) {
    case 'cards_total':     return `Posséder ${v} carte${v > 1 ? 's' : ''}`;
    case 'riders_distinct': return `Posséder ${v} coureur${v > 1 ? 's' : ''} différent${v > 1 ? 's' : ''}`;
    case 'nation':          return `Posséder ${v} coureur${v > 1 ? 's' : ''} ${flag(t)} ${countryName(t)}`;
    case 'rarity':          return `Posséder ${v} coureur${v > 1 ? 's' : ''} ${RARITY[t]?.label || t}`;
    case 'team_complete':   return t ? `Compléter le classeur de ${t}` : `Compléter ${v} équipe${v > 1 ? 's' : ''}`;
    default:                return '';
  }
}

/* Contexte de calcul de la progression : cards = cartes possédées [{ rider_id }], riders = catalogue [{ id, team, country, rarity }] */
function makeBadgeCtx(cards, riders) {
  return { total: cards.length, owned: new Set(cards.map(c => c.rider_id)), riders };
}

/* Progression d'un badge { cur, target }. Doit rester identique à _badge_met() dans migration_badges.sql. */
function badgeProgress(b, ctx) {
  const v = b.criteria_value, t = b.criteria_target || '';
  const ownedRiders = ctx.riders.filter(r => ctx.owned.has(r.id));
  switch (b.criteria_type) {
    case 'cards_total':     return { cur: ctx.total, target: v };
    case 'riders_distinct': return { cur: ownedRiders.length, target: v };
    case 'nation':          return { cur: ownedRiders.filter(r => r.country === t).length, target: v };
    case 'rarity':          return { cur: ownedRiders.filter(r => r.rarity === t).length, target: v };
    case 'team_complete': {
      const teams = new Map();
      ctx.riders.forEach(r => {
        if (!r.team) return;
        const s = teams.get(r.team) || { total: 0, got: 0 };
        s.total++;
        if (ctx.owned.has(r.id)) s.got++;
        teams.set(r.team, s);
      });
      if (t) {
        const s = teams.get(t);
        return s ? { cur: s.got, target: Math.max(s.total, TEAM_MIN) } : { cur: 0, target: TEAM_MIN };
      }
      let done = 0;
      teams.forEach(s => { if (s.total >= TEAM_MIN && s.got === s.total) done++; });
      return { cur: done, target: v };
    }
    default: return { cur: 0, target: v };
  }
}

function badgeIcon(b) {
  return b.icon_url
    ? `<img src="${esc(b.icon_url)}" alt="" data-fb="${esc(b.icon || '🏅')}" onerror="this.replaceWith(document.createTextNode(this.dataset.fb))">`
    : esc(b.icon || '🏅');
}

/* Galerie de badges : débloqués en couleur, les autres grisés (avec leur progression si ctx est fourni) */
function badgesGalleryHTML(badges, unlocked, ctx) {
  if (!badges.length) return '<p class="muted">Aucun badge à débloquer pour le moment.</p>';
  const list = [...badges].sort((a, b) =>
    (unlocked.has(b.id) ? 1 : 0) - (unlocked.has(a.id) ? 1 : 0) || a.title.localeCompare(b.title));
  return `<div class="badges-grid">${list.map(b => {
    const at = unlocked.get(b.id);
    let foot = '';
    if (at) {
      foot = `<span class="bdate">✓ Obtenu le ${esc(new Date(at).toLocaleDateString('fr-FR'))}</span>`;
    } else if (ctx) {
      const pr = badgeProgress(b, ctx);
      const cur = Math.min(pr.cur, pr.target);
      foot = `<div class="prog"><span style="width:${pr.target ? (cur / pr.target) * 100 : 0}%"></span></div><span class="bgoal">${cur} / ${pr.target}</span>`;
    }
    return `<div class="badge-tile ${at ? 'got' : 'locked'}">
      <div class="bicon">${badgeIcon(b)}</div>
      <b>${esc(b.title)}</b>
      ${b.description ? `<span class="bgoal">${esc(b.description)}</span>` : ''}
      <span class="bgoal">${esc(criteriaText(b))}</span>
      ${foot}</div>`;
  }).join('')}</div>`;
}

/* Vitrine (3 cartes favorites) et badges d'un joueur. Silencieux si le SQL n'est pas encore installé. */
async function loadShowcase(userId) {
  try {
    const [favRows, badges, ubRows] = await Promise.all([
      q(sb.from('user_favorites').select('slot_index,rider_id,riders(*)').eq('user_id', userId)),
      q(sb.from('badges').select('*').order('criteria_type').order('criteria_value')),
      q(sb.from('user_badges').select('badge_id,unlocked_at').eq('user_id', userId)),
    ]);
    const favs = [null, null, null];
    favRows.forEach(f => { if (f.riders && f.slot_index >= 0 && f.slot_index < 3) favs[f.slot_index] = f.riders; });
    return {
      missing: false, favs,
      badges: badges.filter(b => b.is_active),
      unlocked: new Map(ubRows.map(u => [u.badge_id, u.unlocked_at])),
    };
  } catch (e) {
    return { missing: true, favs: [null, null, null], badges: [], unlocked: new Map() };
  }
}

/* Vitrine en lecture seule (profil public) */
function favsReadonlyHTML(favs) {
  if (!favs.some(Boolean)) return '<p class="muted">Aucune carte exposée pour le moment.</p>';
  return `<div class="fav-grid">${favs.map(r => r
    ? `<div class="fav-slot"><div class="card-wrap">${cardHTML(r, { cls: 'pick', attrs: `data-fav-rid="${r.id}" tabindex="0"` })}</div></div>`
    : '<div class="fav-slot"></div>').join('')}</div>`;
}

/* ---------- Données partagées ---------- */
const myCards = () => q(sb.from('user_cards').select('id,rider_id,acquired_at,riders(*)').eq('owner_id', state.uid));

/* Stock de boosters non ouverts (tableau { type, quantity }, trié comme BOOSTERS) */
async function myBoosters() {
  const rows = await q(sb.from('user_boosters').select('type,quantity').eq('owner_id', state.uid).gt('quantity', 0));
  const order = Object.keys(BOOSTERS);
  return rows.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

/* État des récompenses quotidiennes, calculé par le serveur (jour de Paris) */
async function fetchDaily() {
  const { data, error } = await sb.rpc('daily_status');
  if (error) throw error;
  return data;
}

/* Met à jour le badge « récompense disponible » (silencieux si le SQL n'est pas encore installé) */
async function refreshDaily() {
  try {
    const st = await fetchDaily();
    state.dailyAvailable = !st.claimed;
  } catch (e) {
    state.dailyAvailable = false;
  }
  updateChrome();
}

function groupByRider(cards) {
  const m = new Map();
  for (const c of cards) {
    if (!m.has(c.rider_id)) m.set(c.rider_id, { rider: c.riders, cards: [] });
    m.get(c.rider_id).cards.push(c);
  }
  return [...m.values()];
}

/* Cartes en vente (listed) ou engagées dans une équipe à venir (locked) */
async function lockInfo() {
  const listed = await q(sb.from('listings').select('card_id').eq('seller_id', state.uid).eq('status', 'active'));
  const locked = await q(sb.from('lineup_cards')
    .select('user_card_id, lineups!inner(user_id, races!inner(status))')
    .eq('lineups.user_id', state.uid).eq('lineups.races.status', 'upcoming'));
  return {
    listed: new Set(listed.map(x => x.card_id)),
    locked: new Set(locked.map(x => x.user_card_id).filter(Boolean)),
  };
}

/* Pseudos à partir d'identifiants (par paquets de 80 pour garder des adresses de requête courtes) */
async function usernames(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const out = {};
  for (let i = 0; i < uniq.length; i += 80) {
    const rows = await q(sb.from('public_profiles').select('id,username').in('id', uniq.slice(i, i + 80)));
    rows.forEach(r => { out[r.id] = r.username; });
  }
  return out;
}

/* Grille de collection avec filtres (utilisée par « Collection » et « Profil »).
   Un clic sur une carte ouvre le détail avec les jauges complètes. */
function mountCollection(target, cards) {
  const groups = groupByRider(cards);
  target.innerHTML = `
    <div class="filters">
      <label>Rareté<select id="fr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Recherche<input id="fq" placeholder="Nom du coureur"></label>
      <label>Tri<select id="fs"><option value="rar">Rareté</option><option value="name">Nom</option><option value="recent">Plus récentes</option></select></label>
    </div>
    <div class="cards" id="grid"></div>`;
  const draw = () => {
    const fr = $('#fr', target).value, fq = $('#fq', target).value.toLowerCase(), fs = $('#fs', target).value;
    let list = groups.filter(g => (!fr || g.rider.rarity === fr) && g.rider.name.toLowerCase().includes(fq));
    list.sort((a, b) => fs === 'name' ? a.rider.name.localeCompare(b.rider.name)
      : fs === 'recent' ? Math.max(...b.cards.map(c => +new Date(c.acquired_at))) - Math.max(...a.cards.map(c => +new Date(c.acquired_at)))
      : rarityIdx(b.rider.rarity) - rarityIdx(a.rider.rarity) || a.rider.name.localeCompare(b.rider.name));
    $('#grid', target).innerHTML = list.length
      ? list.map(g => `<div class="card-wrap">${cardHTML(g.rider, { count: g.cards.length, cls: 'pick', attrs: `data-rid="${g.rider.id}" tabindex="0"` })}</div>`).join('')
      : `<p class="muted">Aucune carte ne correspond.</p>`;
    $$('#grid .card', target).forEach(c => {
      const open = () => {
        const g = groups.find(x => x.rider.id === +c.dataset.rid);
        if (g) showRiderDetail(g.rider, g.cards.length);
      };
      c.onclick = open;
      c.onkeydown = e => { if (e.key === 'Enter') open(); };
    });
  };
  $$('select,input', target).forEach(el => el.oninput = draw);
  draw();
}

/* =====================================================================
   CONNEXION
   ===================================================================== */
function renderAuth(mode = 'login') {
  const login = mode === 'login';
  $('#root').innerHTML = `
  <div class="auth"><div class="auth-box">
    <div class="auth-fan"><span></span><span></span><span></span><span></span></div>
    <h1>Vélocards</h1>
    <p class="muted">Collectionne les coureurs, aligne ton équipe de ${TEAM_SIZE} avant chaque course et gagne des pièces selon les vraies performances.</p>
    <form id="authForm">
      <label>Pseudo<input name="u" autocomplete="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" title="3 à 20 caractères : lettres, chiffres ou _"></label>
      <label>Mot de passe<input name="p" type="password" autocomplete="${login ? 'current-password' : 'new-password'}" required minlength="6"></label>
      <button class="btn primary" type="submit">${login ? 'Se connecter' : 'Créer mon compte'}</button>
      <p id="authErr" class="error" role="alert"></p>
    </form>
    <p>${login ? 'Pas encore de compte ?' : 'Déjà un compte ?'} <a href="#" id="swap">${login ? 'Créer un compte' : 'Se connecter'}</a></p>
  </div></div>`;
  $('#swap').onclick = e => { e.preventDefault(); renderAuth(login ? 'signup' : 'login'); };
  $('#authForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = $('button', f), err = $('#authErr');
    const u = f.u.value.trim().toLowerCase(), p = f.p.value;
    const email = `${u}@velocards.game`;
    btn.disabled = true; err.textContent = '';
    const res = login
      ? await sb.auth.signInWithPassword({ email, password: p })
      : await sb.auth.signUp({ email, password: p, options: { data: { username: u } } });
    btn.disabled = false;
    if (res.error) {
      const m = res.error.message;
      err.textContent = /Invalid login/i.test(m) ? 'Pseudo ou mot de passe incorrect.'
        : /already registered|duplicate|unique/i.test(m) ? 'Ce pseudo est déjà pris.'
        : /Database error/i.test(m) ? 'Pseudo invalide ou déjà pris.'
        : m;
    } else if (!login && !res.data.session) {
      err.textContent = 'Compte créé, mais la confirmation par e-mail est activée dans Supabase : désactive « Confirm email » (voir le README).';
    }
  };
}

/* =====================================================================
   COQUE + ROUTEUR
   ===================================================================== */
const NAV = [
  ['boutique', 'Boutique'], ['recompenses', 'Récompenses'], ['collection', 'Collection'], ['classeur', 'Classeur'], ['vitrine', 'Vitrine'], ['equipe', 'Équipe'],
  ['transferts', 'Transferts'], ['messages', 'Messagerie'], ['portefeuille', 'Portefeuille'],
  ['classement', 'Classement UCI'],
];

function renderShell() {
  const p = state.profile;
  $('#root').innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/boutique">Vélo<small>cards</small></a>
      <a class="wallet" id="wallet" href="#/portefeuille" title="Ton portefeuille"></a>
      <a class="who" href="#/profil/${encodeURIComponent(p.username)}">${esc(p.username)}</a>
      <button class="btn small" id="logout" style="color:#fff;border-color:#fff">Quitter</button>
    </header>
    <nav class="nav" id="nav">
      ${NAV.map(([k, l]) => `<a href="#/${k}" data-r="${k}">${l}<span class="badge" data-badge="${k}" hidden></span></a>`).join('')}
      ${p.is_admin ? `<a href="#/admin" data-r="admin">Admin</a>` : ''}
    </nav>
    <main id="app"></main>`;
  app = $('#app');
  $('#logout').onclick = () => sb.auth.signOut();
  updateChrome();
}

function updateChrome() {
  const w = $('#wallet'); if (w && state.profile) w.textContent = coin(state.profile.coins);
  const b = $('[data-badge="messages"]');
  if (b) { b.hidden = !state.unread; b.textContent = state.unread; }
  const d = $('[data-badge="recompenses"]');
  if (d) { d.hidden = !state.dailyAvailable; d.textContent = '1'; }
}

async function refreshProfile() {
  state.profile = await q(sb.from('profiles').select('*').eq('id', state.uid).single());
  const { count } = await sb.from('messages').select('id', { count: 'exact', head: true }).gt('created_at', state.profile.last_seen_messages);
  state.unread = count || 0;
  updateChrome();
}

const ROUTES = {
  boutique: pageShop, recompenses: pageRewards, collection: pageCollection, classeur: pageAlbum, vitrine: pageShowcase, equipe: pageTeam, transferts: pageTransfers,
  messages: pageMessages, portefeuille: pageWallet, classement: pageRanking, profil: pageProfile, admin: pageAdmin,
};

async function route() {
  if (!state.uid || !app) return;
  const [rawName = 'boutique', ...args] = location.hash.replace(/^#\/?/, '').split('/');
  const name = rawName === 'boosters' ? 'boutique' : rawName;   // anciens liens « Boosters »
  const key = ROUTES[name] ? name : 'boutique';
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === key));
  app.innerHTML = '<p class="muted">Chargement…</p>';
  try { await ROUTES[key](...args.map(decodeURIComponent)); }
  catch (e) { console.error(e); app.innerHTML = `<p class="error">Erreur : ${esc(e.message || e)}</p>`; }
}
window.addEventListener('hashchange', route);

async function handleSession(session) {
  const uid = session?.user?.id || null;
  if (uid === state.uid && uid) return;          // simple rafraîchissement du jeton
  state.uid = uid; state.user = session?.user || null;
  if (!uid) { state.profile = null; state.dailyAvailable = false; app = null; renderAuth(); return; }
  try {
    try { await sb.rpc('check_my_badges'); } catch (e) { /* badges non installés : on continue */ }
    await refreshProfile();
    await refreshDaily();
    renderShell();
    route();
  } catch (e) {
    $('#root').innerHTML = `<div class="auth"><div class="auth-box"><h2>Profil introuvable</h2><p class="error">${esc(e.message)}</p><p class="muted">Vérifie que schema.sql a bien été exécuté dans Supabase.</p></div></div>`;
  }
}
sb.auth.onAuthStateChange((_evt, session) => setTimeout(() => handleSession(session), 0));

/* =====================================================================
   BOOSTERS EN STOCK (partagé entre « Boutique » et « Récompenses »)
   ===================================================================== */
function stockHTML(stock) {
  if (!stock.length) return '';
  return `<div class="panel stock">
    <h2>Mes boosters gratuits</h2>
    <p class="muted">Ces boosters t'appartiennent déjà : les ouvrir ne coûte aucune pièce.</p>
    ${stock.map(s => `<div class="stock-row">
      <span class="dpack ${s.type}"></span>
      <div class="grow"><b>${esc(BOOSTERS[s.type].name)}</b> ×${s.quantity}</div>
      <button class="btn primary small" data-stock="${s.type}">Ouvrir</button>
    </div>`).join('')}
  </div>`;
}

/* Ouvre un booster du stock. Renvoie true si l'ouverture a réussi. */
async function openStored(type) {
  const r = await rpc('open_stored_booster', { p_type: type });
  if (!r.ok) return false;
  showReveal(type, r.data);
  return true;
}

function bindStock(refresh) {
  $$('[data-stock]').forEach(b => b.onclick = async () => {
    $$('[data-stock]').forEach(x => x.disabled = true);
    const ok = await openStored(b.dataset.stock);
    if (ok) refresh(); else $$('[data-stock]').forEach(x => x.disabled = false);
  });
}

/* =====================================================================
   PAGE : BOUTIQUE
   1. Boosters éphémères (offres limitées, créées par l'admin)
   2. Boosters permanents (Bronze, Argent, Or)
   3. Offres spéciales (cartes vendues à l'unité)
   ===================================================================== */
let shopTimer = null;

/* Probabilités normalisées d'une composition : [{ rarity, pct }] (rarétés à 0 % masquées) */
function compOdds(comp) {
  const w = comp?.weights || {};
  const total = RARITY_ORDER.reduce((s, r) => s + Math.max(0, Number(w[r]) || 0), 0);
  return RARITY_ORDER
    .map(r => ({ rarity: r, pct: total ? (Math.max(0, Number(w[r]) || 0) / total) * 100 : 0 }))
    .filter(o => o.pct > 0);
}
function guaranteeText(comp) {
  const g = comp?.guarantee;
  if (!g || !g.count || !RARITY[g.rarity]) return '';
  return `Garanti : au moins ${g.count} carte${g.count > 1 ? 's' : ''} ${RARITY[g.rarity].label.toLowerCase()} ou mieux.`;
}
const ephPoolSize = b => (Array.isArray(b.composition_json?.rider_ids) ? b.composition_json.rider_ids.length : 0);

/* Fenêtre « Voir le contenu » d'un booster éphémère : probabilités, garantie et pool de coureurs */
async function showEphInfo(b) {
  const comp = b.composition_json || {};
  const ids = Array.isArray(comp.rider_ids) ? comp.rider_ids : [];
  let pool = [];
  if (ids.length) {
    try { pool = await q(sb.from('riders').select('*').in('id', ids.slice(0, 60))); } catch (e) { pool = []; }
    pool.sort((a, c) => rarityIdx(c.rarity) - rarityIdx(a.rarity) || a.name.localeCompare(c.name));
  }
  const odds = compOdds(comp);
  const m = openModal(`<h2>${esc(b.name)}</h2>
    ${b.description ? `<p class="muted">${esc(b.description)}</p>` : ''}
    <p><b>${comp.cards || 5} cartes</b> par booster · <b>${coin(b.price)}</b></p>
    <h3>Probabilités par carte</h3>
    <div class="odds">${odds.map(o => `<div class="odds-row"><span>${RARITY[o.rarity].label}</span><b>${fmtPct(o.pct)}</b></div>`).join('')}</div>
    ${guaranteeText(comp) ? `<p><b>${esc(guaranteeText(comp))}</b></p>` : ''}
    <h3>${ids.length ? `Pool de coureurs (${ids.length})` : 'Pool de coureurs'}</h3>
    ${ids.length
      ? `<div class="cards">${pool.map(r => `<div class="card-wrap">${cardHTML(r)}</div>`).join('')}</div>
         ${ids.length > pool.length ? `<p class="muted" style="margin-top:.6rem">… et ${ids.length - pool.length} autre${ids.length - pool.length > 1 ? 's' : ''} coureur${ids.length - pool.length > 1 ? 's' : ''}.</p>` : ''}`
      : '<p class="muted">Pas de pool restreint : les cartes sont tirées dans tout le catalogue, selon les probabilités ci-dessus.</p>'}
    <div class="row"><button class="btn primary" data-x>Fermer</button></div>`, { wide: true });
  $('[data-x]', m.box).onclick = m.close;
}

async function pageShop() {
  if (shopTimer) { clearInterval(shopTimer); shopTimer = null; }

  let stock = [];
  try { stock = await myBoosters(); } catch (e) { stock = []; }

  let eph = [], offers = [], shopMissing = false;
  const owned = new Map();                     // rider_id -> nombre d'exemplaires possédés
  try {
    const [e, o, ownedRows] = await Promise.all([
      q(sb.from('ephemeral_boosters').select('*').eq('is_active', true).gt('end_date', new Date().toISOString()).order('end_date')),
      q(sb.from('shop_cards').select('id,price,stock,rider_id,riders(*)').eq('is_active', true).order('created_at', { ascending: false })),
      fetchAll(() => sb.from('user_cards').select('rider_id').eq('owner_id', state.uid).order('id')),
    ]);
    eph = e;
    offers = o.filter(x => x.riders);
    ownedRows.forEach(c => owned.set(c.rider_id, (owned.get(c.rider_id) || 0) + 1));
  } catch (err) {
    shopMissing = true;
  }

  const isLive = b => +new Date(b.start_date) <= Date.now();

  const ephHTML = eph.map(b => {
    const live = isLive(b);
    const comp = b.composition_json || {};
    const pool = ephPoolSize(b);
    return `<article class="pack pack-eph">
      <span class="pill ${live ? 'eph-pill' : 'soon'}">${live ? 'Édition limitée' : 'Bientôt disponible'}</span>
      <div class="foil"><span>${esc(b.name)}</span>${b.image_url ? `<img src="${esc(b.image_url)}" alt="" onload="this.parentElement.classList.add('has-img')" onerror="this.remove()">` : ''}</div>
      <div class="cd-box">${live ? 'Se termine dans' : 'Commence dans'}
        <div class="cd" data-cd="${esc(live ? b.end_date : b.start_date)}">--</div></div>
      ${b.description ? `<p>${esc(b.description)}</p>` : ''}
      <p class="pool-note">${comp.cards || 5} cartes${pool ? ` · pool de ${pool} coureur${pool > 1 ? 's' : ''}` : ' · tout le catalogue'}</p>
      <div class="btn-row">
        <button class="btn small" data-eph-info="${b.id}">Voir le contenu</button>
        <button class="btn primary" data-eph-buy="${b.id}" ${live ? '' : 'disabled'}>${live ? `Acheter pour ${coin(b.price)}` : 'Pas encore ouvert'}</button>
      </div>
    </article>`;
  }).join('');

  const offersHTML = offers.map(o => {
    const r = o.riders;
    const n = owned.get(r.id) || 0;
    const out = o.stock !== null && o.stock <= 0;
    return `<div class="card-wrap">${cardHTML(r, {
      cls: 'pick ' + (out ? 'soldout' : ''), attrs: `data-rid="${r.id}" tabindex="0"`,
      badge: n ? '✓ Possédée' : '', count: n,
    })}
      <div><b>${coin(o.price)}</b>${o.stock !== null
        ? `<br><span class="muted">${out ? 'Épuisé' : `Plus que ${o.stock} exemplaire${o.stock > 1 ? 's' : ''}`}</span>` : ''}</div>
      <button class="btn primary small" data-shop-buy="${o.id}" ${out ? 'disabled' : ''}>${out ? 'Épuisé' : 'Acheter'}</button></div>`;
  }).join('');

  app.innerHTML = `<h1>Boutique</h1>
    <p class="lead">Boosters à durée limitée, boosters permanents et cartes à l'unité. Chaque booster contient des cartes de coureurs : aligne-les avant les courses pour gagner des pièces.</p>
    ${state.dailyAvailable ? `<div class="panel row">
      <div class="grow"><b>Ton booster gratuit du jour t'attend !</b></div>
      <a class="btn primary" href="#/recompenses" style="text-decoration:none">Aller aux récompenses</a></div>` : ''}
    ${shopMissing && state.profile.is_admin ? `<div class="panel"><b class="error">Tables de la boutique introuvables.</b>
      <span class="muted"> Exécute migration_shop.sql dans Supabase pour activer les boosters éphémères et les offres spéciales.</span></div>` : ''}
    ${stockHTML(stock)}

    ${eph.length ? `<section class="shop-sec">
      <h2>Boosters éphémères</h2>
      <p class="sub">Offres limitées dans le temps : une fois le compte à rebours terminé, elles disparaissent.</p>
      <div class="boosters">${ephHTML}</div></section>` : ''}

    <section class="shop-sec">
      <h2>Boosters permanents</h2>
      <p class="sub">Toujours disponibles. Chaque booster contient 5 cartes.</p>
      <div class="boosters">${Object.entries(BOOSTERS).map(([k, b]) => `
        <article class="pack pack-${k}">
          <div class="foil"><span>${b.name}</span><img src="img/boosters/${k}.png" alt="" onload="this.parentElement.classList.add('has-img')" onerror="this.remove()"></div>
          <p>${b.odds}</p>
          <button class="btn primary" data-open="${k}">Ouvrir pour ${coin(b.price)}</button>
        </article>`).join('')}</div></section>

    ${offers.length ? `<section class="shop-sec">
      <h2>Offres spéciales</h2>
      <p class="sub">Des cartes précises, vendues directement. Clique sur une carte pour voir toutes ses compétences.</p>
      <div class="cards" id="offerGrid">${offersHTML}</div></section>` : ''}`;

  bindStock(() => pageShop());

  /* ----- Boosters permanents ----- */
  $$('[data-open]').forEach(btn => btn.onclick = async () => {
    const type = btn.dataset.open;
    if (state.profile.coins < BOOSTERS[type].price) return toast('Pas assez de pièces pour ce booster.', 'error');
    $$('[data-open]').forEach(b => b.disabled = true);
    const r = await rpc('open_booster', { p_type: type });
    $$('[data-open]').forEach(b => b.disabled = false);
    if (!r.ok) return;
    await refreshProfile();
    showReveal(type, r.data);
  });

  /* ----- Boosters éphémères : contenu et achat ----- */
  $$('[data-eph-info]').forEach(btn => btn.onclick = () => {
    const b = eph.find(x => x.id === btn.dataset.ephInfo);
    if (b) showEphInfo(b);
  });
  $$('[data-eph-buy]').forEach(btn => btn.onclick = async () => {
    const b = eph.find(x => x.id === btn.dataset.ephBuy);
    if (!b) return;
    if (state.profile.coins < b.price) return toast('Pas assez de pièces pour ce booster.', 'error');
    if (!await confirmBox(`Acheter « ${b.name} » pour ${b.price} pièces ?`, 'Acheter')) return;
    $$('[data-eph-buy]').forEach(x => x.disabled = true);
    const r = await rpc('buy_ephemeral_booster', { p_id: b.id });
    if (!r.ok) { pageShop(); return; }
    await refreshProfile();
    showReveal('eph', r.data, b.name);
    pageShop();
  });

  /* ----- Offres spéciales : détail et achat ----- */
  const grid = $('#offerGrid');
  if (grid) {
    const openOffer = el => {
      const c = el.closest('.card');
      if (!c) return;
      const o = offers.find(x => x.riders.id === +c.dataset.rid);
      if (!o) return;
      const n = owned.get(o.riders.id) || 0;
      showRiderDetail(o.riders, n, n > 0);
    };
    grid.onclick = e => { if (!e.target.closest('button')) openOffer(e.target); };
    grid.onkeydown = e => { if (e.key === 'Enter' && !e.target.closest('button')) openOffer(e.target); };
  }
  $$('[data-shop-buy]').forEach(btn => btn.onclick = async () => {
    const o = offers.find(x => x.id === btn.dataset.shopBuy);
    if (!o) return;
    if (state.profile.coins < o.price) return toast('Pas assez de pièces pour cette carte.', 'error');
    if (!await confirmBox(`Acheter ${o.riders.name} pour ${o.price} pièces ?`, 'Acheter')) return;
    btn.disabled = true;
    const r = await rpc('buy_shop_card', { p_shop_id: o.id });
    if (!r.ok) { pageShop(); return; }
    await refreshProfile();
    showReveal('shop', [r.data], 'Carte achetée');
    pageShop();
  });

  /* ----- Comptes à rebours (un seul minuteur pour toute la page) ----- */
  if (eph.length) {
    const tick = () => {
      const els = $$('[data-cd]');
      if (!els.length || !document.body.contains(els[0])) { clearInterval(shopTimer); shopTimer = null; return; }
      let reload = false;
      els.forEach(el => {
        const left = Math.ceil((+new Date(el.dataset.cd) - Date.now()) / 1000);
        if (left <= 0) reload = true; else el.textContent = fmtCountdown(left);
      });
      if (reload) { clearInterval(shopTimer); shopTimer = null; pageShop().catch(() => {}); }
    };
    shopTimer = setInterval(tick, 1000);
    tick();
  }
}

/* Animation d'ouverture : cartes face cachée à retourner.
   type = booster permanent (bronze, silver, gold) ou libre ('eph', 'shop') avec un titre. */
function showReveal(type, cards, title) {
  cards = [...cards].sort((a, b) => rarityIdx(a.rarity) - rarityIdx(b.rarity)); // la meilleure en dernier
  const heading = title || BOOSTERS[type]?.name || 'Ouverture';
  const m = openModal(`<div class="reveal">
    <h2>${esc(heading)}</h2>
    <p class="muted" style="text-align:center">Clique sur chaque carte pour la retourner.</p>
    <div class="reveal-grid">${cards.map(c => `
      <div class="flip" tabindex="0" role="button" aria-label="Retourner la carte">
        <div class="flip-in"><div class="face back"><img src="img/card-back.png" alt="" onload="this.parentElement.classList.add('has-img')" onerror="this.remove()"></div>
        <div class="face front">${cardHTML({ ...c, id: c.rider_id })}</div></div>
      </div>`).join('')}</div>
    <div class="row" style="justify-content:center">
      <button class="btn" id="revAll">Tout révéler</button>
      <button class="btn primary" id="revClose">Terminer</button>
    </div></div>`, { wide: true });
  $$('.flip', m.box).forEach(f => {
    const go = () => f.classList.add('up');
    f.onclick = go; f.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
  $('#revAll', m.box).onclick = () => $$('.flip', m.box).forEach((f, i) => setTimeout(() => f.classList.add('up'), i * 180));
  $('#revClose', m.box).onclick = m.close;
}

/* =====================================================================
   PAGE : RÉCOMPENSES QUOTIDIENNES
   Dimanche à vendredi : 1 booster Bronze gratuit. Samedi : 1 booster Argent.
   Le jour change à minuit (heure de Paris). Tout est décidé par le serveur.
   ===================================================================== */
async function pageRewards() {
  const draw = async () => {
    const [st, stock] = await Promise.all([fetchDaily(), myBoosters()]);
    state.dailyAvailable = !st.claimed;
    updateChrome();

    const todayType = dailyType(st.dow);
    const tomorrowType = dailyType((st.dow + 1) % 7);
    const base = new Date(st.today + 'T00:00:00Z');
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base.getTime() + (i - st.dow) * 864e5);
      const iso = d.toISOString().slice(0, 10);
      let status;
      if (iso < st.today) status = st.claimed_dates.includes(iso) ? 'done' : 'missed';
      else if (iso === st.today) status = st.claimed ? 'done' : 'available';
      else status = 'future';
      return { i, iso, num: d.getUTCDate(), type: dailyType(i), status };
    });

    const hero = st.claimed
      ? `<div class="panel daily-hero">
          <span class="dpack ${todayType} big"></span>
          <div class="info">
            <h2>Récompense du jour réclamée ✓</h2>
            <p class="muted">Reviens demain ! Ton prochain booster : <b>${BOOSTERS[tomorrowType].name}</b>.</p>
            <p class="muted" style="margin:0">Prochaine récompense dans</p>
            <div class="countdown" id="countdown">--:--:--</div>
          </div>
          <button class="btn big" disabled>Déjà réclamé</button>
        </div>`
      : `<div class="panel daily-hero ready">
          <span class="dpack ${todayType} big"></span>
          <div class="info">
            <h2>${WEEKDAYS_LONG[st.dow]} : ${BOOSTERS[todayType].name} offert</h2>
            <p class="muted">${todayType === 'silver' ? 'Le samedi, la récompense passe au booster Argent !' : 'Un booster gratuit chaque jour, du dimanche au vendredi.'}</p>
            <p class="muted" style="margin:0">À réclamer avant minuit (encore)</p>
            <div class="countdown" id="countdown">--:--:--</div>
          </div>
          <button class="btn primary big pulse" id="claim">Réclamer mon booster</button>
        </div>`;

    app.innerHTML = `<h1>Récompenses</h1>
      <p class="lead">Connecte-toi chaque jour pour récupérer un booster gratuit. Du dimanche au vendredi, c'est un Bronze. Le samedi, c'est un Argent. Le compteur repart à zéro à minuit, heure de Paris.</p>
      ${hero}
      <h2>Cette semaine</h2>
      <div class="week">${days.map(d => `
        <div class="day ${d.status === 'available' ? 'today' : ''} ${d.iso === st.today ? 'today' : ''} ${d.status === 'done' ? 'done' : ''} ${d.status === 'missed' ? 'missed' : ''} ${d.i === 6 ? 'sat' : ''}">
          ${d.i === 6 ? '<span class="ribbon">SPÉCIAL</span>' : ''}
          ${d.status === 'done' ? '<span class="tick" aria-hidden="true">✓</span>' : ''}
          <span class="dn">${WEEKDAYS[d.i]}</span>
          <span class="dd">${d.num}</span>
          <span class="dpack ${d.type}"></span>
          <span class="reward">${d.type === 'silver' ? 'Argent' : 'Bronze'}</span>
          <span class="st">${d.status === 'done' ? 'Réclamé' : d.status === 'available' ? 'À réclamer' : d.status === 'missed' ? 'Manqué' : '&nbsp;'}</span>
        </div>`).join('')}</div>
      ${stockHTML(stock)}`;

    bindStock(() => draw().catch(e => { app.innerHTML = `<p class="error">Erreur : ${esc(e.message || e)}</p>`; }));

    const claimBtn = $('#claim');
    if (claimBtn) {
      claimBtn.onclick = async () => {
        claimBtn.disabled = true;
        const r = await rpc('claim_daily');
        if (r.ok) toast(`${BOOSTERS[r.data.type].name} ajouté à ton stock !`, 'ok');
        await draw();
      };
    }

    /* Compte à rebours jusqu'à minuit (heure de Paris), basé sur l'heure du serveur */
    const el = $('#countdown');
    if (el) {
      const target = Date.now() + st.seconds_left * 1000;
      const tick = () => {
        if (!document.body.contains(el)) { clearInterval(timer); return; }
        const left = Math.ceil((target - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(timer);
          draw().catch(() => {});
          return;
        }
        el.textContent = fmtClock(left);
      };
      const timer = setInterval(tick, 1000);
      tick();
    }
  };
  await draw();
}

/* =====================================================================
   PAGE : COLLECTION
   ===================================================================== */
async function pageCollection() {
  const [cards, all] = await Promise.all([myCards(), q(sb.from('riders').select('id'))]);
  const groups = groupByRider(cards);
  app.innerHTML = `<h1>Ma collection</h1>
    <p class="lead">${groups.length} coureurs différents sur ${all.length} au catalogue, ${cards.length} cartes au total. Clique sur une carte pour voir ses compétences.</p>
    <div id="col"></div>`;
  if (!cards.length) {
    $('#col').innerHTML = `<div class="panel"><p>Ta vitrine est vide. <a href="#/boutique"><b>Ouvre ton premier booster</b></a> pour commencer.</p></div>`;
    return;
  }
  mountCollection($('#col'), cards);
}

/* =====================================================================
   PAGE : CLASSEUR (album d'exposition façon Panini, par équipe)
   Chaque coureur du catalogue a une case. Si tu possèdes la carte, elle
   « se colle » automatiquement dans sa case. Compteur par équipe.
   Route : #/classeur (toutes les équipes) ou #/classeur/<équipe>
   ===================================================================== */
async function pageAlbum(teamKey) {
  const [riders, ownedRows] = await Promise.all([
    fetchAll(() => sb.from('riders').select('*').order('name').order('id')),
    fetchAll(() => sb.from('user_cards').select('rider_id').eq('owner_id', state.uid).order('id')),
  ]);
  const owned = new Map();                          // rider_id -> nombre d'exemplaires
  ownedRows.forEach(c => owned.set(c.rider_id, (owned.get(c.rider_id) || 0) + 1));

  /* Une page d'album par équipe (les coureurs sans équipe sont regroupés) */
  const map = new Map();
  riders.forEach(r => {
    const key = r.team || NO_TEAM;
    if (!map.has(key)) map.set(key, { key, name: r.team || NO_TEAM_LABEL, riders: [] });
    map.get(key).riders.push(r);
  });
  const teams = [...map.values()].map(t => {
    t.riders.sort((a, b) => rarityIdx(b.rarity) - rarityIdx(a.rarity) || a.name.localeCompare(b.name));
    t.total = t.riders.length;
    t.got = t.riders.filter(r => owned.has(r.id)).length;
    t.pct = t.total ? Math.round((t.got / t.total) * 100) : 0;
    t.complete = t.total > 0 && t.got === t.total;
    return t;
  });
  const ownedDistinct = riders.filter(r => owned.has(r.id)).length;

  /* ----- Une page d'équipe ----- */
  if (teamKey) {
    const t = teams.find(x => x.key === teamKey);
    if (!t) {
      app.innerHTML = `<p><a href="#/classeur">← Toutes les équipes</a></p><p class="error">Équipe introuvable dans le classeur.</p>`;
      return;
    }
    app.innerHTML = `<p><a href="#/classeur">← Toutes les équipes</a></p>
      <h1>${esc(t.name)}</h1>
      <div class="panel showcase-head">
        <div class="stat"><b>${t.got}/${t.total}</b><span>cartes collées - ${t.pct} %</span></div>
        <div class="grow"><div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${t.pct}"><span style="width:${t.pct}%"></span></div></div>
      </div>
      ${t.complete ? `<div class="panel"><b>🏆 Page complète !</b>
        <span class="muted">${t.key !== NO_TEAM && t.total >= TEAM_MIN ? ' Cette équipe compte pour les badges « Équipe complète ».' : ''}</span></div>` : ''}
      <div class="filters"><label>Afficher<select id="af"><option value="">Toutes les cases</option><option value="got">Cartes collées</option><option value="miss">Cases vides</option></select></label></div>
      <div class="cards" id="agrid"></div>`;

    const draw = () => {
      const f = $('#af').value;
      const list = t.riders.filter(r => f === 'got' ? owned.has(r.id) : f === 'miss' ? !owned.has(r.id) : true);
      $('#agrid').innerHTML = list.length ? list.map(r => {
        const n = owned.get(r.id) || 0;
        return n
          ? `<div class="card-wrap sticker">${cardHTML(r, { cls: 'pick', attrs: `data-rid="${r.id}" tabindex="0"`, count: n })}</div>`
          : `<div class="card-wrap"><button class="empty-slot" style="--rc:${RARITY_COLOR[r.rarity]}" data-rid="${r.id}">
              <span class="num">${String(r.id).padStart(3, '0')}</span><b>${esc(r.name)}</b>
              <small>${flag(r.country)} ${esc(r.specialty)} · ${RARITY[r.rarity].label}</small>
              <small>Emplacement vide</small></button></div>`;
      }).join('') : '<p class="muted">Aucune case à afficher.</p>';
    };
    const openSlot = el => {
      const c = el.closest('[data-rid]');
      if (!c) return;
      const r = riders.find(x => x.id === +c.dataset.rid);
      if (!r) return;
      const n = owned.get(r.id) || 0;
      showRiderDetail(r, n, n > 0);
    };
    $('#af').oninput = draw;
    $('#agrid').onclick = e => openSlot(e.target);
    $('#agrid').onkeydown = e => { if (e.key === 'Enter') openSlot(e.target); };
    draw();
    return;
  }

  /* ----- Vue d'ensemble : toutes les équipes ----- */
  const completeTeams = teams.filter(t => t.complete && t.key !== NO_TEAM).length;
  const realTeams = teams.filter(t => t.key !== NO_TEAM).length;
  const gpct = riders.length ? Math.round((ownedDistinct / riders.length) * 100) : 0;
  app.innerHTML = `<h1>Classeur</h1>
    <p class="lead">Un album par équipe : chaque coureur a sa case. Quand tu possèdes sa carte, elle se colle toute seule dans le classeur. Complète une équipe à 100 % pour débloquer des badges.</p>
    <div class="panel showcase-head">
      <div class="stat"><b>${ownedDistinct}/${riders.length}</b><span>cartes collées - ${gpct} %</span></div>
      <div class="stat"><b>${completeTeams}/${realTeams}</b><span>équipes complètes</span></div>
      <div class="grow"><div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${gpct}"><span style="width:${gpct}%"></span></div></div>
    </div>
    <div class="filters">
      <label>Rechercher une équipe<input id="aq" placeholder="Ex. UAE ou Visma"></label>
      <label>Tri<select id="as"><option value="name">Nom</option><option value="pct">Complétion</option><option value="got">Cartes collées</option></select></label>
    </div>
    <div class="album-tiles" id="tiles"></div>`;

  const drawTiles = () => {
    const fq = nameKey($('#aq').value), fs = $('#as').value;
    const list = teams.filter(t => !fq || nameKey(t.name).includes(fq)).sort((a, b) =>
      (a.key === NO_TEAM ? 1 : 0) - (b.key === NO_TEAM ? 1 : 0)
      || (fs === 'pct' ? b.pct - a.pct || b.got - a.got : fs === 'got' ? b.got - a.got : 0)
      || a.name.localeCompare(b.name));
    $('#tiles').innerHTML = list.length ? list.map(t => `<a class="team-tile ${t.complete ? 'complete' : ''}" href="#/classeur/${encodeURIComponent(t.key)}">
        <h3>${esc(t.name)}${t.complete ? ' ✓' : ''}</h3>
        <span class="muted">${t.got}/${t.total} cartes collées - ${t.pct} %</span>
        <div class="prog"><span style="width:${t.pct}%"></span></div>
        <div class="dots">${t.riders.slice(0, 40).map(r => `<i class="${owned.has(r.id) ? 'on' : ''}" style="--rc:${RARITY_COLOR[r.rarity]}"></i>`).join('')}</div>
      </a>`).join('') : '<p class="muted">Aucune équipe ne correspond.</p>';
  };
  $('#aq').oninput = drawTiles;
  $('#as').oninput = drawTiles;
  drawTiles();
}

/* =====================================================================
   PAGE : VITRINE (catalogue complet des cartes du jeu)
   Toutes les cartes existantes, même celles qu'on ne possède pas.
   Les cartes non possédées sont estompées, les possédées portent un badge.
   Filtres : nom, équipe, pays, rareté, spécialité, possession. Tri au choix.
   ===================================================================== */
async function pageShowcase() {
  const PAGE = 60;
  const [riders, ownedRows] = await Promise.all([
    fetchAll(() => sb.from('riders').select('*').order('name').order('id')),
    fetchAll(() => sb.from('user_cards').select('rider_id').eq('owner_id', state.uid).order('id')),
  ]);
  const owned = new Map();                        // rider_id -> nombre d'exemplaires
  ownedRows.forEach(c => owned.set(c.rider_id, (owned.get(c.rider_id) || 0) + 1));
  const ownedDistinct = riders.filter(r => owned.has(r.id)).length;
  const pct = riders.length ? Math.round((ownedDistinct / riders.length) * 100) : 0;

  const teams = [...new Set(riders.map(r => r.team).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const countries = [...new Set(riders.map(r => r.country).filter(Boolean))]
    .sort((a, b) => countryName(a).localeCompare(countryName(b)));
  const specialties = SPECIALTIES.filter(s => riders.some(r => r.specialty === s));

  const cmpName = (a, b) => a.name.localeCompare(b.name);
  const sorters = {
    rar: (a, b) => rarityIdx(b.rarity) - rarityIdx(a.rarity) || cmpName(a, b),
    name: cmpName,
    team: (a, b) => (a.team ? 0 : 1) - (b.team ? 0 : 1) || (a.team || '').localeCompare(b.team || '') || cmpName(a, b),
    country: (a, b) => (a.country ? 0 : 1) - (b.country ? 0 : 1) || countryName(a.country).localeCompare(countryName(b.country)) || cmpName(a, b),
  };

  app.innerHTML = `<h1>Vitrine</h1>
    <p class="lead">Tous les coureurs du jeu, même ceux que tu n'as pas encore. Les cartes grisées ne sont pas dans ta collection. Clique sur une carte pour voir ses compétences.</p>
    <div class="panel showcase-head">
      <div class="stat"><b>${ownedDistinct} / ${riders.length}</b><span>coureurs dans ta collection</span></div>
      <div class="grow">
        <div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        <p class="muted" style="margin:.4rem 0 0">${pct} % du catalogue</p>
      </div>
    </div>
    <div class="filters">
      <label>Recherche<input id="sq" placeholder="Nom du coureur"></label>
      <label>Équipe<select id="st"><option value="">Toutes</option>${teams.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></label>
      <label>Pays<select id="sc"><option value="">Tous</option>${countries.map(c => `<option value="${esc(c)}">${flag(c)} ${esc(countryName(c))}</option>`).join('')}</select></label>
      <label>Rareté<select id="sr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Spécialité<select id="ss"><option value="">Toutes</option>${specialties.map(s => `<option value="${s}">${esc(cap1(s))}</option>`).join('')}</select></label>
      <label>Possession<select id="so"><option value="">Toutes les cartes</option><option value="owned">Possédées</option><option value="missing">Manquantes</option></select></label>
      <label>Tri<select id="sort"><option value="rar">Rareté</option><option value="name">Nom</option><option value="team">Équipe</option><option value="country">Pays</option></select></label>
      <button class="btn small" id="sreset" type="button">Réinitialiser</button>
    </div>
    <p class="muted" id="scount"></p>
    <div class="cards" id="grid"></div>
    <p style="margin-top:1rem"><button class="btn" id="smore" type="button" hidden>Afficher plus</button></p>`;

  let shown = PAGE;
  let current = [];

  const draw = () => {
    const fq = nameKey($('#sq').value), ft = $('#st').value, fc = $('#sc').value;
    const fr = $('#sr').value, fs = $('#ss').value, fo = $('#so').value, fsort = $('#sort').value;
    current = riders.filter(r =>
      (!fq || nameKey(r.name).includes(fq))
      && (!ft || r.team === ft)
      && (!fc || r.country === fc)
      && (!fr || r.rarity === fr)
      && (!fs || r.specialty === fs)
      && (fo === 'owned' ? owned.has(r.id) : fo === 'missing' ? !owned.has(r.id) : true)
    ).sort(sorters[fsort] || sorters.rar);

    const part = current.slice(0, shown);
    $('#scount').textContent = riders.length
      ? `${current.length} carte${current.length > 1 ? 's' : ''} affichée${current.length > 1 ? 's' : ''} sur ${riders.length}`
      : '';
    $('#grid').innerHTML = part.length
      ? part.map(r => {
          const n = owned.get(r.id) || 0;
          return `<div class="card-wrap">${cardHTML(r, {
            cls: 'pick ' + (n ? '' : 'unowned'),
            attrs: `data-rid="${r.id}" tabindex="0"`,
            count: n,
            badge: n ? '✓ Possédée' : '',
          })}</div>`;
        }).join('')
      : `<p class="muted">${riders.length ? 'Aucune carte ne correspond à ces filtres.' : 'Le catalogue est vide pour le moment.'}</p>`;
    $('#smore').hidden = current.length <= shown;
  };

  const openCard = el => {
    const card = el.closest('.card');
    if (!card) return;
    const r = riders.find(x => x.id === +card.dataset.rid);
    if (!r) return;
    const n = owned.get(r.id) || 0;
    showRiderDetail(r, n, n > 0);
  };
  $('#grid').onclick = e => openCard(e.target);
  $('#grid').onkeydown = e => { if (e.key === 'Enter') openCard(e.target); };

  $('#sq').oninput = () => { shown = PAGE; draw(); };
  ['st', 'sc', 'sr', 'ss', 'so', 'sort'].forEach(id => { $('#' + id).oninput = () => { shown = PAGE; draw(); }; });
  $('#smore').onclick = () => { shown += PAGE; draw(); };
  $('#sreset').onclick = () => {
    $('#sq').value = '';
    ['st', 'sc', 'sr', 'ss', 'so'].forEach(id => { $('#' + id).value = ''; });
    $('#sort').value = 'rar';
    shown = PAGE;
    draw();
  };
  draw();
}

/* =====================================================================
   PAGE : ÉQUIPE (courses d'un jour)
   Le joueur choisit seulement ses 8 cartes et son capitaine.
   Les points sont calculés automatiquement à la validation de la course :
   base x rareté x capitaine x coefficient de prestige de la course.
   ===================================================================== */
function raceState(r) {
  const now = Date.now(), s = +new Date(r.start_at);
  if (r.status === 'finished') return 'finished';
  if (now >= s) return 'locked';
  if (now >= s - 5 * 864e5) return 'open';
  return 'soon';
}
const STATE_LABEL = { soon: 'Bientôt', open: 'Ouverte', locked: 'Verrouillée', finished: 'Terminée' };

/* ---------- Rapport de course : détail carte par carte ----------
   lineup  : { captain_rider_id, points, coins_earned, lineup_cards: [{ rider_id, points?, riders }] }
   riderMap: Map rider_id -> coureur
   results : [{ pos, rider_id }] (classement réel enregistré en base)
   Les points stockés à la validation font foi ; à défaut, ils sont recalculés. */
function buildReport(race, lineup, riderMap, results) {
  const lcs = lineup.lineup_cards || [];
  const riders = lcs.map(lc => riderMap.get(lc.rider_id)).filter(Boolean);
  const sc = computeTeamScore(riders, lineup.captain_rider_id, results, courseMult(race));
  const stored = new Map(lcs.map(lc => [lc.rider_id, lc.points]));
  const cards = sc.cards.map(c => {
    const st = stored.get(c.rider_id);
    return { ...c, rider: riderMap.get(c.rider_id), points: st ?? c.points };
  });
  return {
    cards,
    total: lineup.points,
    coins: lineup.coins_earned,
    sum: cards.reduce((s, c) => s + c.points, 0),
  };
}

/* Bloc de rapport : synthèse, MVP et tableau « base × rareté × capitaine × course = total » */
function raceReportHTML(race, report) {
  const cm = courseMult(race);
  const sorted = [...report.cards].sort((a, b) => b.points - a.points || (a.pos ?? 99) - (b.pos ?? 99));
  const best = sorted[0] && sorted[0].points > 0 ? sorted[0] : null;
  const bestName = best?.rider?.name || '?';
  return `<div class="stat-row">
      <div class="stat"><b>${report.total}</b><span>points (+${report.coins} pièces)</span></div>
      <div class="stat"><b>${fmtMult(cm)}</b><span>coefficient de la course (${esc(TIERS[tierOf(race)].label)})</span></div>
      ${best ? `<div class="mvp-box"><b>🏆 MVP de l'équipe</b><br>${esc(bestName)} : ${best.points} points</div>` : ''}
    </div>
    <div class="table-wrap"><table class="rtable">
      <thead><tr><th>Coureur</th><th class="num">Place réelle</th><th class="num">Points de base</th><th>× Rareté</th><th>× Capitaine</th><th>× Course</th><th class="num">= Total</th></tr></thead>
      <tbody>${sorted.map(c => {
        const r = c.rider || { name: '?', rarity: 'common' };
        const isMvp = best && c.rider_id === best.rider_id;
        return `<tr class="${isMvp ? 'mvp' : ''}">
          <td>${esc(r.name)}${c.isCaptain ? ' <span class="captain-mark">★ Capitaine</span>' : ''}${isMvp ? '<span class="mvp-tag">🏆 MVP</span>' : ''}
            <span class="rar-note">${RARITY[r.rarity]?.label || ''}</span></td>
          <td class="num">${c.mythic ? '–' : c.pos === null ? 'hors Top ' + MAX_POSITION : ordinal(c.pos)}</td>
          <td class="num">${c.mythic ? MYTHIC_BONUS + ' (bonus)' : c.base}</td>
          <td class="mul">${c.mythic ? '–' : fmtMult(c.mult)}</td>
          <td class="mul">${c.isCaptain ? (c.captainApplied ? fmtMult(CAPTAIN_MULT) : '×1 (hors Top ' + CAPTAIN_TOP + ')') : '–'}</td>
          <td class="mul">${fmtMult(c.course)}</td>
          <td class="tot">= ${c.points}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    ${report.sum !== report.total ? `<p class="muted" style="margin:.8rem 0 0">Le total officiel (${report.total}) fait foi : il a été calculé au moment de la validation de la course.</p>` : ''}`;
}

/* Fenêtre « rapport de fin de course » (RaceSummaryModal) */
function showRaceSummary(race, report, title) {
  const m = openModal(`<h2>${esc(title || 'Rapport de course')}</h2>
    <p class="muted">${esc(race.name)} · ${tierBadge(race, { long: true })}</p>
    ${raceReportHTML(race, report)}
    <div class="row"><button class="btn primary" data-x>Fermer</button></div>`, { wide: true });
  $('[data-x]', m.box).onclick = m.close;
}

/* Fenêtre « équipe d'un concurrent » (CompetitorsLineupsModal) : cartes, capitaine, détail des points après la course */
async function showCompetitorLineup(race, entry, username, results) {
  let lcs;
  try {
    lcs = await q(sb.from('lineup_cards').select('rider_id,points,riders(*)').eq('lineup_id', entry.id));
  } catch (e) {
    try { lcs = await q(sb.from('lineup_cards').select('rider_id,riders(*)').eq('lineup_id', entry.id)); }
    catch (e2) { return toast(e2.message || 'Équipe illisible.', 'error'); }
  }
  lcs = lcs.filter(l => l.riders);
  const finished = raceState(race) === 'finished';
  const riderMap = new Map(lcs.map(l => [l.rider_id, l.riders]));
  const lineup = { captain_rider_id: entry.captain_rider_id, points: entry.points, coins_earned: entry.coins_earned, lineup_cards: lcs };
  const report = finished ? buildReport(race, lineup, riderMap, results) : null;
  const ptsOf = id => report?.cards.find(c => c.rider_id === id)?.points;
  const ordered = [...lcs].sort((a, b) =>
    (b.rider_id === entry.captain_rider_id ? 1 : 0) - (a.rider_id === entry.captain_rider_id ? 1 : 0)
    || rarityIdx(b.riders.rarity) - rarityIdx(a.riders.rarity) || a.riders.name.localeCompare(b.riders.name));

  const m = openModal(`<h2>Équipe de ${esc(username)}</h2>
    <p class="muted">${esc(race.name)} · ${tierBadge(race)}${finished ? ` · ${entry.points} points` : ''}</p>
    ${lcs.length ? `<div class="comp-grid">${ordered.map(l => {
      const cap = l.rider_id === entry.captain_rider_id;
      const pts = ptsOf(l.rider_id);
      return `<div class="card-wrap">${cardHTML(l.riders, { cls: 'pick', attrs: `data-rid="${l.rider_id}" tabindex="0"` })}
        <div class="cmark">${cap ? '<span class="captain-mark">★ Capitaine</span>' : ''}${pts !== undefined ? `<b>${pts} pts</b>` : ''}</div></div>`;
    }).join('')}</div>` : '<p class="muted">Composition indisponible.</p>'}
    ${report ? `<h3>Détail des points</h3>${raceReportHTML(race, report)}` : ''}
    <div class="row"><button class="btn primary" data-x>Fermer</button></div>`, { wide: true });
  $('[data-x]', m.box).onclick = m.close;
  const open = el => {
    const c = el.closest('[data-rid]');
    if (!c) return;
    const r = riderMap.get(+c.dataset.rid);
    if (r) showRiderDetail(r);
  };
  m.box.onclick = e => open(e.target);
  m.box.onkeydown = e => { if (e.key === 'Enter') open(e.target); };
}

async function pageTeam(raceId) {
  if (raceId) return composer(+raceId);
  const [races, mine, doneRaces] = await Promise.all([
    q(sb.from('races').select('*').eq('status', 'upcoming').order('start_at')),
    q(sb.from('lineups').select('race_id,points,coins_earned').eq('user_id', state.uid)),
    q(sb.from('races').select('*').eq('status', 'finished').order('start_at', { ascending: false }).limit(40)),
  ]);
  const mineMap = new Map(mine.map(m => [m.race_id, m]));
  app.innerHTML = `<h1>Équipe</h1>
    <p class="lead">Compose ton équipe de ${TEAM_SIZE} coureurs à partir de 5 jours avant le départ, et choisis un capitaine. Elle se verrouille au départ de la vraie course. Ensuite, tes points sont calculés automatiquement d'après le classement réel : les ${MAX_POSITION} premiers rapportent des points, ton capitaine compte double s'il finit dans le Top ${CAPTAIN_TOP}, et le prestige de la course multiplie le tout (Tier 1 ${fmtMult(2)}, Tier 2 ${fmtMult(1.5)}, Tier 3 ${fmtMult(1)}).</p>
    <div class="race-list">${races.length ? races.map(r => {
      const s = raceState(r);
      return `<a class="panel race-item t${tierOf(r)}" href="#/equipe/${r.id}" style="text-decoration:none">
        <div class="grow"><h3>${esc(r.name)}</h3><span class="muted">${fmtDate(r.start_at)} ${r.category ? '(' + esc(r.category) + ')' : ''}</span></div>
        ${tierBadge(r)}
        ${mineMap.has(r.id) ? '<span class="pill">Équipe enregistrée</span>' : ''}
        <span class="pill ${s}">${STATE_LABEL[s]}</span></a>`;
    }).join('') : '<div class="panel"><p>Aucune course à venir pour le moment.</p></div>'}</div>
    ${doneRaces.length ? `<h2 style="margin-top:2rem">Courses terminées</h2>
    <div class="race-list">${doneRaces.map(r => {
      const d = mineMap.get(r.id);
      return `<a class="panel race-item t${tierOf(r)}" href="#/equipe/${r.id}" style="text-decoration:none">
        <div class="grow"><h3>${esc(r.name)}</h3><span class="muted">${fmtDate(r.start_at)} ${r.category ? '(' + esc(r.category) + ')' : ''}</span></div>
        ${tierBadge(r)}
        ${d ? `<b>${d.points} pts (+${d.coins_earned} 🪙)</b>` : '<span class="muted">Pas d\'équipe</span>'}
        <span class="pill finished">${STATE_LABEL.finished}</span></a>`;
    }).join('')}</div>` : ''}`;
}

async function composer(raceId) {
  const race = await q(sb.from('races').select('*').eq('id', raceId).single());
  const st = raceState(race);
  const editable = st === 'open';
  const cm = courseMult(race);
  const finishedRace = st === 'finished';

  const lineupCols = withPoints => `id,captain_rider_id,points,coins_earned,lineup_cards(user_card_id,rider_id,${withPoints ? 'points,' : ''}riders(*))`;
  const getLineup = withPoints => q(sb.from('lineups').select(lineupCols(withPoints)).eq('race_id', raceId).eq('user_id', state.uid).maybeSingle());

  const [cards, lk, resRows, official] = await Promise.all([
    myCards(), lockInfo(),
    finishedRace
      ? q(sb.from('race_results').select('pos,rider_id,riders(id,name,team,country,rarity)').eq('race_id', raceId).order('pos'))
      : Promise.resolve([]),
    finishedRace
      ? q(sb.from('race_official_results').select('pos,rider_name,rider_id,riders(id,name,team,country,rarity)').eq('race_id', raceId).order('pos')).catch(() => [])
      : Promise.resolve([]),
  ]);
  let lineup;
  try { lineup = await getLineup(true); } catch (e) { lineup = await getLineup(false); }
  const results = resRows.map(r => ({ pos: r.pos, rider_id: r.rider_id }));

  /* Concurrents : visibles seulement à partir du départ de la course */
  let comps = [], compNames = {};
  if (st === 'locked' || st === 'finished') {
    try {
      comps = await q(sb.from('lineups').select('id,user_id,captain_rider_id,points,coins_earned').eq('race_id', raceId).order('points', { ascending: false }).limit(500));
      compNames = await usernames(comps.map(c => c.user_id));
      comps.sort((a, b) => st === 'finished'
        ? b.points - a.points || (compNames[a.user_id] || '').localeCompare(compNames[b.user_id] || '')
        : (compNames[a.user_id] || '').localeCompare(compNames[b.user_id] || ''));
    } catch (e) { comps = []; }
  }
  const rankOf = new Map(comps.map((c, i) => [c.id, i + 1]));

  const groups = groupByRider(cards)
    .map(g => ({ ...g, free: g.cards.filter(c => !lk.listed.has(c.id)) }))
    .filter(g => g.free.length);
  const byRider = new Map(groups.map(g => [g.rider.id, g]));
  const lineupRiders = new Map((lineup?.lineup_cards || []).map(lc => [lc.rider_id, lc.riders]));
  const riderOf = rid => byRider.get(rid)?.rider || lineupRiders.get(rid);

  const sel = new Map();               // rider_id -> user_card_id
  let captain = lineup?.captain_rider_id ?? null;
  if (editable) {
    for (const lc of lineup?.lineup_cards || []) {
      const g = byRider.get(lc.rider_id);
      if (g) sel.set(lc.rider_id, g.free.find(c => c.id === lc.user_card_id)?.id || g.free[0].id);
    }
    if (captain && !sel.has(captain)) captain = null;
  } else {
    for (const lc of lineup?.lineup_cards || []) sel.set(lc.rider_id, lc.user_card_id);
  }

  /* Rapport de la course terminée : points enregistrés à la validation, carte par carte */
  const report = finishedRace && lineup ? buildReport(race, lineup, lineupRiders, results) : null;
  const scoreOf = rid => report?.cards.find(c => c.rider_id === rid);

  let resultPanel = '', top30Panel = '';
  if (finishedRace) {
    resultPanel = !lineup
      ? `<div class="panel">Tu n'avais pas aligné d'équipe sur cette course.</div>`
      : `<div class="panel">
          <div class="row"><h2 class="grow" style="margin:0">Rapport de ta course</h2><button class="btn small" id="repBtn">Ouvrir dans une fenêtre</button></div>
          ${raceReportHTML(race, report)}
        </div>`;

    const myIds = new Set((lineup?.lineup_cards || []).map(l => l.rider_id));
    const rows30 = official.length
      ? official.map(o => ({ pos: o.pos, name: o.rider_name, rider: o.riders }))
      : resRows.map(o => ({ pos: o.pos, name: o.riders?.name || '?', rider: o.riders }));
    top30Panel = `<div class="panel">
      <h2 style="margin-top:0">Classement officiel de la course</h2>
      <p class="muted">Les ${MAX_POSITION} premiers rapportent des points. « Pts de course » = points de base × coefficient de la course (${fmtMult(cm)}), avant bonus de rareté et de capitaine.${official.length ? '' : ' Course validée avant la mise à jour : seuls les coureurs du jeu sont listés.'}</p>
      ${rows30.length ? `<div class="table-wrap"><table class="top30">
        <thead><tr><th class="num">Place</th><th>Coureur</th><th>Équipe</th><th class="num">Points de base</th><th class="num">Pts de course</th></tr></thead>
        <tbody>${rows30.map(o => `<tr class="${o.pos <= 3 ? 'p' + o.pos : ''} ${o.rider && myIds.has(o.rider.id) ? 'mine' : ''}">
          <td class="num">${o.pos}</td>
          <td>${o.rider ? flag(o.rider.country) + ' ' : ''}${esc(o.name)}${o.rider ? ' <span class="pill">carte du jeu</span>' : ''}</td>
          <td>${esc(o.rider?.team || '–')}</td>
          <td class="num">${basePoints(o.pos)}</td>
          <td class="num"><b>${flo(basePoints(o.pos) * cm)}</b></td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Classement indisponible.</p>'}
    </div>`;
  }

  /* Compositions des concurrents */
  let compPanel = '';
  if (st === 'locked' || st === 'finished') {
    compPanel = `<div class="panel">
      <h2 style="margin-top:0">Compositions des concurrents</h2>
      <p class="muted">${comps.length
        ? `${comps.length} équipe${comps.length > 1 ? 's' : ''} alignée${comps.length > 1 ? 's' : ''}. Clique sur « Voir » pour découvrir les ${TEAM_SIZE} cartes et le capitaine d'un joueur.`
        : 'Personne n\'a aligné d\'équipe sur cette course.'}</p>
      ${comps.length ? `<label>Rechercher un joueur<input id="cq" placeholder="Pseudo" autocomplete="off" style="max-width:260px"></label>
        <div class="table-wrap" style="margin-top:.6rem"><table>
          <thead><tr>${finishedRace ? '<th class="num">#</th>' : ''}<th>Joueur</th>${finishedRace ? '<th class="num">Points</th><th class="num">Pièces</th>' : ''}<th></th></tr></thead>
          <tbody id="cbody"></tbody></table></div>
        <p style="margin:.8rem 0 0"><button class="btn small" id="cmore" hidden>Afficher plus</button></p>` : ''}
    </div>`;
  } else {
    compPanel = `<div class="panel muted">Les compositions des concurrents seront visibles dès le départ de la course : elles restent secrètes d'ici là, pour que personne ne puisse copier une équipe.</div>`;
  }

  app.innerHTML = `<p><a href="#/equipe">← Toutes les courses</a></p>
    <h1>${esc(race.name)}</h1>
    <p class="lead">${fmtDate(race.start_at)} ${race.category ? '(' + esc(race.category) + ') ' : ''}<span class="pill ${st}">${STATE_LABEL[st]}</span></p>
    <div class="panel prestige-note">${tierBadge(race, { long: true })}
      <span class="muted">${cm === 1 ? 'Barème standard : les points ne sont pas majorés.' : `Course de prestige : tous les points de cette course sont multipliés par ${fmtMult(cm)}.`}</span></div>
    ${st === 'soon' ? `<div class="panel">Les équipes ouvrent le ${fmtDate(new Date(+new Date(race.start_at) - 5 * 864e5))}.</div>` : ''}
    ${st === 'locked' ? `<div class="panel">La course a démarré : ton équipe est verrouillée. Les points seront calculés automatiquement dès la validation des résultats.</div>` : ''}
    ${resultPanel}
    ${top30Panel}
    <div class="panel">
      <div class="row"><h2 class="grow" style="margin:0">Mon équipe <span id="cnt"></span></h2>
      ${editable ? '<button class="btn primary" id="save">Enregistrer l\'équipe</button>' : ''}</div>
      <div class="slots" id="slots"></div>
      <p class="muted" style="margin:0">Points d'une carte = points de base de la place réelle (Top ${MAX_POSITION}) × bonus de rareté × capitaine (×${CAPTAIN_MULT} s'il termine dans le Top ${CAPTAIN_TOP}) × coefficient de la course (${fmtMult(cm)}). 1 point = 1 pièce.</p>
    </div>
    ${compPanel}
    <details class="panel">
      <summary><b>Voir le barème complet (1er au ${MAX_POSITION}e)</b></summary>
      <p class="muted" style="margin-top:.6rem">Points de base, avant les multiplicateurs : bonus de rareté ${RARITY_ORDER.map(r => `${RARITY[r].label} ${fmtMult(RARITY[r].mult)}`).join(', ')} ; coefficient de la course ${Object.values(TIERS).map(t => `${t.label} ${fmtMult(t.mult)}`).join(', ')}. Les cartes mythiques vintage rapportent un bonus fixe de ${MYTHIC_BONUS} points, multiplié par le coefficient de la course.</p>
      ${baremeTable()}
    </details>
    ${editable ? `<h2>Ma collection</h2>
    <div class="filters">
      <label>Rareté<select id="fr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Recherche<input id="fq" placeholder="Nom du coureur"></label>
    </div>
    <div class="cards" id="grid"></div>` : ''}`;

  /* ----- Rapport en fenêtre ----- */
  const repBtn = $('#repBtn');
  if (repBtn && report) repBtn.onclick = () => showRaceSummary(race, report, 'Rapport de ta course');

  /* ----- Compositions des concurrents ----- */
  let cshown = 50;
  const drawComps = () => {
    const body = $('#cbody');
    if (!body) return;
    const fq = nameKey($('#cq').value);
    const list = comps.filter(c => !fq || nameKey(compNames[c.user_id] || '').includes(fq));
    const part = list.slice(0, cshown);
    body.innerHTML = part.length ? part.map(c => `<tr class="${c.user_id === state.uid ? 'me' : ''}">
        ${finishedRace ? `<td class="num">${rankOf.get(c.id)}</td>` : ''}
        <td>${esc(compNames[c.user_id] || '?')}${c.user_id === state.uid ? ' (toi)' : ''}</td>
        ${finishedRace ? `<td class="num">${c.points}</td><td class="num">+${c.coins_earned}</td>` : ''}
        <td><button class="btn small" data-view="${c.id}">Voir</button></td></tr>`).join('')
      : `<tr><td colspan="${finishedRace ? 5 : 2}" class="muted">Aucun joueur ne correspond.</td></tr>`;
    $('#cmore').hidden = list.length <= cshown;
  };
  if ($('#cbody')) {
    $('#cq').oninput = () => { cshown = 50; drawComps(); };
    $('#cmore').onclick = () => { cshown += 50; drawComps(); };
    $('#cbody').onclick = e => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      const entry = comps.find(c => c.id === b.dataset.view);
      if (entry) showCompetitorLineup(race, entry, compNames[entry.user_id] || 'Joueur', results);
    };
    drawComps();
  }

  /* ----- Mon équipe ----- */
  const drawSlots = () => {
    const ids = [...sel.keys()];
    $('#cnt').textContent = `(${ids.length}/${TEAM_SIZE})`;
    $('#slots').innerHTML = Array.from({ length: TEAM_SIZE }, (_, i) => {
      const rid = ids[i];
      if (rid == null) return `<div class="slot"><span class="muted">Libre</span></div>`;
      const r = riderOf(rid);
      const isCap = captain === rid;
      const sc = scoreOf(rid);
      return `<div class="slot full"><b>${esc(r.name)}</b><span class="muted">${RARITY[r.rarity].label}</span>
        ${editable ? `<button class="cap ${isCap ? 'on' : ''}" data-cap="${rid}">${isCap ? '★ Capitaine ×' + CAPTAIN_MULT : '☆ Capitaine'}</button>`
          : (isCap ? '<span class="captain-mark">★ Capitaine</span>' : '')}
        ${sc ? `<span><b>${sc.points} pts</b></span>` : ''}</div>`;
    }).join('');
    $$('[data-cap]').forEach(b => b.onclick = () => { captain = +b.dataset.cap; drawSlots(); });
  };
  const drawGrid = () => {
    if (!editable) return;
    const fr = $('#fr').value, fq = $('#fq').value.toLowerCase();
    const list = groups.filter(g => (!fr || g.rider.rarity === fr) && g.rider.name.toLowerCase().includes(fq))
      .sort((a, b) => rarityIdx(b.rider.rarity) - rarityIdx(a.rider.rarity) || a.rider.name.localeCompare(b.rider.name));
    $('#grid').innerHTML = list.length ? list.map(g => `<div class="card-wrap">${cardHTML(g.rider, {
      count: g.free.length, cls: 'pick ' + (sel.has(g.rider.id) ? 'sel' : (sel.size >= TEAM_SIZE ? 'dim' : '')), attrs: `data-rid="${g.rider.id}" tabindex="0"`,
    })}</div>`).join('') : '<p class="muted">Aucun coureur disponible. Les cartes en vente ne peuvent pas être alignées.</p>';
    $$('#grid .card').forEach(c => {
      const toggle = () => {
        const rid = +c.dataset.rid;
        if (sel.has(rid)) { sel.delete(rid); if (captain === rid) captain = null; }
        else if (sel.size < TEAM_SIZE) sel.set(rid, byRider.get(rid).free[0].id);
        else return toast(`Ton équipe est déjà complète (${TEAM_SIZE} coureurs).`);
        drawSlots(); drawGrid();
      };
      c.onclick = toggle; c.onkeydown = e => { if (e.key === 'Enter') toggle(); };
    });
  };
  drawSlots(); drawGrid();
  if (!editable) return;
  $('#fr').oninput = drawGrid; $('#fq').oninput = drawGrid;
  $('#save').onclick = async () => {
    if (sel.size !== TEAM_SIZE) return toast(`Il faut exactement ${TEAM_SIZE} coureurs.`, 'error');
    if (!captain) return toast('Choisis un capitaine.', 'error');
    const r = await rpc('save_lineup', { p_race_id: raceId, p_card_ids: [...sel.values()], p_captain_rider: captain });
    if (r.ok) toast('Équipe enregistrée !', 'ok');
  };
}

/* =====================================================================
   PAGE : TRANSFERTS (marché, vente, recyclage)
   ===================================================================== */
async function pageTransfers(tab = 'marche') {
  const tabs = [['marche', 'Marché'], ['vendre', 'Vendre'], ['recycler', 'Recyclage']];
  app.innerHTML = `<h1>Transferts</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/transferts/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div>
    <div id="tab"></div>`;
  const box = $('#tab');
  if (tab === 'vendre') return tabSell(box);
  if (tab === 'recycler') return tabRecycle(box);
  return tabMarket(box);
}

async function tabMarket(box) {
  const rows = await q(sb.from('listings')
    .select('id,price,seller_id,card_id,user_cards(rider_id,riders(*))')
    .eq('status', 'active').order('created_at', { ascending: false }));
  const names = await usernames(rows.map(r => r.seller_id));
  box.innerHTML = `<p class="lead">Achète au prix demandé, ou propose moins : le vendeur accepte ou refuse dans sa messagerie.</p>
    <div class="filters">
      <label>Rareté<select id="fr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
      <label>Recherche<input id="fq" placeholder="Nom du coureur"></label>
    </div><div class="cards" id="grid"></div>`;
  const draw = () => {
    const fr = $('#fr').value, fq = $('#fq').value.toLowerCase();
    const list = rows.filter(l => { const r = l.user_cards.riders; return (!fr || r.rarity === fr) && r.name.toLowerCase().includes(fq); });
    $('#grid').innerHTML = list.length ? list.map(l => {
      const r = l.user_cards.riders, mine = l.seller_id === state.uid;
      return `<div class="card-wrap">${cardHTML(r)}
        <div><b>${coin(l.price)}</b><br><span class="muted">de ${esc(names[l.seller_id] || '?')}</span></div>
        ${mine ? '<span class="pill">Ton annonce</span>' : `<div class="row">
          <button class="btn primary small" data-buy="${l.id}">Acheter</button>
          <button class="btn small" data-offer="${l.id}">Négocier</button></div>`}</div>`;
    }).join('') : '<p class="muted">Aucune annonce pour le moment.</p>';
    $$('[data-buy]').forEach(b => b.onclick = async () => {
      const l = rows.find(x => x.id === b.dataset.buy);
      if (!await confirmBox(`Acheter ${l.user_cards.riders.name} pour ${l.price} pièces ?`, 'Acheter')) return;
      const r = await rpc('buy_listing', { p_listing_id: l.id });
      if (r.ok) { toast('Carte achetée !', 'ok'); await refreshProfile(); pageTransfers('marche'); }
    });
    $$('[data-offer]').forEach(b => b.onclick = async () => {
      const l = rows.find(x => x.id === b.dataset.offer);
      const v = await askNumber({ title: `Offre pour ${l.user_cards.riders.name}`, text: `Prix demandé : ${l.price} pièces. Ton offre doit être inférieure.`, value: Math.max(1, Math.floor(l.price * 0.8)), ok: 'Envoyer l\'offre' });
      if (v == null) return;
      const r = await rpc('make_offer', { p_listing_id: l.id, p_amount: v });
      if (r.ok) toast('Offre envoyée au vendeur.', 'ok');
    });
  };
  $('#fr').oninput = draw; $('#fq').oninput = draw; draw();
}

async function tabSell(box) {
  const [cards, lk, mine] = await Promise.all([
    myCards(), lockInfo(),
    q(sb.from('listings').select('id,price,user_cards(riders(*))').eq('seller_id', state.uid).eq('status', 'active')),
  ]);
  const sellable = cards.filter(c => !lk.listed.has(c.id) && !lk.locked.has(c.id))
    .sort((a, b) => rarityIdx(b.riders.rarity) - rarityIdx(a.riders.rarity));
  box.innerHTML = `
    <h2>Mes annonces</h2>
    <div class="cards" id="mine">${mine.length ? mine.map(l => `<div class="card-wrap">${cardHTML(l.user_cards.riders)}
      <b>${coin(l.price)}</b><button class="btn danger small" data-cancel="${l.id}">Retirer</button></div>`).join('') : '<p class="muted">Aucune annonce en cours.</p>'}</div>
    <h2 style="margin-top:2rem">Mettre une carte en vente</h2>
    <p class="muted">Les cartes engagées dans une équipe à venir ne peuvent pas être vendues. Clique sur une carte pour fixer son prix.</p>
    <div class="cards">${sellable.length ? sellable.map(c => `<div class="card-wrap">${cardHTML(c.riders, { cls: 'pick', attrs: `data-sell="${c.id}" tabindex="0"` })}</div>`).join('') : '<p class="muted">Aucune carte disponible à la vente.</p>'}</div>`;
  $$('[data-cancel]').forEach(b => b.onclick = async () => {
    const r = await rpc('cancel_listing', { p_listing_id: b.dataset.cancel });
    if (r.ok) { toast('Annonce retirée.'); pageTransfers('vendre'); }
  });
  $$('[data-sell]').forEach(el => {
    const go = async () => {
      const c = sellable.find(x => x.id === el.dataset.sell);
      const v = await askNumber({ title: `Vendre ${c.riders.name}`, text: `Valeur de référence : ${RARITY[c.riders.rarity].value} pièces.`, value: RARITY[c.riders.rarity].value, ok: 'Mettre en vente' });
      if (v == null) return;
      const r = await rpc('create_listing', { p_card_id: c.id, p_price: v });
      if (r.ok) { toast('Carte mise en vente.', 'ok'); pageTransfers('vendre'); }
    };
    el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}

async function tabRecycle(box) {
  const [cards, lk] = await Promise.all([myCards(), lockInfo()]);
  const dups = groupByRider(cards).filter(g => g.cards.length > 1)
    .sort((a, b) => rarityIdx(b.rider.rarity) - rarityIdx(a.rider.rarity));
  box.innerHTML = `<p class="lead">Recycle tes doublons contre des pièces. Tu reçois ${Math.round(RECYCLE_RATE * 100)} % de la valeur de la carte : mieux vaut vendre sur le marché quand c'est possible. Tu gardes toujours un exemplaire de chaque coureur.</p>
    <div id="dups">${dups.length ? dups.map(g => {
      const free = g.cards.filter(c => !lk.listed.has(c.id) && !lk.locked.has(c.id));
      const max = Math.min(g.cards.length - 1, free.length);
      const gain = Math.floor(RARITY[g.rider.rarity].value * RECYCLE_RATE);
      return `<div class="panel row">
        <div class="mini" style="width:96px">${cardHTML(g.rider)}</div>
        <div class="grow"><h3>${esc(g.rider.name)}</h3>
          <p class="muted">${g.cards.length} exemplaires, ${max} recyclable${max > 1 ? 's' : ''}. Gain : ${coin(gain)} par carte.</p></div>
        <label>Quantité<input type="number" min="0" max="${max}" value="${max ? 1 : 0}" style="width:90px" data-q="${g.rider.id}" ${max ? '' : 'disabled'}></label>
        <button class="btn" data-rec="${g.rider.id}" ${max ? '' : 'disabled'}>Recycler</button></div>`;
    }).join('') : '<div class="panel"><p>Tu n\'as aucun doublon pour le moment.</p></div>'}</div>`;
  $$('[data-rec]').forEach(b => b.onclick = async () => {
    const rid = +b.dataset.rec, g = dups.find(x => x.rider.id === rid);
    const n = parseInt($(`[data-q="${rid}"]`).value, 10) || 0;
    const free = g.cards.filter(c => !lk.listed.has(c.id) && !lk.locked.has(c.id));
    if (n < 1) return toast('Choisis une quantité.', 'error');
    const gain = n * Math.floor(RARITY[g.rider.rarity].value * RECYCLE_RATE);
    if (!await confirmBox(`Recycler ${n} × ${g.rider.name} pour ${gain} pièces ?`, 'Recycler')) return;
    const r = await rpc('recycle_cards', { p_card_ids: free.slice(0, n).map(c => c.id) });
    if (r.ok) { toast(`+${r.data} pièces`, 'ok'); await refreshProfile(); pageTransfers('recycler'); }
  });
}

/* =====================================================================
   PAGE : MESSAGERIE
   Offres de transfert, notifications, et cadeaux à réclamer
   (cadeau de bienvenue, cadeaux envoyés par l'admin : Bronze, Argent, Or).
   ===================================================================== */
async function pageMessages() {
  const [msgs, offers] = await Promise.all([
    q(sb.from('messages').select('*').order('created_at', { ascending: false }).limit(60)),
    q(sb.from('offers').select('id,amount,buyer_id,created_at,listings(id,price,seller_id,status,user_cards(riders(*)))').eq('status', 'pending').order('created_at', { ascending: false })),
  ]);

  /* Cadeaux liés aux messages (silencieux si le SQL des cadeaux n'est pas encore installé) */
  let gifts = {};
  try {
    const rows = await q(sb.from('user_gifts').select('id,bronze,silver,gold,claimed_at').eq('user_id', state.uid));
    gifts = Object.fromEntries(rows.map(g => [g.id, g]));
  } catch (e) { gifts = {}; }

  const active = offers.filter(o => o.listings?.status === 'active');
  const received = active.filter(o => o.buyer_id !== state.uid);
  const sent = active.filter(o => o.buyer_id === state.uid);
  const names = await usernames([...received.map(o => o.buyer_id), ...sent.map(o => o.listings.seller_id)]);
  const seenAt = +new Date(state.profile.last_seen_messages);

  const offerRow = (o, mine) => {
    const r = o.listings.user_cards.riders;
    return `<div class="panel offer"><div class="mini" style="width:74px">${cardHTML(r)}</div>
      <div class="grow"><b>${esc(r.name)}</b><br>
        ${mine ? `Ton offre : <b>${coin(o.amount)}</b> (annoncé ${coin(o.listings.price)}) à ${esc(names[o.listings.seller_id] || '?')}`
               : `${esc(names[o.buyer_id] || '?')} propose <b>${coin(o.amount)}</b> (annoncé ${coin(o.listings.price)})`}</div>
      ${mine ? `<button class="btn small danger" data-cancel-offer="${o.id}">Annuler</button>`
             : `<button class="btn small primary" data-yes="${o.id}">Accepter</button><button class="btn small" data-no="${o.id}">Refuser</button>`}</div>`;
  };

  /* Bloc cadeau d'un message : boosters offerts + bouton de réclamation (ou date de réclamation) */
  const giftBlock = m => {
    const g = m.gift_id ? gifts[m.gift_id] : null;
    if (!g) return '';
    const items = `${g.bronze ? `<span class="gift-item"><span class="dpack bronze"></span>×${g.bronze}</span>` : ''}
      ${g.silver ? `<span class="gift-item"><span class="dpack silver"></span>×${g.silver}</span>` : ''}
      ${g.gold ? `<span class="gift-item"><span class="dpack gold"></span>×${g.gold}</span>` : ''}`;
    if (g.claimed_at) {
      return `<div class="gift">${items}</div>
        <p class="muted gift-done">✓ Réclamés le ${fmtDate(g.claimed_at)}. <a href="#/boutique"><b>Ouvrir mes boosters</b></a></p>`;
    }
    return `<div class="gift">${items}<button class="btn primary" data-gift="${g.id}">Réclamer mes boosters</button></div>`;
  };

  app.innerHTML = `<h1>Messagerie</h1>
    <h2>Offres reçues</h2>${received.length ? received.map(o => offerRow(o, false)).join('') : '<p class="muted">Aucune offre en attente.</p>'}
    ${sent.length ? `<h2 style="margin-top:1.5rem">Mes offres envoyées</h2>${sent.map(o => offerRow(o, true)).join('')}` : ''}
    <h2 style="margin-top:1.5rem">Notifications</h2>
    ${msgs.length ? msgs.map(m => `<div class="msg ${m.kind} ${+new Date(m.created_at) > seenAt ? 'new' : ''}">
      <b>${esc(m.title)}</b> <time>${fmtDate(m.created_at)}</time><br><span style="white-space:pre-line">${esc(m.body)}</span>${giftBlock(m)}</div>`).join('') : '<p class="muted">Aucun message.</p>'}`;

  $$('[data-yes]').forEach(b => b.onclick = async () => {
    const r = await rpc('respond_offer', { p_offer_id: b.dataset.yes, p_accept: true });
    if (r.ok) { toast('Offre acceptée, carte vendue.', 'ok'); await refreshProfile(); pageMessages(); }
  });
  $$('[data-no]').forEach(b => b.onclick = async () => {
    const r = await rpc('respond_offer', { p_offer_id: b.dataset.no, p_accept: false });
    if (r.ok) { toast('Offre refusée.'); pageMessages(); }
  });
  $$('[data-cancel-offer]').forEach(b => b.onclick = async () => {
    const r = await rpc('cancel_offer', { p_offer_id: b.dataset.cancelOffer });
    if (r.ok) { toast('Offre annulée.'); pageMessages(); }
  });
  $$('[data-gift]').forEach(b => b.onclick = async () => {
    $$('[data-gift]').forEach(x => x.disabled = true);
    const r = await rpc('claim_gift', { p_gift_id: b.dataset.gift });
    if (r.ok) {
      const parts = [];
      if (r.data.bronze) parts.push(`${r.data.bronze} Bronze`);
      if (r.data.silver) parts.push(`${r.data.silver} Argent`);
      if (r.data.gold) parts.push(`${r.data.gold} Or`);
      toast(`${parts.join(' + ')} ajoutés à ton stock de boosters !`, 'ok');
      pageMessages();
    } else {
      $$('[data-gift]').forEach(x => x.disabled = false);
    }
  });
  await sb.rpc('mark_messages_seen');
  await refreshProfile();
}

/* =====================================================================
   PAGE : PORTEFEUILLE (solde, points, vitrine de 3 cartes, badges, résultats)
   ===================================================================== */
async function pageWallet() {
  await refreshProfile();
  const p = state.profile;
  const [hist, cards, catalog, show] = await Promise.all([
    q(sb.from('lineups').select('points,coins_earned,races!inner(name,start_at,status)').eq('user_id', state.uid).eq('races.status', 'finished')),
    myCards(),
    fetchAll(() => sb.from('riders').select('id,team,country,rarity').order('id')),
    loadShowcase(state.uid),
  ]);
  hist.sort((a, b) => +new Date(b.races.start_at) - +new Date(a.races.start_at));
  const groups = groupByRider(cards);
  const favs = show.favs;                                    // 3 emplacements : coureur ou null
  const ctx = makeBadgeCtx(cards, catalog);
  const got = show.badges.filter(b => show.unlocked.has(b.id)).length;
  const countOf = id => groups.find(g => g.rider.id === id)?.cards.length || 0;

  app.innerHTML = `<h1>Portefeuille</h1>
    <div class="stat-row">
      <div class="stat"><b>${coin(p.coins)}</b><span>Solde</span></div>
      <div class="stat"><b>${p.points_total}</b><span>Points au classement UCI</span></div>
      <div class="stat"><b>${groups.length}</b><span>coureurs différents (${cards.length} cartes)</span></div>
      <div class="stat"><b>${got}/${show.badges.length}</b><span>badges débloqués</span></div>
    </div>
    <p class="row">
      <a class="btn" href="#/profil/${encodeURIComponent(p.username)}" style="text-decoration:none;display:inline-block">Voir mon profil public</a>
      <a class="btn" href="#/classeur" style="text-decoration:none;display:inline-block">Ouvrir mon classeur</a>
    </p>

    <h2 style="margin-top:1.5rem">Ma vitrine</h2>
    <p class="muted">Expose jusqu'à 3 cartes de ta collection en haut de ton profil public.</p>
    ${show.missing ? '<div class="panel muted">La vitrine et les badges seront disponibles dès que migration_badges.sql aura été exécuté dans Supabase.</div>' : '<div id="favs"></div>'}

    <h2 style="margin-top:1.5rem">Mes badges</h2>
    ${show.missing ? '' : badgesGalleryHTML(show.badges, show.unlocked, ctx)}

    <h2 style="margin-top:1.5rem">Mes résultats</h2>
    ${hist.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Date</th><th class="num">Points</th><th class="num">Pièces gagnées</th></tr></thead><tbody>
      ${hist.map(h => `<tr><td>${esc(h.races.name)}</td><td>${fmtDate(h.races.start_at)}</td><td class="num">${h.points}</td><td class="num">+${h.coins_earned}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Aucun résultat pour l\'instant. Compose ton équipe dans l\'onglet Équipe.</p>'}
    <h2 style="margin-top:1.5rem">Barème</h2>
    <div class="panel">
      <p>Les ${MAX_POSITION} premiers de chaque course rapportent des points de base : 1<sup>er</sup> : ${POSITION_POINTS[0]}, 2<sup>e</sup> : ${POSITION_POINTS[1]}, 3<sup>e</sup> : ${POSITION_POINTS[2]}, puis une baisse marquée jusqu'au 10<sup>e</sup> (${POSITION_POINTS[9]}) et plus douce jusqu'au ${MAX_POSITION}<sup>e</sup> (${POSITION_POINTS[MAX_POSITION - 1]}). Au-delà : 0.</p>
      <p>Multiplicateur de rareté : ${RARITY_ORDER.map(r => `${RARITY[r].label} ${fmtMult(RARITY[r].mult)}`).join(', ')}. Capitaine ${fmtMult(CAPTAIN_MULT)} s'il termine dans le Top ${CAPTAIN_TOP}. Coefficient de prestige de la course : ${Object.values(TIERS).map(t => `${t.label} (${t.long}) ${fmtMult(t.mult)}`).join(', ')}. Les cartes mythiques vintage (coureurs retraités) rapportent un bonus fixe de ${MYTHIC_BONUS} points, multiplié par le coefficient de la course. 1 point = 1 pièce.</p>
      <details><summary><b>Tableau complet</b></summary>${baremeTable()}</details>
    </div>`;

  if (show.missing) return;

  /* ----- Vitrine : 3 emplacements modifiables ----- */
  const drawFavs = () => {
    $('#favs').innerHTML = `<div class="fav-grid">${favs.map((r, i) => `<div class="fav-slot">${r
      ? `<div class="card-wrap">${cardHTML(r, { cls: 'pick', attrs: `data-fav-detail="${i}" tabindex="0"` })}</div>
         <div class="btn-row"><button class="btn small" data-fav-change="${i}">Changer</button><button class="btn small danger" data-fav-clear="${i}">Retirer</button></div>`
      : `<button class="fav-empty" data-fav-change="${i}"><div><span>＋</span><br>Ajouter une carte</div></button>`}</div>`).join('')}</div>`;
  };
  const saveFavs = async next => {
    const r = await rpc('set_favorites', { p_rider_ids: next.map(x => (x ? x.id : null)) });
    if (!r.ok) return false;
    next.forEach((x, i) => { favs[i] = x; });
    drawFavs();
    return true;
  };
  const pickFav = slot => {
    const taken = new Set(favs.filter((r, i) => r && i !== slot).map(r => r.id));
    const m = openModal(`<h3>Choisir une carte pour l'emplacement ${slot + 1}</h3>
      <div class="filters">
        <label>Rareté<select id="pfr"><option value="">Toutes</option>${RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('')}</select></label>
        <label>Recherche<input id="pfq" placeholder="Nom du coureur"></label>
      </div>
      <div class="cards" id="pgrid"></div>
      <div class="row"><button class="btn" data-x>Fermer</button></div>`, { wide: true });
    const draw = () => {
      const fr = $('#pfr', m.box).value, fq = $('#pfq', m.box).value.toLowerCase();
      const list = groups.filter(g => !taken.has(g.rider.id) && (!fr || g.rider.rarity === fr) && g.rider.name.toLowerCase().includes(fq))
        .sort((a, b) => rarityIdx(b.rider.rarity) - rarityIdx(a.rider.rarity) || a.rider.name.localeCompare(b.rider.name));
      $('#pgrid', m.box).innerHTML = list.length
        ? list.map(g => `<div class="card-wrap">${cardHTML(g.rider, { cls: 'pick', attrs: `data-pick="${g.rider.id}" tabindex="0"`, count: g.cards.length })}</div>`).join('')
        : '<p class="muted">Aucune carte disponible.</p>';
    };
    const choose = async el => {
      const c = el.closest('[data-pick]');
      if (!c) return;
      const g = groups.find(x => x.rider.id === +c.dataset.pick);
      if (!g) return;
      const next = [...favs];
      next[slot] = g.rider;
      if (await saveFavs(next)) m.close();
    };
    $('#pfr', m.box).oninput = draw;
    $('#pfq', m.box).oninput = draw;
    $('#pgrid', m.box).onclick = e => choose(e.target);
    $('#pgrid', m.box).onkeydown = e => { if (e.key === 'Enter') choose(e.target); };
    $('[data-x]', m.box).onclick = m.close;
    draw();
  };
  $('#favs').onclick = async e => {
    const b = e.target.closest('button');
    if (b && b.dataset.favChange !== undefined) return pickFav(+b.dataset.favChange);
    if (b && b.dataset.favClear !== undefined) {
      const next = [...favs];
      next[+b.dataset.favClear] = null;
      await saveFavs(next);
      return;
    }
    const d = e.target.closest('[data-fav-detail]');
    if (d) {
      const r = favs[+d.dataset.favDetail];
      if (r) showRiderDetail(r, countOf(r.id));
    }
  };
  $('#favs').onkeydown = e => {
    if (e.key !== 'Enter') return;
    const d = e.target.closest('[data-fav-detail]');
    if (d) {
      const r = favs[+d.dataset.favDetail];
      if (r) showRiderDetail(r, countOf(r.id));
    }
  };
  drawFavs();
}

/* =====================================================================
   PAGE : CLASSEMENT UCI
   ===================================================================== */
async function pageRanking() {
  const [rows, races] = await Promise.all([
    q(sb.from('public_profiles').select('id,username,points_total,card_count').order('points_total', { ascending: false }).order('username').limit(100)),
    q(sb.from('races').select('id,name,start_at').eq('status', 'finished').order('start_at', { ascending: false })),
  ]);
  app.innerHTML = `<h1>Classement UCI</h1>
    <div class="filters"><label>Classement<select id="rk"><option value="">Général</option>${races.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label></div>
    <div class="table-wrap" id="tbl"></div>`;
  const drawGeneral = () => {
    $('#tbl').innerHTML = `<table><thead><tr><th>#</th><th>Joueur</th><th class="num">Points</th><th class="num">Cartes</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.id === state.uid ? 'me' : ''}"><td>${i + 1}</td>
        <td><a href="#/profil/${encodeURIComponent(r.username)}">${esc(r.username)}</a></td><td class="num">${r.points_total}</td><td class="num">${r.card_count}</td></tr>`).join('')}
    </tbody></table>`;
  };
  const drawRace = async id => {
    const data = await q(sb.rpc('race_ranking', { p_race_id: +id }));
    $('#tbl').innerHTML = `<table><thead><tr><th>#</th><th>Joueur</th><th class="num">Points</th><th class="num">Pièces</th></tr></thead><tbody>
      ${data.length ? data.map((r, i) => `<tr class="${r.username === state.profile.username ? 'me' : ''}"><td>${i + 1}</td>
        <td><a href="#/profil/${encodeURIComponent(r.username)}">${esc(r.username)}</a></td><td class="num">${r.points}</td><td class="num">${r.coins_earned}</td></tr>`).join('')
        : '<tr><td colspan="4" class="muted">Personne n\'a aligné d\'équipe sur cette course.</td></tr>'}
    </tbody></table>`;
  };
  $('#rk').onchange = e => e.target.value ? drawRace(e.target.value) : drawGeneral();
  drawGeneral();
}

/* =====================================================================
   PAGE : PROFIL PUBLIC (vitrine, badges, collection)
   ===================================================================== */
async function pageProfile(username) {
  if (!username) username = state.profile.username;
  const p = await q(sb.from('public_profiles').select('*').eq('username', username.toLowerCase()).maybeSingle());
  if (!p) { app.innerHTML = '<p class="error">Joueur introuvable.</p>'; return; }
  const [cards, ahead, show] = await Promise.all([
    q(sb.from('user_cards').select('id,rider_id,acquired_at,riders(*)').eq('owner_id', p.id)),
    sb.from('public_profiles').select('id', { count: 'exact', head: true }).gt('points_total', p.points_total),
    loadShowcase(p.id),
  ]);
  const counts = Object.fromEntries(RARITY_ORDER.map(r => [r, cards.filter(c => c.riders.rarity === r).length]));
  const mine = p.id === state.uid;
  const got = show.badges.filter(b => show.unlocked.has(b.id)).length;
  app.innerHTML = `<h1>${esc(p.username)}</h1>
    <div class="stat-row">
      <div class="stat"><b>${(ahead.count ?? 0) + 1}<sup style="font-size:.5em">e</sup></b><span>au classement</span></div>
      <div class="stat"><b>${p.points_total}</b><span>points</span></div>
      <div class="stat"><b>${cards.length}</b><span>cartes (${groupByRider(cards).length} coureurs)</span></div>
      ${show.missing ? '' : `<div class="stat"><b>${got}/${show.badges.length}</b><span>badges</span></div>`}
    </div>
    <p class="muted">${RARITY_ORDER.slice().reverse().filter(r => counts[r]).map(r => `${counts[r]} ${RARITY[r].label.toLowerCase()}${counts[r] > 1 ? 's' : ''}`).join(', ') || 'Vitrine vide.'}</p>
    ${show.missing ? '' : `<h2 style="margin-top:1.5rem">Cartes favorites</h2>
      ${mine ? '<p><a href="#/portefeuille"><b>Modifier ma vitrine</b></a></p>' : ''}
      <div id="favs">${favsReadonlyHTML(show.favs)}</div>
      <h2 style="margin-top:1.5rem">Badges</h2>
      ${badgesGalleryHTML(show.badges, show.unlocked, null)}`}
    <h2 style="margin-top:1.5rem">Collection</h2>
    <div id="col"></div>`;
  const favBox = $('#favs');
  if (favBox) {
    const openFav = el => {
      const c = el.closest('[data-fav-rid]');
      if (!c) return;
      const r = show.favs.find(x => x && x.id === +c.dataset.favRid);
      if (r) showRiderDetail(r, cards.filter(x => x.rider_id === r.id).length);
    };
    favBox.onclick = e => openFav(e.target);
    favBox.onkeydown = e => { if (e.key === 'Enter') openFav(e.target); };
  }
  if (cards.length) mountCollection($('#col'), cards);
  else $('#col').innerHTML = '<p class="muted">Collection vide.</p>';
}

/* =====================================================================
   IMPORT DES COUREURS : parsing du format texte
   Format : Nom;PAYS;TEAM;spécialité;(Notes);rareté
   Exemple : Filippo BARONCINI;ITA;UAE Team Emirates;Un jour;(506 Un jour, 391 GC, 428 TT, 126 Sprint, 184 Grimpeur, 399 Collines);rare
   ===================================================================== */
const RARITY_ALIAS = { commune: 'common', common: 'common', rare: 'rare', ultra: 'ultra', 'ultra rare': 'ultra', legendaire: 'legendary', legendary: 'legendary', mythique: 'mythic', mythic: 'mythic', vintage: 'mythic' };

/* Libellé de spécialité (format texte) vers la spécialité stockée en base */
const SPECIALTY_ALIAS = {
  'un jour': 'classiques', classiques: 'classiques', classique: 'classiques',
  gc: 'complet', complet: 'complet', general: 'complet',
  tt: 'rouleur', chrono: 'rouleur', 'contre la montre': 'rouleur', rouleur: 'rouleur',
  sprint: 'sprinteur', sprinteur: 'sprinteur',
  grimpeur: 'grimpeur', climber: 'grimpeur',
  collines: 'puncheur', vallons: 'puncheur', hills: 'puncheur', puncheur: 'puncheur',
  vintage: 'vintage',
};

/* Libellé de compétence (dans le bloc de notes) vers la colonne de la base */
const STAT_ALIAS = {
  'un jour': 'oneday', oneday: 'oneday', 'one day': 'oneday',
  gc: 'gc', general: 'gc',
  tt: 'tt', chrono: 'tt', clm: 'tt', 'contre la montre': 'tt',
  sprint: 'sprint',
  grimpeur: 'climber', climber: 'climber',
  collines: 'hills', vallons: 'hills', hills: 'hills',
};

/* Codes pays à 3 lettres (formats usuels du cyclisme) vers codes à 2 lettres */
const ISO3_TO_ISO2 = {
  FRA: 'FR', BEL: 'BE', NED: 'NL', NLD: 'NL', ITA: 'IT', ESP: 'ES', GBR: 'GB', GER: 'DE', DEU: 'DE',
  DEN: 'DK', DNK: 'DK', SLO: 'SI', SVN: 'SI', SUI: 'CH', CHE: 'CH', AUT: 'AT', NOR: 'NO', SWE: 'SE',
  FIN: 'FI', POL: 'PL', CZE: 'CZ', SVK: 'SK', POR: 'PT', PRT: 'PT', USA: 'US', CAN: 'CA', AUS: 'AU',
  NZL: 'NZ', COL: 'CO', ECU: 'EC', MEX: 'MX', ERI: 'ER', RSA: 'ZA', ZAF: 'ZA', IRL: 'IE', LUX: 'LU',
  LAT: 'LV', LVA: 'LV', LTU: 'LT', EST: 'EE', UKR: 'UA', RUS: 'RU', KAZ: 'KZ', CRO: 'HR', HRV: 'HR',
  HUN: 'HU', ROU: 'RO', ROM: 'RO', BLR: 'BY', ISR: 'IL', JPN: 'JP', ETH: 'ET', RWA: 'RW', VEN: 'VE',
  ARG: 'AR', BRA: 'BR', CHI: 'CL', CHL: 'CL', CRC: 'CR', CRI: 'CR', BUL: 'BG', BGR: 'BG', GRE: 'GR',
  GRC: 'GR', TUR: 'TR', SRB: 'RS', BIH: 'BA', ISL: 'IS', CHN: 'CN', KOR: 'KR', IRI: 'IR', IRN: 'IR',
  UAE: 'AE', ARE: 'AE', MAR: 'MA', ALG: 'DZ', DZA: 'DZ', TUN: 'TN', EGY: 'EG', NAM: 'NA', BOL: 'BO',
  URU: 'UY', URY: 'UY', PER: 'PE', MDA: 'MD', GEO: 'GE', ARM: 'AM', AZE: 'AZ', ALB: 'AL', MLT: 'MT',
  CYP: 'CY', MNE: 'ME', MKD: 'MK', LIE: 'LI', MON: 'MC', AND: 'AD',
};

/* Libellé normalisé : sans accents, minuscules, tirets remplacés par des espaces */
const normLabel = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

/* Code pays à 2 ou 3 lettres vers code à 2 lettres (null si inconnu) */
function toIso2(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) return c;
  return ISO3_TO_ISO2[c] || null;
}

/* « Filippo BARONCINI » devient « Filippo Baroncini » (les mots tout en majuscules sont recapitalisés) */
function prettyName(n) {
  return String(n).trim().replace(/\s+/g, ' ').split(' ').map(w => {
    const letters = w.replace(/[^\p{L}]/gu, '');
    if (letters.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase()) {
      return w.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    }
    return w;
  }).join(' ');
}

/* Bloc de notes « (506 Un jour, 391 GC, ...) » vers { oneday, gc, tt, sprint, climber, hills } */
function parseStatsBlock(text) {
  const stats = { oneday: 0, gc: 0, tt: 0, sprint: 0, climber: 0, hills: 0 };
  const inner = String(text ?? '').replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim();
  if (!inner) return { stats };
  for (const chunk of inner.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    let num, label;
    let m = part.match(/^(\d+)\s+(.+)$/);
    if (m) { num = m[1]; label = m[2]; }
    else {
      m = part.match(/^(.+?)\s+(\d+)$/);
      if (!m) return { error: `note illisible « ${part} »` };
      label = m[1]; num = m[2];
    }
    const key = STAT_ALIAS[normLabel(label)];
    if (!key) return { error: `compétence inconnue « ${label.trim()} »` };
    stats[key] = parseInt(num, 10);
  }
  return { stats };
}

/* Analyse d'une ligne. Renvoie { row } ou { error } */
function parseRiderLine(line) {
  const parts = line.split(';').map(s => s.trim());
  if (parts.length !== 6) {
    return { error: `6 champs attendus (Nom;PAYS;TEAM;spécialité;(Notes);rareté), ${parts.length} trouvé(s)` };
  }
  const [rawName, rawCountry, team, rawSpec, rawNotes, rawRar] = parts;
  if (!rawName) return { error: 'nom manquant' };

  let country = '';
  if (rawCountry) {
    country = toIso2(rawCountry);
    if (country === null) return { error: `pays inconnu « ${rawCountry} »` };
  }
  const specialty = SPECIALTY_ALIAS[normLabel(rawSpec)];
  if (!specialty) return { error: `spécialité inconnue « ${rawSpec} »` };
  const rarity = RARITY_ALIAS[normLabel(rawRar)];
  if (!rarity) return { error: `rareté inconnue « ${rawRar} » (commune, rare, ultra, légendaire, mythique)` };
  const parsed = parseStatsBlock(rawNotes);
  if (parsed.error) return { error: parsed.error };

  return { row: { name: prettyName(rawName), country, team, specialty, rarity, ...parsed.stats } };
}

/* Analyse d'un texte complet (une ligne par coureur).
   Renvoie { rows: [...], errors: [{ n, line, error }] } */
function parseRidersText(text) {
  const rows = [], errors = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const res = parseRiderLine(line);
    if (res.error) errors.push({ n: i + 1, line, error: res.error });
    else rows.push(res.row);
  });
  return { rows, errors };
}

/* Résultats de course collés à la main : un coureur par ligne, avec ou sans numéro de place.
   Exemples : « 1. Tadej Pogačar », « 2 Jonas Vingegaard », « Remco Evenepoel » (place = numéro de ligne).
   Renvoie [{ position, rider_name }] limité au Top 30. */
function parsePastedResults(text) {
  const out = [];
  String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    const m = line.match(/^(\d{1,3})\s*[.)\-:–]?\s+(.+)$/);
    const name = (m ? m[2] : line).trim();
    const position = m ? parseInt(m[1], 10) : out.length + 1;
    out.push({ position, rider_name: name });
  });
  return out.filter(r => r.position >= 1 && r.position <= MAX_POSITION).slice(0, MAX_POSITION);
}

/* =====================================================================
   PAGE : ADMIN (onglets « Général », « Boutique » et « Badges »)
   ===================================================================== */
const adminTabs = tab => `<div class="tabs">
  <a href="#/admin/general" class="${tab === 'general' ? 'on' : ''}">Général</a>
  <a href="#/admin/boutique" class="${tab === 'boutique' ? 'on' : ''}">Boutique</a>
  <a href="#/admin/badges" class="${tab === 'badges' ? 'on' : ''}">Badges</a></div>`;

/* =====================================================================
   ADMIN > BADGES : création, édition, activation, suppression des badges
   ===================================================================== */
async function adminBadges() {
  let badges, ubRows, ridersAll;
  try {
    [badges, ubRows, ridersAll] = await Promise.all([
      q(sb.from('badges').select('*').order('created_at', { ascending: false })),
      fetchAll(() => sb.from('user_badges').select('badge_id').order('id')),
      fetchAll(() => sb.from('riders').select('id,team,country').order('id')),
    ]);
  } catch (e) {
    app.innerHTML = `<h1>Administration</h1>${adminTabs('badges')}
      <div class="panel"><b class="error">Tables des badges introuvables.</b>
      <p class="muted" style="margin:.4rem 0 0">Exécute migration_badges.sql dans Supabase (SQL Editor), puis recharge cette page. Détail : ${esc(e.message || e)}</p></div>`;
    return;
  }
  const counts = new Map();
  ubRows.forEach(u => counts.set(u.badge_id, (counts.get(u.badge_id) || 0) + 1));
  const teams = [...new Set(ridersAll.map(r => r.team).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const baseCountries = [...new Set(ridersAll.map(r => r.country).filter(Boolean))];

  app.innerHTML = `<h1>Administration</h1>${adminTabs('badges')}
    <div class="panel"><h2>Badges et succès</h2>
      <p class="muted">Les badges sont attribués automatiquement dès qu'un joueur remplit la condition (à chaque nouvelle carte obtenue, et à chaque connexion). Un badge obtenu n'est jamais retiré. Une équipe n'est comptée « complète » que si elle compte au moins ${TEAM_MIN} coureurs au catalogue.</p>
      <p class="btnrow"><button class="btn primary" id="bNew">Créer un badge</button>
        <button class="btn" id="bRecheck">Recalculer pour tous les joueurs</button></p>
      <div class="table-wrap"><table><thead><tr><th>Badge</th><th>Condition</th><th class="num">Débloqué par</th><th>Statut</th><th></th></tr></thead>
        <tbody id="bbody"></tbody></table></div></div>`;

  const drawList = () => {
    $('#bbody').innerHTML = badges.length ? badges.map(b => `<tr>
        <td><div class="row" style="flex-wrap:nowrap"><span class="bicon-sm" style="display:inline-grid;place-items:center;width:38px;height:38px;border-radius:50%;background:var(--yellow);border:2px solid var(--ink);font-size:20px;overflow:hidden;flex:none">${badgeIcon(b)}</span>
          <div><b>${esc(b.title)}</b><br><span class="muted">${esc(b.description)}</span></div></div></td>
        <td>${esc(criteriaText(b))}<br><span class="muted">${esc(BADGE_TYPES[b.criteria_type] || b.criteria_type)}</span></td>
        <td class="num">${counts.get(b.id) || 0}</td>
        <td><span class="pill ${b.is_active ? 'open' : ''}">${b.is_active ? 'Actif' : 'Désactivé'}</span></td>
        <td class="act">
          <button class="btn small" data-bedit="${b.id}">Éditer</button>
          <button class="btn small" data-btoggle="${b.id}">${b.is_active ? 'Désactiver' : 'Activer'}</button>
          <button class="btn small danger" data-bdel="${b.id}">Supprimer</button></td></tr>`).join('')
      : '<tr><td colspan="5" class="muted">Aucun badge pour le moment.</td></tr>';
  };
  const reload = async () => {
    [badges, ubRows] = await Promise.all([
      q(sb.from('badges').select('*').order('created_at', { ascending: false })),
      fetchAll(() => sb.from('user_badges').select('badge_id').order('id')),
    ]);
    counts.clear();
    ubRows.forEach(u => counts.set(u.badge_id, (counts.get(u.badge_id) || 0) + 1));
    drawList();
  };

  /* Création / édition d'un badge (b = null pour une création) */
  const editBadge = b => {
    const countries = [...new Set([...baseCountries, ...(b?.criteria_type === 'nation' && b.criteria_target ? [b.criteria_target] : [])])]
      .sort((x, y) => countryName(x).localeCompare(countryName(y)));
    let curTarget = b?.criteria_target || '';
    const m = openModal(`<h3>${b ? 'Modifier' : 'Créer'} un badge</h3>
      <form id="bf" class="rform">
        <label>Titre<input name="title" required maxlength="60" value="${esc(b?.title || '')}"></label>
        <label>Description (200 caractères maximum)<textarea name="desc" maxlength="200" style="min-height:60px">${esc(b?.description || '')}</textarea></label>
        <div class="formgrid">
          <label>Icône (emoji)<input name="icon" maxlength="8" value="${esc(b?.icon || '🏅')}"></label>
          <label>Image (optionnel : https://… ou img/badges/…)<input name="iconurl" maxlength="500" placeholder="img/badges/mon-badge.png" value="${esc(b?.icon_url || '')}"></label>
        </div>
        <label>Type de tâche<select name="type">${Object.entries(BADGE_TYPES).map(([k, l]) => `<option value="${k}" ${b?.criteria_type === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div id="tgt"></div>
        <label>Quantité requise<input name="value" type="number" min="1" max="100000" step="1" required value="${b ? b.criteria_value : 10}"></label>
        <p class="muted" id="vhint" style="margin:0"></p>
        <p id="berr" class="error" role="alert"></p>
        <div class="row"><button type="button" class="btn" data-x>Annuler</button><button type="submit" class="btn primary">${b ? 'Enregistrer' : 'Créer le badge'}</button></div>
      </form>`);
    const f = $('#bf', m.box);

    const updateValue = () => {
      const type = f.elements['type'].value;
      const v = f.elements['value'];
      const fixed = type === 'team_complete' && curTarget !== '';
      v.disabled = fixed;
      if (fixed) v.value = 1;
      $('#vhint', m.box).textContent = {
        cards_total: 'Nombre total de cartes possédées, doublons compris.',
        riders_distinct: 'Nombre de coureurs différents possédés.',
        nation: 'Nombre de coureurs différents de cette nation.',
        rarity: 'Nombre de coureurs différents de cette rareté.',
        team_complete: fixed
          ? 'Le classeur de cette équipe doit être complet à 100 %.'
          : `Nombre d'équipes complètes à 100 % (équipes d'au moins ${TEAM_MIN} coureurs).`,
      }[type] || '';
    };
    const renderTarget = () => {
      const type = f.elements['type'].value;
      let html = '';
      if (type === 'nation') {
        html = countries.length
          ? `<label>Nation<select name="target">${countries.map(c => `<option value="${esc(c)}" ${c === curTarget ? 'selected' : ''}>${flag(c)} ${esc(countryName(c))}</option>`).join('')}</select></label>`
          : '<p class="error">Aucun coureur avec un pays dans le catalogue.</p>';
      } else if (type === 'rarity') {
        html = `<label>Rareté<select name="target">${RARITY_ORDER.map(r => `<option value="${r}" ${r === curTarget ? 'selected' : ''}>${RARITY[r].label}</option>`).join('')}</select></label>`;
      } else if (type === 'team_complete') {
        html = `<label>Équipe<select name="target"><option value="">N'importe quelle équipe (compter les équipes complètes)</option>${teams.map(t => `<option value="${esc(t)}" ${t === curTarget ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
      }
      $('#tgt', m.box).innerHTML = html;
      const sel = f.elements['target'];
      if (sel) { curTarget = sel.value; sel.onchange = () => { curTarget = sel.value; updateValue(); }; }
      else curTarget = '';
      updateValue();
    };
    f.elements['type'].onchange = () => { curTarget = ''; renderTarget(); };
    renderTarget();
    $('[data-x]', m.box).onclick = m.close;

    f.onsubmit = async e => {
      e.preventDefault();
      const err = $('#berr', m.box); err.textContent = '';
      const title = f.elements['title'].value.trim().replace(/\s+/g, ' ');
      if (!title) { err.textContent = 'Le titre est obligatoire.'; return; }
      const type = f.elements['type'].value;
      let target = '';
      if (type === 'nation' || type === 'rarity' || type === 'team_complete') target = f.elements['target'] ? f.elements['target'].value : '';
      if ((type === 'nation' || type === 'rarity') && !target) { err.textContent = 'Choisis une cible pour ce type de tâche.'; return; }
      const fixed = type === 'team_complete' && target !== '';
      const value = fixed ? 1 : Number(f.elements['value'].value);
      if (!Number.isInteger(value) || value < 1 || value > 100000) { err.textContent = 'Quantité invalide (entier de 1 à 100 000).'; return; }
      const iconUrl = f.elements['iconurl'].value.trim();
      if (iconUrl && !/^(https:\/\/|img\/)/.test(iconUrl)) { err.textContent = 'L\'image doit commencer par https:// ou img/.'; return; }
      const payload = {
        title,
        description: f.elements['desc'].value.trim(),
        icon: f.elements['icon'].value.trim() || '🏅',
        icon_url: iconUrl || null,
        criteria_type: type,
        criteria_target: target,
        criteria_value: value,
        is_active: b ? b.is_active : true,
      };
      const btn = $('[type="submit"]', f); btn.disabled = true;
      const { error } = b
        ? await sb.from('badges').update(payload).eq('id', b.id)
        : await sb.from('badges').insert(payload);
      btn.disabled = false;
      if (error) {
        err.textContent = /duplicate|unique/i.test(error.message) ? 'Un badge porte déjà ce titre.' : error.message;
        return;
      }
      m.close();
      const r = await rpc('admin_recheck_badges');
      toast(b ? 'Badge modifié.' : 'Badge créé.' + (r.ok ? ` ${r.data} attribution${r.data > 1 ? 's' : ''} immédiate${r.data > 1 ? 's' : ''}.` : ''), 'ok');
      reload();
    };
  };

  $('#bNew').onclick = () => editBadge(null);
  $('#bRecheck').onclick = async () => {
    const btn = $('#bRecheck'); btn.disabled = true;
    const r = await rpc('admin_recheck_badges');
    btn.disabled = false;
    if (r.ok) { toast(`${r.data} nouvelle${r.data > 1 ? 's' : ''} attribution${r.data > 1 ? 's' : ''}.`, 'ok'); reload(); }
  };
  $('#bbody').onclick = async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.bedit || btn.dataset.btoggle || btn.dataset.bdel;
    const b = badges.find(x => x.id === id);
    if (!b) return;
    if (btn.dataset.bedit) return editBadge(b);
    if (btn.dataset.btoggle) {
      const { error } = await sb.from('badges').update({ is_active: !b.is_active }).eq('id', b.id);
      if (error) return toast(error.message, 'error');
      toast(b.is_active ? 'Badge désactivé.' : 'Badge activé.', 'ok');
      if (!b.is_active) await rpc('admin_recheck_badges');
      return reload();
    }
    if (btn.dataset.bdel) {
      const n = counts.get(b.id) || 0;
      if (!await confirmBox(`Supprimer définitivement le badge « ${b.title} » ?${n ? ` Il disparaîtra aussi des ${n} joueur${n > 1 ? 's' : ''} qui l'ont obtenu.` : ''}`, 'Supprimer')) return;
      const { error } = await sb.from('badges').delete().eq('id', b.id);
      if (error) return toast(error.message, 'error');
      toast('Badge supprimé.', 'ok');
      reload();
    }
  };

  drawList();
}

/* =====================================================================
   ADMIN > BOUTIQUE : cartes en vente directe et boosters éphémères
   ===================================================================== */
async function adminShop() {
  let ridersAll, offers, ephs;
  try {
    [ridersAll, offers, ephs] = await Promise.all([
      fetchAll(() => sb.from('riders').select('id,name,rarity,team,country').order('name').order('id')),
      q(sb.from('shop_cards').select('id,rider_id,price,stock,is_active,created_at,riders(id,name,rarity,team,country)').order('created_at', { ascending: false })),
      q(sb.from('ephemeral_boosters').select('*').order('start_date', { ascending: false })),
    ]);
  } catch (e) {
    app.innerHTML = `<h1>Administration</h1>${adminTabs('boutique')}
      <div class="panel"><b class="error">Tables de la boutique introuvables.</b>
      <p class="muted" style="margin:.4rem 0 0">Exécute migration_shop.sql dans Supabase (SQL Editor), puis recharge cette page. Détail : ${esc(e.message || e)}</p></div>`;
    return;
  }
  const ridersById = new Map(ridersAll.map(r => [r.id, r]));
  let picked = null;                           // coureur choisi pour une nouvelle offre

  app.innerHTML = `<h1>Administration</h1>${adminTabs('boutique')}

    <div class="panel"><h2>Cartes en vente directe</h2>
      <p class="muted">Choisis un coureur du catalogue, fixe son prix et publie l'offre : elle apparaît dans « Offres spéciales » de la Boutique. Chaque achat crée un nouvel exemplaire dans la collection du joueur. Laisse le stock vide pour une vente illimitée.</p>
      <label>Rechercher un coureur (nom ou équipe)<input id="sq2" placeholder="Ex. Pogačar ou UAE" autocomplete="off"></label>
      <select id="ssel" size="6" style="width:100%;margin-top:.5rem" aria-label="Liste des coureurs"></select>
      <p class="muted" id="spick" style="margin:.4rem 0 0">Aucun coureur sélectionné.</p>
      <div class="filters">
        <label>Prix (pièces)<input type="number" id="sprice" min="1" max="1000000" step="1" inputmode="numeric" style="width:140px"></label>
        <label>Stock (optionnel)<input type="number" id="sstock" min="1" step="1" inputmode="numeric" placeholder="Illimité" style="width:140px"></label>
        <button class="btn primary" id="sPub">Publier l'offre</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Coureur</th><th>Rareté</th><th class="num">Prix</th><th class="num">Stock</th><th>Statut</th><th></th></tr></thead>
        <tbody id="sbody"></tbody></table></div></div>

    <div class="panel"><h2>Boosters éphémères</h2>
      <p class="muted">Des boosters à durée limitée, avec leur propre visuel, prix et composition (probabilités par rareté, garantie, pool de coureurs). Ils apparaissent dans la Boutique entre leur date de début et leur date de fin, et s'ouvrent à l'achat.</p>
      <p><button class="btn primary" id="eNew">Créer un booster éphémère</button></p>
      <div class="table-wrap"><table><thead><tr><th>Booster</th><th class="num">Prix</th><th>Période</th><th>Pool</th><th>Statut</th><th></th></tr></thead>
        <tbody id="ebody"></tbody></table></div></div>`;

  /* ----- Cartes en vente directe ----- */
  const drawPickList = () => {
    const fq = nameKey($('#sq2').value);
    const list = ridersAll.filter(r => !fq || nameKey(r.name).includes(fq) || nameKey(r.team).includes(fq));
    const part = list.slice(0, 200);
    $('#ssel').innerHTML = part.length
      ? part.map(r => `<option value="${r.id}" ${picked && picked.id === r.id ? 'selected' : ''}>${esc(r.name)} · ${RARITY[r.rarity].label}${r.team ? ' · ' + esc(r.team) : ''}</option>`).join('')
      : '<option value="" disabled>Aucun coureur ne correspond</option>';
    if (list.length > part.length) {
      $('#ssel').insertAdjacentHTML('beforeend', `<option value="" disabled>… ${list.length - part.length} autre(s) : affine la recherche</option>`);
    }
  };
  const drawOffers = () => {
    $('#sbody').innerHTML = offers.length ? offers.map(o => {
      const r = o.riders || ridersById.get(o.rider_id);
      return `<tr>
        <td>${r ? `${flag(r.country)} <b>${esc(r.name)}</b>` : '?'}</td>
        <td>${r ? RARITY[r.rarity].label : ''}</td>
        <td class="num">${coin(o.price)}</td>
        <td class="num">${o.stock === null ? '∞' : o.stock}</td>
        <td><span class="pill ${o.is_active ? 'open' : ''}">${o.is_active ? 'En vente' : 'Retirée'}</span></td>
        <td class="act">
          <button class="btn small" data-sedit="${o.id}">Modifier</button>
          <button class="btn small" data-stoggle="${o.id}">${o.is_active ? 'Retirer' : 'Republier'}</button>
          <button class="btn small danger" data-sdel="${o.id}">Supprimer</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="muted">Aucune offre pour le moment.</td></tr>';
  };
  const reloadOffers = async () => {
    offers = await q(sb.from('shop_cards').select('id,rider_id,price,stock,is_active,created_at,riders(id,name,rarity,team,country)').order('created_at', { ascending: false }));
    drawOffers();
  };
  const readPosInt = (id, { allowEmpty = false, max = 1000000 } = {}) => {
    const raw = $(id).value.trim();
    if (raw === '') return allowEmpty ? null : NaN;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 1 && v <= max ? v : NaN;
  };

  $('#sq2').oninput = drawPickList;
  $('#ssel').onchange = () => {
    picked = ridersById.get(+$('#ssel').value) || null;
    $('#spick').textContent = picked ? `Coureur sélectionné : ${picked.name} (${RARITY[picked.rarity].label})` : 'Aucun coureur sélectionné.';
  };
  $('#sPub').onclick = async () => {
    if (!picked) return toast('Choisis d\'abord un coureur dans la liste.', 'error');
    const price = readPosInt('#sprice');
    if (Number.isNaN(price)) return toast('Prix : un nombre entier de pièces (1 à 1 000 000).', 'error');
    const stock = readPosInt('#sstock', { allowEmpty: true });
    if (Number.isNaN(stock)) return toast('Stock : un nombre entier supérieur à 0, ou laisse vide.', 'error');
    const btn = $('#sPub'); btn.disabled = true;
    const { error } = await sb.from('shop_cards').insert({ rider_id: picked.id, price, stock });
    btn.disabled = false;
    if (error) {
      return toast(/duplicate|unique/i.test(error.message) ? 'Ce coureur est déjà en vente : modifie l\'offre existante.' : error.message, 'error');
    }
    toast(`${picked.name} est en vente pour ${price} pièces.`, 'ok');
    $('#sprice').value = ''; $('#sstock').value = '';
    await reloadOffers();
  };
  $('#sbody').onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = b.dataset.sedit || b.dataset.stoggle || b.dataset.sdel;
    const o = offers.find(x => x.id === id);
    if (!o) return;
    const r = o.riders || ridersById.get(o.rider_id);

    if (b.dataset.stoggle) {
      const { error } = await sb.from('shop_cards').update({ is_active: !o.is_active }).eq('id', o.id);
      if (error) return toast(/duplicate|unique/i.test(error.message) ? 'Une autre offre active existe déjà pour ce coureur.' : error.message, 'error');
      toast(o.is_active ? 'Offre retirée du marché.' : 'Offre republiée.', 'ok');
      return reloadOffers();
    }
    if (b.dataset.sdel) {
      if (!await confirmBox(`Supprimer définitivement l'offre de ${r ? r.name : 'ce coureur'} ?`, 'Supprimer')) return;
      const { error } = await sb.from('shop_cards').delete().eq('id', o.id);
      if (error) return toast(error.message, 'error');
      toast('Offre supprimée.', 'ok');
      return reloadOffers();
    }
    if (b.dataset.sedit) {
      const m = openModal(`<h3>Modifier l'offre : ${esc(r ? r.name : '')}</h3>
        <form id="sf" class="rform">
          <label>Prix (pièces)<input name="price" type="number" min="1" max="1000000" step="1" required value="${o.price}"></label>
          <label>Stock (vide = illimité)<input name="stock" type="number" min="0" step="1" value="${o.stock === null ? '' : o.stock}" placeholder="Illimité"></label>
          <p id="serr" class="error" role="alert"></p>
          <div class="row"><button type="button" class="btn" data-x>Annuler</button><button type="submit" class="btn primary">Enregistrer</button></div>
        </form>`);
      $('[data-x]', m.box).onclick = m.close;
      $('#sf', m.box).onsubmit = async ev => {
        ev.preventDefault();
        const f = ev.target, err = $('#serr', m.box); err.textContent = '';
        const price = Number(f.elements['price'].value);
        const rawStock = f.elements['stock'].value.trim();
        const stock = rawStock === '' ? null : Number(rawStock);
        if (!Number.isInteger(price) || price < 1 || price > 1000000) { err.textContent = 'Prix invalide (entier de 1 à 1 000 000).'; return; }
        if (stock !== null && (!Number.isInteger(stock) || stock < 0)) { err.textContent = 'Stock invalide (entier positif ou vide).'; return; }
        const { error } = await sb.from('shop_cards').update({ price, stock }).eq('id', o.id);
        if (error) { err.textContent = error.message; return; }
        m.close();
        toast('Offre modifiée.', 'ok');
        reloadOffers();
      };
    }
  };

  /* ----- Boosters éphémères ----- */
  const ephStatus = b => {
    const now = Date.now();
    if (!b.is_active) return { label: 'Désactivé', cls: 'pill' };
    if (now < +new Date(b.start_date)) return { label: 'Programmé', cls: 'pill soon' };
    if (now < +new Date(b.end_date)) return { label: 'En cours', cls: 'pill open' };
    return { label: 'Terminé', cls: 'pill finished' };
  };
  const drawEph = () => {
    $('#ebody').innerHTML = ephs.length ? ephs.map(b => {
      const st = ephStatus(b), pool = ephPoolSize(b);
      return `<tr>
        <td><b>${esc(b.name)}</b><br><span class="muted">${b.composition_json?.cards || 5} cartes</span></td>
        <td class="num">${coin(b.price)}</td>
        <td>${fmtDate(b.start_date)}<br>→ ${fmtDate(b.end_date)}</td>
        <td>${pool ? `${pool} coureur${pool > 1 ? 's' : ''}` : 'Tout le catalogue'}</td>
        <td><span class="${st.cls}">${st.label}</span></td>
        <td class="act">
          <button class="btn small" data-eedit="${b.id}">Éditer</button>
          <button class="btn small" data-etoggle="${b.id}">${b.is_active ? 'Désactiver' : 'Activer'}</button>
          <button class="btn small danger" data-edel="${b.id}">Supprimer</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="muted">Aucun booster éphémère pour le moment.</td></tr>';
  };
  const reloadEph = async () => {
    ephs = await q(sb.from('ephemeral_boosters').select('*').order('start_date', { ascending: false }));
    drawEph();
  };

  /* Création / édition d'un booster éphémère (b = null pour une création) */
  const editEph = b => {
    const comp = b?.composition_json || {};
    const w0 = comp.weights || { common: 70, rare: 25, ultra: 5 };
    const pool = new Set((Array.isArray(comp.rider_ids) ? comp.rider_ids : []).map(Number));
    const now = new Date();
    const startV = toLocalInput(b ? b.start_date : now);
    const endV = toLocalInput(b ? b.end_date : new Date(now.getTime() + 7 * 864e5));

    const m = openModal(`<h3>${b ? 'Modifier' : 'Créer'} un booster éphémère</h3>
      <form id="ef" class="rform">
        <div class="formgrid">
          <label>Nom<input name="name" required maxlength="60" value="${esc(b?.name || '')}"></label>
          <label>Prix (pièces)<input name="price" type="number" min="1" max="1000000" step="1" required value="${b ? b.price : 500}"></label>
          <label>Début de la vente<input name="start" type="datetime-local" required value="${startV}"></label>
          <label>Fin de la vente<input name="end" type="datetime-local" required value="${endV}"></label>
          <label>Nombre de cartes (1 à 10)<input name="cards" type="number" min="1" max="10" step="1" required value="${comp.cards || 5}"></label>
          <label>Visuel (URL https:// ou chemin img/...)<input name="image" maxlength="500" placeholder="https://... ou img/shop/mon-booster.png" value="${esc(b?.image_url || '')}"></label>
        </div>
        <label>Description (500 caractères maximum)<textarea name="desc" maxlength="500" style="min-height:70px">${esc(b?.description || '')}</textarea></label>

        <fieldset class="stats-edit weights"><legend>Probabilités par rareté (poids relatifs)</legend>
          ${RARITY_ORDER.map(r => `<label>${RARITY[r].label}<input type="number" min="0" step="any" name="w_${r}" value="${Number(w0[r]) || 0}"></label>`).join('')}
        </fieldset>
        <p class="muted" id="eodds" style="margin:0"></p>

        <div class="formgrid">
          <label>Garantie de rareté<select name="grar"><option value="">Aucune</option>${RARITY_ORDER.slice(1).map(r => `<option value="${r}" ${comp.guarantee?.rarity === r ? 'selected' : ''}>${RARITY[r].label} ou mieux</option>`).join('')}</select></label>
          <label>Nombre de cartes garanties<input name="gcount" type="number" min="0" max="10" step="1" value="${comp.guarantee?.count || 0}"></label>
        </div>

        <fieldset class="stats-edit" style="display:block"><legend>Pool de coureurs (vide = tout le catalogue)</legend>
          <label>Rechercher un coureur (nom ou équipe)<input id="pq" placeholder="Ex. Pogačar ou UAE" autocomplete="off"></label>
          <select id="plist" multiple size="6" style="width:100%;margin-top:.4rem" aria-label="Coureurs disponibles"></select>
          <div class="btnrow">
            <button type="button" class="btn small" id="padd">Ajouter la sélection</button>
            <button type="button" class="btn small" id="paddall">Ajouter tous les résultats de la recherche</button>
            <button type="button" class="btn small danger" id="pclear">Vider le pool</button>
          </div>
          <p class="muted" id="pcount" style="margin:0 0 .4rem"></p>
          <div class="chips" id="pchips"></div>
        </fieldset>

        <p id="eerr" class="error" role="alert"></p>
        <div class="row"><button type="button" class="btn" data-x>Annuler</button><button type="submit" class="btn primary">${b ? 'Enregistrer' : 'Créer le booster'}</button></div>
      </form>`, { wide: true });

    const f = $('#ef', m.box);
    const filtered = () => {
      const fq = nameKey($('#pq', m.box).value);
      return ridersAll.filter(r => !pool.has(r.id) && (!fq || nameKey(r.name).includes(fq) || nameKey(r.team).includes(fq)));
    };
    const drawPool = () => {
      const list = filtered();
      $('#plist', m.box).innerHTML = list.length
        ? list.slice(0, 300).map(r => `<option value="${r.id}">${esc(r.name)} · ${RARITY[r.rarity].label}${r.team ? ' · ' + esc(r.team) : ''}</option>`).join('')
        : '<option value="" disabled>Aucun coureur ne correspond</option>';
      $('#pcount', m.box).textContent = pool.size
        ? `${pool.size} coureur${pool.size > 1 ? 's' : ''} dans le pool.`
        : 'Pool vide : les cartes seront tirées dans tout le catalogue.';
      const ids = [...pool];
      $('#pchips', m.box).innerHTML = ids.slice(0, 80).map(id => {
        const r = ridersById.get(id);
        return `<span class="chip">${esc(r ? r.name : '#' + id)}<button type="button" data-rm="${id}" aria-label="Retirer">×</button></span>`;
      }).join('') + (ids.length > 80 ? `<span class="muted">… et ${ids.length - 80} autre(s)</span>` : '');
    };
    const readComp = () => {
      const weights = {};
      RARITY_ORDER.forEach(r => { weights[r] = Math.max(0, Number(f.elements['w_' + r].value) || 0); });
      const comp2 = { cards: parseInt(f.elements['cards'].value, 10) || 0, weights, rider_ids: [...pool] };
      const gr = f.elements['grar'].value, gc = parseInt(f.elements['gcount'].value, 10) || 0;
      if (gr && gc > 0) comp2.guarantee = { rarity: gr, count: gc };
      return comp2;
    };
    const drawOdds = () => {
      const odds = compOdds(readComp());
      $('#eodds', m.box).textContent = odds.length
        ? 'Probabilités par carte : ' + odds.map(o => `${RARITY[o.rarity].label} ${fmtPct(o.pct)}`).join(' · ')
        : 'Renseigne au moins un poids supérieur à 0.';
    };
    RARITY_ORDER.forEach(r => { f.elements['w_' + r].oninput = drawOdds; });
    drawPool(); drawOdds();

    $('#pq', m.box).oninput = drawPool;
    $('#padd', m.box).onclick = () => {
      [...$('#plist', m.box).selectedOptions].forEach(o => { if (o.value) pool.add(+o.value); });
      drawPool();
    };
    $('#paddall', m.box).onclick = () => {
      if (!$('#pq', m.box).value.trim()) return toast('Tape d\'abord une recherche (nom ou équipe) avant d\'ajouter tous les résultats.', 'error');
      filtered().forEach(r => pool.add(r.id));
      drawPool();
    };
    $('#pclear', m.box).onclick = () => { pool.clear(); drawPool(); };
    $('#pchips', m.box).onclick = e => {
      const rm = e.target.closest('[data-rm]');
      if (!rm) return;
      pool.delete(+rm.dataset.rm);
      drawPool();
    };
    $('[data-x]', m.box).onclick = m.close;

    f.onsubmit = async e => {
      e.preventDefault();
      const err = $('#eerr', m.box); err.textContent = '';
      const name = f.elements['name'].value.trim().replace(/\s+/g, ' ');
      if (!name) { err.textContent = 'Le nom est obligatoire.'; return; }
      const price = Number(f.elements['price'].value);
      if (!Number.isInteger(price) || price < 1 || price > 1000000) { err.textContent = 'Prix invalide (entier de 1 à 1 000 000).'; return; }
      const start = new Date(f.elements['start'].value), end = new Date(f.elements['end'].value);
      if (isNaN(start) || isNaN(end)) { err.textContent = 'Dates invalides.'; return; }
      if (end <= start) { err.textContent = 'La date de fin doit être après la date de début.'; return; }
      const image = f.elements['image'].value.trim();
      if (image && !/^(https:\/\/|img\/)/.test(image)) { err.textContent = 'Le visuel doit commencer par https:// ou img/.'; return; }
      const composition = readComp();
      if (composition.cards < 1 || composition.cards > 10) { err.textContent = 'Un booster contient de 1 à 10 cartes.'; return; }
      if (!compOdds(composition).length) { err.textContent = 'Renseigne au moins une probabilité de rareté supérieure à 0.'; return; }
      if (composition.guarantee && composition.guarantee.count > composition.cards) { err.textContent = 'Le nombre de cartes garanties dépasse la taille du booster.'; return; }

      const payload = {
        name,
        description: f.elements['desc'].value.trim(),
        price,
        image_url: image || null,
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        composition_json: composition,
        is_active: b ? b.is_active : true,
      };
      const btn = $('[type="submit"]', f); btn.disabled = true;
      const { error } = b
        ? await sb.from('ephemeral_boosters').update(payload).eq('id', b.id)
        : await sb.from('ephemeral_boosters').insert(payload);
      btn.disabled = false;
      if (error) { err.textContent = error.message; return; }
      m.close();
      toast(b ? 'Booster modifié.' : 'Booster créé.', 'ok');
      reloadEph();
    };
  };

  $('#eNew').onclick = () => editEph(null);
  $('#ebody').onclick = async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.eedit || btn.dataset.etoggle || btn.dataset.edel;
    const b = ephs.find(x => x.id === id);
    if (!b) return;
    if (btn.dataset.eedit) return editEph(b);
    if (btn.dataset.etoggle) {
      const { error } = await sb.from('ephemeral_boosters').update({ is_active: !b.is_active }).eq('id', b.id);
      if (error) return toast(error.message, 'error');
      toast(b.is_active ? 'Booster désactivé.' : 'Booster activé.', 'ok');
      return reloadEph();
    }
    if (btn.dataset.edel) {
      if (!await confirmBox(`Supprimer définitivement le booster « ${b.name} » ?`, 'Supprimer')) return;
      const { error } = await sb.from('ephemeral_boosters').delete().eq('id', b.id);
      if (error) return toast(error.message, 'error');
      toast('Booster supprimé.', 'ok');
      reloadEph();
    }
  };

  drawPickList(); drawOffers(); drawEph();
}

async function pageAdmin(tab = 'general') {
  if (!state.profile.is_admin) { app.innerHTML = '<p class="error">Accès réservé.</p>'; return; }
  if (tab === 'boutique') return adminShop();
  if (tab === 'badges') return adminBadges();

  const [races, ridersInit, playersInit] = await Promise.all([
    q(sb.from('races').select('*').eq('status', 'upcoming').order('start_at')),
    fetchAll(() => sb.from('riders').select('*').order('name').order('id')),
    fetchAll(() => sb.from('public_profiles').select('id,username').order('username').order('id')),
  ]);
  let riders = ridersInit;
  const players = playersInit;
  let riderByKey = new Map();        // clé de rapprochement -> coureurs du catalogue
  let top30 = [];                    // classement à valider : [{ position, rider_name }]
  let shown = 50;
  let picked = null;                 // joueur choisi pour le cadeau de boosters
  const rarityOptions = RARITY_ORDER.map(r => `<option value="${r}">${RARITY[r].label}</option>`).join('');
  const raceOptionsHTML = () => races.length
    ? races.map(r => `<option value="${r.id}">${esc(r.name)} (${fmtDate(r.start_at)}) · ${TIERS[tierOf(r)].label} ${fmtMult(courseMult(r))}</option>`).join('')
    : '<option value="">Aucune course à venir</option>';

  app.innerHTML = `<h1>Administration</h1>${adminTabs('general')}

    <div class="panel"><h2>Validation de course</h2>
      <p class="muted">1. Choisis la course et colle le lien de sa page de résultats sur firstcycling.com. 2. Clique sur « Récupérer les résultats de la course » et vérifie le Top ${MAX_POSITION} (tu peux corriger un nom). 3. Clique sur « Valider et calculer les scores » : les points (multipliés par le coefficient de prestige de la course) et les pièces sont crédités aux joueurs, le classement officiel est enregistré et la course passe en « Terminée ». Les coureurs absents de ton catalogue ne rapportent rien mais restent dans le classement affiché. Action définitive.</p>
      <label>Course<select id="vr">${raceOptionsHTML()}</select></label>
      <label style="margin-top:.6rem">Lien de la page de résultats (firstcycling.com)<input id="vurl" type="url" placeholder="https://firstcycling.com/..." autocomplete="off"></label>
      <p style="margin-top:.8rem"><button class="btn" id="vFetch">Récupérer les résultats de la course</button></p>
      <p id="vStatus" class="muted" role="status"></p>
      <details id="vManualBox"><summary><b>Saisie manuelle (secours)</b></summary>
        <p class="muted" style="margin-top:.6rem">Colle un coureur par ligne, dans l'ordre d'arrivée, avec ou sans numéro de place. Exemple : <code>1. Tadej Pogačar</code></p>
        <textarea id="vPaste" style="min-height:140px" placeholder="1. Tadej Pogačar&#10;2. Mathieu van der Poel&#10;3. Wout van Aert"></textarea>
        <p><button class="btn small" id="vPasteBtn">Utiliser ces résultats</button></p>
      </details>
      <div id="vTable" class="table-wrap" style="margin-top:.8rem"></div>
      <p id="vSummary" class="muted" style="margin-top:.6rem"></p>
      <p><button class="btn primary" id="vBtn" disabled>Valider et calculer les scores</button></p></div>

    <div class="panel"><h2>Prestige des courses</h2>
      <p class="muted">Le coefficient multiplie tous les points d'une course : Tier 1 (Grands Tours et Monuments) ${fmtMult(2)}, Tier 2 (WorldTour) ${fmtMult(1.5)}, Tier 3 (ProSeries, Europe Tour) ${fmtMult(1)}. Règle-le avant la validation : il est figé ensuite.</p>
      <div class="table-wrap"><table><thead><tr><th>Course</th><th>Date</th><th>Catégorie</th><th>Prestige</th></tr></thead><tbody>
        ${races.length ? races.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${fmtDate(r.start_at)}</td><td>${esc(r.category || '–')}</td>
          <td><select data-tier="${r.id}" aria-label="Prestige de ${esc(r.name)}">${[1, 2, 3].map(t => `<option value="${t}" ${tierOf(r) === t ? 'selected' : ''}>${TIERS[t].label} · ${esc(TIERS[t].long)} (${fmtMult(TIERS[t].mult)})</option>`).join('')}</select></td></tr>`).join('')
          : '<tr><td colspan="4" class="muted">Aucune course à venir.</td></tr>'}
      </tbody></table></div></div>

    <div class="panel"><h2>Offrir des boosters</h2>
      <p class="muted">Envoie des boosters à un joueur ou à toute la communauté. Le joueur reçoit un message dans sa messagerie avec un bouton « Réclamer mes boosters » (ou les boosters sont crédités tout de suite si tu coches la case correspondante). Les boosters offerts vont dans son stock et s'ouvrent gratuitement.</p>
      <label style="display:flex;gap:.5rem;align-items:center;font-size:15px">
        <input type="checkbox" id="gAll"> Distribuer à tous les joueurs (${players.length} joueur${players.length > 1 ? 's' : ''})
      </label>
      <div id="gWho" style="margin-top:.8rem">
        <label>Rechercher un joueur (pseudo)<input id="gq" placeholder="Tape un pseudo" autocomplete="off"></label>
        <select id="gsel" size="6" style="width:100%;margin-top:.5rem" aria-label="Liste des joueurs"></select>
        <p class="muted" id="gpicked" style="margin:.4rem 0 0">Aucun joueur sélectionné.</p>
      </div>
      <div class="filters">
        <label>Bronze<input type="number" id="gBronze" min="0" max="100" step="1" value="0" inputmode="numeric" style="width:100px"></label>
        <label>Argent<input type="number" id="gSilver" min="0" max="100" step="1" value="0" inputmode="numeric" style="width:100px"></label>
        <label>Or<input type="number" id="gGold" min="0" max="100" step="1" value="0" inputmode="numeric" style="width:100px"></label>
      </div>
      <label>Message personnalisé (optionnel, 500 caractères maximum)
        <textarea id="gmsg" maxlength="500" style="min-height:80px" placeholder="Ex. Merci d'être là pour le lancement !"></textarea>
      </label>
      <label style="display:flex;gap:.5rem;align-items:center;font-size:15px;margin-top:.6rem">
        <input type="checkbox" id="gDirect"> Créditer directement les boosters (sans bouton « Réclamer »)
      </label>
      <p style="margin-top:.8rem"><button class="btn primary" id="gBtn">Envoyer le cadeau</button></p></div>

    <div class="panel"><h2>Ajouter des courses</h2>
      <p class="muted">Une course par ligne, format : <code>Nom;Catégorie;AAAA-MM-JJ HH:MM;Prestige</code> (heure de départ de ton fuseau). Le prestige est facultatif : 1 (Grands Tours et Monuments), 2 (WorldTour) ou 3 (ProSeries, par défaut). Copie les courses du calendrier L'Équipe puis mets-les à ce format.</p>
      <textarea id="raceCsv" placeholder="Il Lombardia;WorldTour;2026-10-10 10:30;1"></textarea>
      <p><button class="btn" id="raceBtn">Importer les courses</button></p></div>

    <div class="panel"><h2>Importer des coureurs</h2>
      <p class="muted">Un coureur par ligne : <code>Nom;PAYS;TEAM;spécialité;(Notes);rareté</code>. Le pays peut avoir 2 ou 3 lettres. Spécialités acceptées : Un jour, GC, TT, Sprint, Grimpeur, Collines (ou ${SPECIALTIES.join(', ')}). Raretés : commune, rare, ultra, légendaire, mythique. Un coureur déjà au catalogue (même nom) est mis à jour. Si une ligne est invalide, rien n'est importé.</p>
      <textarea id="riderCsv" placeholder="Filippo BARONCINI;ITA;UAE Team Emirates;Un jour;(506 Un jour, 391 GC, 428 TT, 126 Sprint, 184 Grimpeur, 399 Collines);rare"></textarea>
      <p><button class="btn" id="riderBtn">Importer les coureurs</button></p>
      <div id="riderReport" class="report"></div></div>

    <div class="panel"><h2>Gérer les coureurs</h2>
      <div class="filters" style="margin-top:0">
        <label>Recherche (nom ou équipe)<input id="mq" placeholder="Ex. Pogačar ou UAE"></label>
        <label>Rareté<select id="mr"><option value="">Toutes</option>${rarityOptions}</select></label>
        <span class="muted" id="mcount"></span>
      </div>
      <div class="table-wrap"><table class="mtable"><thead><tr><th>Coureur</th><th>Équipe</th><th>Rareté</th><th>Compétences</th><th></th></tr></thead>
        <tbody id="mbody"></tbody></table></div>
      <p style="margin:.8rem 0 0"><button class="btn small" id="mmore" hidden>Afficher plus</button></p></div>

    <div class="panel"><h2>Publier une actualité</h2>
      <div class="row"><input id="nt" placeholder="Titre" class="grow"></div>
      <textarea id="nb" placeholder="Message pour tous les joueurs" style="margin-top:.6rem"></textarea>
      <p><button class="btn" id="newsBtn">Publier</button></p></div>

    <div class="panel"><h2>Visuels des coureurs</h2>
      <p class="muted">Pour chaque coureur, envoie sur GitHub une photo dans le dossier <code>img/riders/</code> avec exactement le nom de fichier indiqué (.jpg, .png ou .webp). Le mot « manquant » disparaît quand la photo est trouvée.</p>
      <div class="table-wrap"><table><thead><tr><th>Coureur</th><th>Nom du fichier</th><th>Aperçu</th></tr></thead><tbody id="visBody"></tbody></table></div></div>`;

  /* ----- Prestige des courses à venir ----- */
  $$('[data-tier]').forEach(sel => {
    sel.onchange = async () => {
      const id = +sel.dataset.tier, tier = +sel.value;
      const r = races.find(x => x.id === id);
      if (!r) return;
      const { error } = await sb.from('races').update({ tier_level: tier }).eq('id', id);
      if (error) { sel.value = tierOf(r); return toast(error.message, 'error'); }
      r.tier_level = tier;
      const cur = $('#vr').value;
      $('#vr').innerHTML = raceOptionsHTML();
      $('#vr').value = cur;
      toast(`${r.name} : ${TIERS[tier].label} (${fmtMult(TIERS[tier].mult)}).`, 'ok');
    };
  });

  /* ----- Statut de chaque ligne du classement par rapport au catalogue ----- */
  const statusInfo = () => {
    const seen = new Set();
    return top30.map(r => {
      const hits = riderByKey.get(matchKey(r.rider_name)) || [];
      if (!hits.length) return { cls: 'pill', label: 'Hors catalogue', ok: false };
      if (hits.length > 1) return { cls: 'pill locked', label: 'Nom ambigu', ok: false };
      if (seen.has(hits[0].id)) return { cls: 'pill locked', label: 'Doublon', ok: false };
      seen.add(hits[0].id);
      return { cls: 'pill open', label: '✓ ' + hits[0].name, ok: true };
    });
  };
  /* Résultats prêts pour validate_race (uniquement les coureurs du catalogue) */
  const matchedResults = () => {
    const seen = new Set(), out = [];
    top30.forEach(r => {
      const hits = riderByKey.get(matchKey(r.rider_name)) || [];
      if (hits.length === 1 && !seen.has(hits[0].id)) {
        seen.add(hits[0].id);
        out.push({ pos: r.position, rider_id: hits[0].id });
      }
    });
    return out;
  };
  const refreshStatus = () => {
    const info = statusInfo();
    info.forEach((s, i) => {
      const td = $(`[data-st="${i}"]`);
      if (td) td.innerHTML = `<span class="${s.cls}">${esc(s.label)}</span>`;
    });
    const n = info.filter(s => s.ok).length;
    $('#vSummary').textContent = top30.length
      ? `${top30.length} place${top30.length > 1 ? 's' : ''} · ${n} coureur${n > 1 ? 's' : ''} du catalogue crédité${n > 1 ? 's' : ''} · ${top30.length - n} ignoré${top30.length - n > 1 ? 's' : ''} (hors catalogue, doublon ou ambigu)`
      : '';
    $('#vBtn').disabled = n === 0;
  };
  const drawTop = () => {
    $('#vTable').innerHTML = top30.length
      ? `<table><thead><tr><th class="num">Place</th><th>Coureur (modifiable)</th><th>Catalogue</th></tr></thead><tbody>
        ${top30.map((r, i) => `<tr><td class="num">${r.position}</td>
          <td><input data-vn="${i}" value="${esc(r.rider_name)}" style="width:100%;min-width:200px" aria-label="Nom du coureur à la place ${r.position}"></td>
          <td data-st="${i}"></td></tr>`).join('')}</tbody></table>`
      : '';
    $$('[data-vn]').forEach(inp => {
      inp.oninput = () => { top30[+inp.dataset.vn].rider_name = inp.value; refreshStatus(); };
    });
    refreshStatus();
  };

  /* ----- Listes dérivées de la liste des coureurs ----- */
  const rebuildLookups = () => {
    riderByKey = new Map();
    riders.forEach(r => {
      const k = matchKey(r.name);
      riderByKey.set(k, [...(riderByKey.get(k) || []), r]);
    });
    if (top30.length) refreshStatus();
  };
  const drawVisuals = () => {
    $('#visBody').innerHTML = riders.map(r => {
      const sl = slug(r.name);
      return `<tr><td>${esc(r.name)}</td><td><code>${sl}.jpg</code></td><td><span class="muted">manquant</span><img class="thumb" src="img/riders/${sl}.jpg" alt="" data-slug="${sl}" data-i="0" onload="this.previousElementSibling.hidden=true" onerror="imgFallback(this)"></td></tr>`;
    }).join('');
  };
  const drawManage = () => {
    const fq = nameKey($('#mq').value), fr = $('#mr').value;
    const list = riders.filter(r => (!fr || r.rarity === fr)
      && (!fq || nameKey(r.name).includes(fq) || nameKey(r.team).includes(fq)));
    const part = list.slice(0, shown);
    $('#mcount').textContent = `${list.length} coureur${list.length > 1 ? 's' : ''}`;
    $('#mbody').innerHTML = part.length ? part.map(r => `<tr>
        <td>${flag(r.country)} <b>${esc(r.name)}</b></td>
        <td>${esc(r.team || '–')}</td>
        <td>${RARITY[r.rarity].label}</td>
        <td style="min-width:130px">${RiderStatsBars(r, { compact: true }) || '<span class="muted">–</span>'}</td>
        <td class="act"><button class="btn small" data-edit="${r.id}">Éditer</button> <button class="btn small danger" data-del="${r.id}">Supprimer</button></td>
      </tr>`).join('')
      : '<tr><td colspan="5" class="muted">Aucun coureur ne correspond.</td></tr>';
    $('#mmore').hidden = list.length <= shown;
  };
  const reloadRiders = async () => {
    riders = await fetchAll(() => sb.from('riders').select('*').order('name').order('id'));
    rebuildLookups(); drawManage(); drawVisuals();
  };

  /* ----- Cadeau de boosters : choix du joueur ----- */
  const drawPlayers = () => {
    const fq = nameKey($('#gq').value);
    const list = players.filter(p => !fq || nameKey(p.username).includes(fq));
    const part = list.slice(0, 200);
    $('#gsel').innerHTML = part.length
      ? part.map(p => `<option value="${p.id}" ${picked && picked.id === p.id ? 'selected' : ''}>${esc(p.username)}</option>`).join('')
      : '<option value="" disabled>Aucun joueur ne correspond</option>';
    if (list.length > part.length) {
      $('#gsel').insertAdjacentHTML('beforeend', `<option value="" disabled>… ${list.length - part.length} autre(s) : affine la recherche</option>`);
    }
  };
  const drawPicked = () => {
    $('#gpicked').textContent = picked ? `Destinataire : ${picked.username}` : 'Aucun joueur sélectionné.';
  };
  $('#gq').oninput = drawPlayers;
  $('#gsel').onchange = () => {
    picked = players.find(p => p.id === $('#gsel').value) || null;
    drawPicked();
  };
  $('#gAll').onchange = () => {
    $('#gWho').style.display = $('#gAll').checked ? 'none' : '';
  };
  $('#gBtn').onclick = async () => {
    const readQty = id => {
      const raw = $(id).value.trim();
      if (raw === '') return 0;
      const v = Number(raw);
      return Number.isInteger(v) ? v : NaN;
    };
    const bronze = readQty('#gBronze'), silver = readQty('#gSilver'), gold = readQty('#gGold');
    if ([bronze, silver, gold].some(v => Number.isNaN(v) || v < 0 || v > 100)) {
      return toast('Quantités : des nombres entiers de 0 à 100.', 'error');
    }
    if (bronze + silver + gold === 0) return toast('Choisis au moins un booster à offrir.', 'error');
    const all = $('#gAll').checked;
    if (!all && !picked) return toast('Choisis un joueur, ou coche « Distribuer à tous les joueurs ».', 'error');
    const direct = $('#gDirect').checked;
    const message = $('#gmsg').value.trim();

    const parts = [];
    if (bronze) parts.push(`${bronze} Bronze`);
    if (silver) parts.push(`${silver} Argent`);
    if (gold) parts.push(`${gold} Or`);
    const who = all ? `les ${players.length} joueurs` : picked.username;
    const total = all ? players.length : 1;
    const ok = await confirmBox(
      `Offrir ${parts.join(' + ')} à ${who}${all ? ` (${total * (bronze + silver + gold)} boosters au total)` : ''} ${direct ? ', crédités tout de suite' : ', à réclamer depuis la messagerie'} ?`,
      'Envoyer'
    );
    if (!ok) return;

    const btn = $('#gBtn'); btn.disabled = true;
    const r = await rpc('admin_give_boosters', {
      p_user_id: all ? null : picked.id,
      p_all: all,
      p_bronze: bronze,
      p_silver: silver,
      p_gold: gold,
      p_message: message,
      p_direct: direct,
    });
    btn.disabled = false;
    if (!r.ok) return;
    toast(`Cadeau envoyé à ${r.data} joueur${r.data > 1 ? 's' : ''}.`, 'ok');
    $('#gBronze').value = '0'; $('#gSilver').value = '0'; $('#gGold').value = '0';
    $('#gmsg').value = '';
    $('#gDirect').checked = false;
  };

  /* ----- Édition d'un coureur (fenêtre modale) ----- */
  const editRider = r => {
    const m = openModal(`<h3>Modifier ${esc(r.name)}</h3>
      <form id="rf" class="rform">
        <label>Nom<input name="name" required maxlength="80" value="${esc(r.name)}"></label>
        <label>Pays (code à 2 ou 3 lettres)<input name="country" maxlength="3" value="${esc(r.country)}"></label>
        <label>Équipe<input name="team" maxlength="80" value="${esc(r.team || '')}"></label>
        <label>Spécialité<select name="specialty">${SPECIALTIES.map(s => `<option value="${s}" ${s === r.specialty ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Rareté<select name="rarity">${RARITY_ORDER.map(k => `<option value="${k}" ${k === r.rarity ? 'selected' : ''}>${RARITY[k].label}</option>`).join('')}</select></label>
        <fieldset class="stats-edit"><legend>Compétences</legend>
          ${STAT_DEFS.map(s => `<label>${esc(s.label)}<input type="number" min="0" step="1" inputmode="numeric" name="${s.key}" value="${Number(r[s.key]) || 0}"></label>`).join('')}
        </fieldset>
        <div id="rprev"></div>
        <p id="rerr" class="error" role="alert"></p>
        <div class="row"><button type="button" class="btn" data-x>Annuler</button><button type="submit" class="btn primary">Enregistrer</button></div>
      </form>`);
    const f = $('#rf', m.box);
    const readStats = () => Object.fromEntries(STAT_DEFS.map(s => [s.key, Math.max(0, parseInt(f.elements[s.key].value, 10) || 0)]));
    const preview = () => { $('#rprev', m.box).innerHTML = RiderStatsBars(readStats()); };
    STAT_DEFS.forEach(s => { f.elements[s.key].oninput = preview; });
    preview();
    $('[data-x]', m.box).onclick = m.close;
    f.onsubmit = async e => {
      e.preventDefault();
      const err = $('#rerr', m.box); err.textContent = '';
      const name = f.elements['name'].value.trim().replace(/\s+/g, ' ');
      if (!name) { err.textContent = 'Le nom est obligatoire.'; return; }
      const rawCountry = f.elements['country'].value.trim();
      const country = rawCountry ? toIso2(rawCountry) : '';
      if (country === null) { err.textContent = 'Code pays inconnu (2 ou 3 lettres, ex. FR ou FRA).'; return; }
      const patch = {
        name, country,
        team: f.elements['team'].value.trim(),
        specialty: f.elements['specialty'].value,
        rarity: f.elements['rarity'].value,
        ...readStats(),
      };
      const btn = $('[type="submit"]', f); btn.disabled = true;
      const { data, error } = await sb.from('riders').update(patch).eq('id', r.id).select().single();
      btn.disabled = false;
      if (error) {
        err.textContent = /duplicate|unique/i.test(error.message) ? 'Un coureur porte déjà ce nom.' : error.message;
        return;
      }
      riders = riders.map(x => (x.id === r.id ? data : x)).sort((a, b) => a.name.localeCompare(b.name));
      rebuildLookups(); drawManage(); drawVisuals();
      m.close();
      toast('Coureur modifié.', 'ok');
    };
  };

  /* ----- Suppression d'un coureur (avec confirmation) ----- */
  const deleteRider = async r => {
    if (!await confirmBox(`Supprimer définitivement ${r.name} du catalogue ?`, 'Supprimer')) return;
    const res = await rpc('admin_delete_rider', { p_id: r.id });
    if (res.ok) {
      riders = riders.filter(x => x.id !== r.id);
      rebuildLookups(); drawManage(); drawVisuals();
      toast('Coureur supprimé.', 'ok');
    }
  };

  rebuildLookups(); drawManage(); drawVisuals(); drawPlayers(); drawPicked();

  $('#mq').oninput = () => { shown = 50; drawManage(); };
  $('#mr').oninput = () => { shown = 50; drawManage(); };
  $('#mmore').onclick = () => { shown += 50; drawManage(); };
  $('#mbody').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = +(b.dataset.edit || b.dataset.del);
    const r = riders.find(x => x.id === id);
    if (!r) return;
    if (b.dataset.edit) editRider(r); else deleteRider(r);
  };

  /* ----- Validation de course : récupération automatique du classement ----- */
  $('#vFetch').onclick = async () => {
    const url = $('#vurl').value.trim();
    if (!url) return toast('Colle d\'abord le lien de la page de résultats.', 'error');
    const btn = $('#vFetch'); btn.disabled = true;
    $('#vStatus').className = 'muted';
    $('#vStatus').textContent = 'Récupération en cours…';
    const out = await callFn('fetch-race-results', { url });
    btn.disabled = false;
    if (!out.ok) {
      $('#vStatus').className = 'error';
      $('#vStatus').textContent = out.error + ' Tu peux coller les résultats à la main dans « Saisie manuelle ».';
      $('#vManualBox').open = true;
      return;
    }
    top30 = out.data.results.map(r => ({ position: r.position, rider_name: r.rider_name }));
    $('#vStatus').className = 'muted';
    $('#vStatus').textContent = `${top30.length} résultat${top30.length > 1 ? 's' : ''} récupéré${top30.length > 1 ? 's' : ''}. Vérifie le tableau ci-dessous avant de valider.${out.data.warning ? ' ⚠ ' + out.data.warning : ''}`;
    drawTop();
  };

  /* ----- Validation de course : saisie manuelle de secours ----- */
  $('#vPasteBtn').onclick = () => {
    const list = parsePastedResults($('#vPaste').value);
    if (!list.length) return toast('Colle au moins un coureur (un par ligne).', 'error');
    top30 = list;
    $('#vStatus').className = 'muted';
    $('#vStatus').textContent = `${top30.length} ligne${top30.length > 1 ? 's' : ''} saisie${top30.length > 1 ? 's' : ''} à la main. Vérifie le tableau ci-dessous avant de valider.`;
    drawTop();
  };

  /* ----- Validation de course : calcul et distribution des gains ----- */
  $('#vBtn').onclick = async () => {
    const raceId = +$('#vr').value;
    if (!raceId) return toast('Aucune course sélectionnée.', 'error');
    const n = statusInfo().filter(s => s.ok).length;
    if (!n) return toast('Aucun coureur du catalogue dans ce classement.', 'error');
    const race = races.find(r => r.id === raceId);
    const raceName = race ? race.name : 'cette course';
    const coef = race ? fmtMult(courseMult(race)) : fmtMult(1);
    if (!await confirmBox(`Valider définitivement « ${raceName} » (coefficient de la course ${coef}) ? ${n} coureur${n > 1 ? 's' : ''} du catalogue sera${n > 1 ? 'ont' : ''} pris en compte, les points et pièces seront crédités aux joueurs.`, 'Valider')) return;

    const btn = $('#vBtn'); btn.disabled = true;
    const out = await callFn('process-race-scores', {
      race_id: raceId,
      results: top30.map(r => ({ position: r.position, rider_name: String(r.rider_name).trim() })),
    });
    if (out.ok) {
      const d = out.data;
      toast(`Course validée (${fmtMult(d.multiplier ?? 1)}) : ${d.players} équipe${d.players > 1 ? 's' : ''} créditée${d.players > 1 ? 's' : ''}, ${d.total_points} points distribués.`, 'ok');
      pageAdmin();
      return;
    }
    if (out.unreachable) {
      /* Secours : la fonction serveur est injoignable, on applique le même calcul SQL directement */
      if (await confirmBox('La fonction serveur est injoignable. Valider directement avec le calcul intégré à la base (même barème, même résultat) ?', 'Valider directement')) {
        const r = await rpc('validate_race', {
          p_race_id: raceId,
          p_results: matchedResults(),
          p_names: top30.map(t => ({ pos: t.position, name: String(t.rider_name).trim() })),
        });
        if (r.ok) { toast('Course validée, gains distribués.', 'ok'); pageAdmin(); return; }
      }
    } else {
      toast(out.error, 'error');
    }
    btn.disabled = false;
    refreshStatus();
  };

  /* ----- Import des courses (prestige facultatif en 4e champ) ----- */
  $('#raceBtn').onclick = async () => {
    const rows = []; const bad = [];
    for (const line of $('#raceCsv').value.split('\n').map(l => l.trim()).filter(Boolean)) {
      const [name, category = '', dt, tierRaw = ''] = line.split(';').map(s => s.trim());
      const d = dt ? new Date(dt.replace(' ', 'T')) : null;
      const tier = tierRaw === '' ? 3 : parseInt(tierRaw, 10);
      if (!name || !d || isNaN(d) || ![1, 2, 3].includes(tier)) { bad.push(line); continue; }
      rows.push({ name, category, start_at: d.toISOString(), tier_level: tier });
    }
    if (bad.length) return toast('Ligne invalide : ' + bad[0], 'error');
    if (!rows.length) return toast('Rien à importer.', 'error');
    const { error } = await sb.from('races').upsert(rows, { onConflict: 'name,start_at', ignoreDuplicates: true });
    if (error) return toast(error.message, 'error');
    toast(`${rows.length} course(s) importée(s).`, 'ok'); pageAdmin();
  };

  /* ----- Import des coureurs (création ou mise à jour, en une seule requête) ----- */
  $('#riderBtn').onclick = async () => {
    const report = $('#riderReport');
    report.innerHTML = '';
    const { rows, errors } = parseRidersText($('#riderCsv').value);
    if (errors.length) {
      report.innerHTML = `<div class="panel" style="margin:.8rem 0 0"><b class="error">${errors.length} ligne(s) invalide(s) : rien n'a été importé.</b>
        <ul>${errors.slice(0, 20).map(e => `<li>Ligne ${e.n} : ${esc(e.error)}</li>`).join('')}</ul>
        ${errors.length > 20 ? `<p class="muted" style="margin:.4rem 0 0">… et ${errors.length - 20} autre(s).</p>` : ''}</div>`;
      return toast('Corrige les lignes invalides avant d\'importer.', 'error');
    }
    if (!rows.length) return toast('Rien à importer.', 'error');

    /* Un même coureur répété dans le texte : la dernière ligne l'emporte.
       Un coureur déjà au catalogue (nom comparé sans accents ni majuscules) garde son nom actuel. */
    const existing = new Map(riders.map(r => [nameKey(r.name), r]));
    const unique = new Map();
    rows.forEach(r => unique.set(nameKey(r.name), r));
    let created = 0, updated = 0;
    const payload = [...unique.entries()].map(([k, r]) => {
      const ex = existing.get(k);
      if (ex) { updated++; return { ...r, name: ex.name }; }
      created++;
      return r;
    });

    if (!await confirmBox(`Importer ${created} nouveau(x) coureur(s) et mettre à jour ${updated} coureur(s) existant(s) ?`, 'Importer')) return;
    const { error } = await sb.from('riders').upsert(payload, { onConflict: 'name' });
    if (error) return toast(error.message, 'error');
    $('#riderCsv').value = '';
    report.innerHTML = `<p class="muted" style="margin:.8rem 0 0">Import terminé : ${created} créé(s), ${updated} mis à jour.</p>`;
    toast(`${created} créé(s), ${updated} mis à jour.`, 'ok');
    await reloadRiders();
  };

  /* ----- Actualité ----- */
  $('#newsBtn').onclick = async () => {
    const t = $('#nt').value.trim(); if (!t) return toast('Ajoute un titre.', 'error');
    const r = await rpc('post_news', { p_title: t, p_body: $('#nb').value.trim() });
    if (r.ok) { toast('Actualité publiée.', 'ok'); $('#nt').value = ''; $('#nb').value = ''; }
  };
}
