// app.js — authentification, onboarding manager/équipe, coque du jeu
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $app = document.getElementById('app');

const NATS = { FR:'France', BE:'Belgique', IT:'Italie', ES:'Espagne', DE:'Allemagne', NL:'Pays-Bas',
  DK:'Danemark', GB:'Royaume-Uni', CH:'Suisse', PT:'Portugal', NO:'Norvège', US:'États-Unis' };
const state = { user: null, manager: null, team: null, isAdmin: false, tab: 'dashboard' };

// ---------- Utilitaires ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const $ = (id) => document.getElementById(id);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const natOptions = (sel = 'FR') => Object.entries(NATS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
const fmtEUR = (n) => Number(n).toLocaleString('fr-FR') + ' €';

function logoSrc(team) {            // logo par défaut : pastille avec l'initiale
  if (team?.logo_url) return team.logo_url;
  const l = esc((team?.name || '?')[0].toUpperCase());
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='12' fill='#10b981'/><text x='32' y='43' font-size='34' text-anchor='middle' fill='#052e16' font-family='Arial' font-weight='700'>${l}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function avatarSrc(m) {              // avatar par défaut : initiales
  if (m?.photo_url) return m.photo_url;
  const i = esc(((m?.first_name || '?')[0] + (m?.last_name || '')[0]).toUpperCase());
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='32' fill='#334155'/><text x='32' y='41' font-size='26' text-anchor='middle' fill='#e2e8f0' font-family='Arial' font-weight='700'>${i}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// Gère le bouton + message d'erreur d'un formulaire
async function withBusy(btn, errEl, fn) {
  btn.disabled = true; errEl.textContent = '';
  try { await fn(); } catch (e) { errEl.textContent = e.message || String(e); }
  btn.disabled = false;
}

// ---------- Routage selon l'état du joueur ----------
async function route() {
  if (!state.user) return viewAuth();
  const { data: m } = await sb.from('managers').select('*').eq('user_id', state.user.id).maybeSingle();
  state.manager = m;
  if (!m) return viewManager();
  const { data: t } = await sb.from('teams').select('*').eq('manager_id', m.id).maybeSingle();
  state.team = t;
  if (!t) return viewTeam();
  const { data: p } = await sb.from('profiles').select('is_admin').eq('user_id', state.user.id).maybeSingle();
  state.isAdmin = !!p?.is_admin;
  viewGame();
}

// ---------- Écran 1 : connexion / inscription ----------
function viewAuth(mode = 'in') {
  $app.innerHTML = `
    <div class="card narrow">
      <h1>🚴 Cycling Manager</h1>
      <div><label>Email</label><input id="email" type="email" autocomplete="email"></div>
      <div><label>Mot de passe (6 caractères min.)</label><input id="pwd" type="password" autocomplete="current-password"></div>
      <div class="err" id="err"></div>
      <button id="go">${mode === 'in' ? 'Se connecter' : 'Créer le compte'}</button>
      <button class="link" id="swap">${mode === 'in' ? "Pas de compte ? S'inscrire" : 'Déjà un compte ? Connexion'}</button>
    </div>`;
  $('swap').onclick = () => viewAuth(mode === 'in' ? 'up' : 'in');
  $('go').onclick = () => withBusy($('go'), $('err'), async () => {
    const creds = { email: $('email').value.trim(), password: $('pwd').value };
    const { data, error } = mode === 'in' ? await sb.auth.signInWithPassword(creds) : await sb.auth.signUp(creds);
    if (error) throw error;
    if (!data.session) throw new Error('Compte créé : confirmez votre email puis connectez-vous.');
    // la suite est déclenchée par onAuthStateChange
  });
}

// ---------- Écran 2 : création du manager ----------
function viewManager() {
  $app.innerHTML = `
    <div class="card narrow">
      <h1>Votre profil de manager</h1>
      <div class="row2">
        <div><label>Prénom</label><input id="fn"></div>
        <div><label>Nom</label><input id="ln"></div>
      </div>
      <div class="row2">
        <div><label>Âge (25-80)</label><input id="age" type="number" min="25" max="80" value="40"></div>
        <div><label>Nationalité</label><select id="nat">${natOptions()}</select></div>
      </div>
      <div><label>Photo de manager</label><div id="photos" class="muted">Chargement des photos…</div></div>
      <p class="muted">Réputation, pédagogie et négociation sont tirées au hasard (40-60) et évolueront avec vos résultats.</p>
      <div class="err" id="err"></div>
      <button id="go">Continuer</button>
      <button class="link" id="out">Se déconnecter</button>
    </div>`;
  $('out').onclick = () => sb.auth.signOut();

  let photoUrl = null, hasPhotos = false;
  sb.storage.from('manager-photos').list('', { limit: 100 }).then(({ data }) => {
    const files = (data || []).filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    const box = $('photos');
    if (!files.length) { box.textContent = "Aucune photo disponible pour l'instant (un avatar par défaut sera utilisé)."; return; }
    hasPhotos = true; box.className = 'photos';
    box.innerHTML = files.map((f) => {
      const url = sb.storage.from('manager-photos').getPublicUrl(f.name).data.publicUrl;
      return `<img src="${esc(url)}" data-url="${esc(url)}" alt="">`;
    }).join('');
    box.querySelectorAll('img').forEach((img) => (img.onclick = () => {
      box.querySelectorAll('img').forEach((i) => i.classList.remove('sel'));
      img.classList.add('sel'); photoUrl = img.dataset.url;
    }));
  });

  $('go').onclick = () => withBusy($('go'), $('err'), async () => {
    const first_name = $('fn').value.trim(), last_name = $('ln').value.trim(), age = +$('age').value;
    if (!first_name || !last_name) throw new Error('Prénom et nom obligatoires.');
    if (age < 25 || age > 80) throw new Error("L'âge doit être compris entre 25 et 80 ans.");
    if (hasPhotos && !photoUrl) throw new Error('Choisissez une photo de manager.');
    const { error } = await sb.from('managers').insert({
      user_id: state.user.id, first_name, last_name, age, nationality: $('nat').value, photo_url: photoUrl,
      reputation: rnd(40, 60), pedagogy: rnd(40, 60), negotiation: rnd(40, 60),
    });
    if (error) throw error;
    await route();
  });
}

// ---------- Écran 3 : création de l'équipe (Conti-Pro imposée) ----------
function viewTeam() {
  $app.innerHTML = `
    <div class="card narrow">
      <h1>Votre équipe</h1>
      <div><label>Nom de l'équipe</label><input id="tn"></div>
      <div><label>Nationalité (influence les sponsors proposés)</label><select id="tnat">${natOptions(state.manager.nationality)}</select></div>
      <div><label>Logo PNG (optionnel, 1 Mo max)</label><input id="logo" type="file" accept="image/png"></div>
      <p class="muted">Division de départ : <b>Continental Pro</b> · Budget : <b>500 000 €</b></p>
      <div class="err" id="err"></div>
      <button id="go">Lancer ma carrière</button>
    </div>`;
  $('go').onclick = () => withBusy($('go'), $('err'), async () => {
    const name = $('tn').value.trim();
    if (!name) throw new Error("Donnez un nom à l'équipe.");
    let logoUrl = null;
    const file = $('logo').files[0];
    if (file) {
      if (file.type !== 'image/png') throw new Error('Le logo doit être un fichier PNG.');
      if (file.size > 1024 * 1024) throw new Error('Logo trop lourd (1 Mo max).');
      const path = `${state.user.id}.png`;
      const { error: eu } = await sb.storage.from('team-logos').upload(path, file, { upsert: true, contentType: 'image/png' });
      if (eu) throw eu;
      logoUrl = sb.storage.from('team-logos').getPublicUrl(path).data.publicUrl + '?v=' + Date.now();
    }
    const { error } = await sb.rpc('create_team', { p_name: name, p_nationality: $('tnat').value, p_logo_url: logoUrl });
    if (error) throw error;
    await route();
  });
}

// ---------- Écran 4 : coque du jeu (onglets) ----------
const TABS = [
  ['dashboard', '🏠 Tableau de bord'], ['contracts', '💶 Contrats & Sponsors'], ['infra', '🏗️ Infrastructures'],
  ['staff', '🧑‍🏫 Staff'], ['races', '🏁 Courses'], ['search', '🔎 Recherche'], ['ranking', '🏆 Classement UCI'],
];

function viewGame() {
  const t = state.team, tabs = state.isAdmin ? [...TABS, ['admin', '🛡️ Admin']] : TABS;
  $app.innerHTML = `
    <div class="layout">
      <aside>
        <div class="brand"><img src="${esc(logoSrc(t))}" alt=""><div><b>${esc(t.name)}</b><div class="muted">${esc(NATS[t.nationality] || t.nationality)}</div></div></div>
        ${tabs.map(([k, l]) => `<button class="tab ${k === state.tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
        <div style="flex:1"></div>
        <button class="link" id="out">Déconnexion</button>
      </aside>
      <main id="content"></main>
    </div>`;
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; viewGame(); }));
  $('out').onclick = () => sb.auth.signOut();
  renderTab();
}

async function renderTab() {
  const c = $('content'), t = state.team, m = state.manager;
  if (state.tab === 'dashboard') {
    const { count } = await sb.from('riders').select('*', { count: 'exact', head: true }).eq('team_id', t.id);
    const attr = (l, v) => `<div><label>${l} : ${v}/100</label><div class="bar"><i style="width:${v}%"></i></div></div>`;
    c.innerHTML = `
      <h2>Tableau de bord</h2>
      <div class="stats">
        <div class="card stat"><span class="muted">Budget</span><b>${fmtEUR(t.budget)}</b></div>
        <div class="card stat"><span class="muted">Division</span><b>${t.division === 'WORLD_TOUR' ? 'World Tour' : 'Conti Pro'}</b></div>
        <div class="card stat"><span class="muted">Points UCI</span><b>${t.uci_points}</b></div>
        <div class="card stat"><span class="muted">Effectif</span><b>${count ?? 0} coureurs</b></div>
      </div>
      <div class="card" style="display:flex;gap:1rem;align-items:center">
        <img class="avatar" src="${esc(avatarSrc(m))}" alt="">
        <div style="flex:1"><h3>Manager : ${esc(m.first_name)} ${esc(m.last_name)} (${m.age} ans, ${esc(NATS[m.nationality] || m.nationality)})</h3>
        ${attr('Réputation', m.reputation)}${attr('Pédagogie', m.pedagogy)}${attr('Négociation', m.negotiation)}</div></div>`;
  } else if (state.tab === 'ranking') {
    const { data } = await sb.from('teams').select('name, nationality, uci_points').order('uci_points', { ascending: false });
    c.innerHTML = `<h2>Classement UCI</h2><div class="card"><table>${(data || []).map((x, i) =>
      `<tr><td>${i + 1}</td><td>${esc(x.name)} (${esc(x.nationality)})</td><td>${x.uci_points} pts</td></tr>`).join('')}</table></div>`;
  } else {
    const label = [...TABS, ['admin', 'Admin']].find(([k]) => k === state.tab)[1];
    c.innerHTML = `<h2>${label}</h2><div class="card muted">Onglet à construire dans la prochaine étape.</div>`;
  }
}

// ---------- Démarrage ----------
(async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  state.user = session?.user ?? null;
  await route();
  sb.auth.onAuthStateChange(async (_e, s) => {
    const u = s?.user ?? null;
    if (u?.id !== state.user?.id) { state.user = u; await route(); }
  });
})();
