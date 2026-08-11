/**
 * Backend "Wingmate" — récupération de profils Discord + connexion obligatoire.
 *
 * Ce serveur est le SEUL endroit où le token du bot et le client secret Discord
 * doivent exister. Ils ne sont jamais envoyés au navigateur.
 *
 * Démarrage :
 *   1. npm install
 *   2. cp .env.example .env   puis renseigner les variables Discord
 *   3. npm start
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();
app.set('trust proxy', 1); // nécessaire pour détecter le HTTPS derrière Render/un proxy

const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REQUIRED_ROLE_NAME = process.env.DISCORD_REQUIRED_ROLE_NAME || 'Aion 2';
const DEFAULT_ANNOUNCE_CHANNEL_ID = process.env.DISCORD_ANNOUNCE_CHANNEL_ID || '';
const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'wingmate_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

// Classes ne pouvant apparaître qu'une seule fois par groupe (Templier, Clerc, Aède).
const RESTRICTED_CLASS_IDS = ['c2', 'c7', 'c8'];

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Sert le site (public/index.html) depuis ce même serveur : un seul service à
// héberger, et plus de souci de CORS puisque tout vient du même domaine.
// L'accès aux DONNÉES (API) reste protégé séparément par la session ci-dessous ;
// servir les fichiers statiques (HTML/CSS/JS/images) sans contrôle est nécessaire
// pour que la page puisse d'abord se charger et afficher l'écran de connexion.
app.use(express.static(path.join(__dirname, 'public')));

if (!BOT_TOKEN) {
  console.warn('[ATTENTION] DISCORD_BOT_TOKEN est manquant dans .env — les requêtes /api/discord/:id échoueront.');
}
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('[ATTENTION] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET manquants dans .env — la connexion Discord échouera.');
}

/* ---------------------------------------------------------
   Stockage clé/valeur persistant.
   Utilise Upstash Redis (gratuit, survit aux redéploiements) si configuré
   via UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Sinon, retombe sur
   un fichier local (pratique en développement, mais PERDU à chaque
   redéploiement sur l'hébergement gratuit de Render — voir le README).
   --------------------------------------------------------- */

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);

if (!USE_REDIS) {
  console.warn('[ATTENTION] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN manquants — stockage local utilisé. Les joueurs, groupes ET les connexions seront perdus à chaque redéploiement sur le plan gratuit de Render. Voir le README pour brancher une base gratuite persistante (Upstash).');
}

function localKeyPath(key){
  const safe = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
  return path.join(__dirname, `.localstore-${safe}.json`);
}

async function kvGet(key){
  if (USE_REDIS) {
    try {
      const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.result === undefined ? null : data.result;
    } catch (e) {
      console.error('Upstash GET échoué pour', key, e.message);
      return null;
    }
  }
  try {
    return fs.readFileSync(localKeyPath(key), 'utf8');
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value){
  if (USE_REDIS) {
    try {
      const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: value,
      });
      return res.ok;
    } catch (e) {
      console.error('Upstash SET échoué pour', key, e.message);
      return false;
    }
  }
  try {
    const p = localKeyPath(key);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, value, 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error('Écriture locale échouée pour', key, e.message);
    return false;
  }
}

async function kvDel(key){
  if (USE_REDIS) {
    try {
      const res = await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      return res.ok;
    } catch (e) { return false; }
  }
  try { fs.unlinkSync(localKeyPath(key)); return true; } catch (e) { return false; }
}

/* ---------------------------------------------------------
   Sessions — la connexion Discord est obligatoire pour accéder aux
   données de l'application. Persistées (voir ci-dessus) pour survivre
   aux redémarrages/redéploiements du serveur.
   --------------------------------------------------------- */

async function createSession(user){
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session = { ...user, expiresAt: Date.now() + SESSION_DURATION_MS };
  await kvSet(`wingmate:session:${sessionId}`, JSON.stringify(session));
  return sessionId;
}

async function getSessionUser(req){
  const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const raw = await kvGet(`wingmate:session:${sessionId}`);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch (e) { return null; }
  if (!session || session.expiresAt < Date.now()) {
    await kvDel(`wingmate:session:${sessionId}`);
    return null;
  }
  return session;
}

async function requireSession(req, res, next){
  const user = await getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Connexion Discord requise.' });
  }
  req.sessionUser = user;
  next();
}

function setSessionCookie(req, res, sessionId){
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    sameSite: 'lax',
    maxAge: SESSION_DURATION_MS,
    path: '/',
  });
}

// Le front-end interroge cette route au chargement pour savoir si quelqu'un
// est déjà connecté (et afficher soit l'écran de connexion, soit l'application).
app.get('/api/session', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: { pseudo: user.pseudo, avatarUrl: user.avatarUrl, discordId: user.discordId } });
});

app.get('/auth/discord/logout', async (req, res) => {
  const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
  if (sessionId) await kvDel(`wingmate:session:${sessionId}`);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/');
});

/* ---------------------------------------------------------
   Données de l'application (joueurs, classes, groupes)
   --------------------------------------------------------- */

async function readState(){
  const raw = await kvGet('wingmate:state');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Connexions "live" (Server-Sent Events) : chaque onglet ouvert du site
// garde une connexion HTTP ouverte ici, et reçoit un message instantané
// dès que les données changent (sauvegarde depuis le site, inscription
// via un bouton Discord, publication, suppression...).
const sseClients = new Set();
function broadcastState(state) {
  const payload = `data: ${JSON.stringify({ players: state.players || [], classes: state.classes || [], groups: state.groups || [] })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

async function writeState(state){
  await kvSet('wingmate:state', JSON.stringify(state));
  broadcastState(state);
}

// Flux temps réel : le site s'y connecte une fois et reçoit les mises à jour
// au fil de l'eau, sans avoir à revérifier régulièrement de son côté.
app.get('/api/events', requireSession, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('\n');
  sseClients.add(res);
  // Message de battement de cœur régulier pour éviter que le proxy (Render)
  // ne coupe la connexion pour cause d'inactivité.
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

// Lecture et écriture des données : réservées aux personnes connectées via Discord.
app.get('/api/state', requireSession, async (req, res) => {
  const state = await readState();
  res.json(state || { players: [], classes: [], groups: [] });
});

app.put('/api/state', requireSession, async (req, res) => {
  const { players, classes, groups } = req.body || {};
  if (!Array.isArray(players) || !Array.isArray(classes) || !Array.isArray(groups)) {
    return res.status(400).json({ error: 'invalid_body', message: 'players, classes et groups doivent être des tableaux.' });
  }
  try {
    await writeState({ players, classes, groups, savedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'write_failed', message: 'Impossible d\'écrire les données.' });
  }
});

function avatarUrl(userId, avatarHash) {
  if (!avatarHash) {
    // Avatar par défaut Discord (basé sur l'id, système "nouveau" post-migration)
    const index = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=128`;
}

async function discordFetch(path) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  return res;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, botTokenConfigured: !!BOT_TOKEN, guildConfigured: !!GUILD_ID, botOnline: discordClient.isReady() });
});

async function getRoleByName(roleName){
  const rolesRes = await discordFetch(`/guilds/${GUILD_ID}/roles`);
  if (!rolesRes.ok) {
    const err = new Error('roles_fetch_failed');
    err.status = rolesRes.status;
    throw err;
  }
  const roles = await rolesRes.json();
  return roles.find(r => r.name.toLowerCase() === roleName.toLowerCase()) || null;
}

async function fetchAllGuildMembers(guildId) {
  let members = [];
  let after = '0';
  for (let i = 0; i < 10; i++) { // jusqu'à 10 000 membres (10 pages de 1000)
    const res = await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (!res.ok) return { error: true, status: res.status };
    const batch = await res.json();
    members = members.concat(batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return { error: false, members };
}

// Compare les membres Discord ayant le rôle requis avec les joueurs déjà
// connus du site, pour lister ceux qui n'ont encore jamais rejoint Wingmate.
app.get('/api/discord/unconnected-members', requireSession, async (req, res) => {
  if (!GUILD_ID) {
    return res.status(400).json({ error: 'guild_not_configured', message: "DISCORD_GUILD_ID doit être renseigné dans .env." });
  }
  try {
    const role = await getRoleByName(REQUIRED_ROLE_NAME);
    if (!role) {
      return res.status(404).json({ error: 'role_not_found', message: `Aucun rôle « ${REQUIRED_ROLE_NAME} » trouvé sur le serveur.` });
    }
    const result = await fetchAllGuildMembers(GUILD_ID);
    if (result.error) {
      if (result.status === 403) {
        return res.status(502).json({ error: 'forbidden', message: 'Autorisation insuffisante : activez le "Server Members Intent" pour le bot.' });
      }
      return res.status(502).json({ error: 'connection_error', message: `Erreur de connexion à Discord (code ${result.status}).` });
    }
    const state = (await readState()) || { players: [] };
    const knownIds = new Set((state.players || []).map(p => p.discordId));
    const withRole = result.members.filter(m => m.user && !m.user.bot && Array.isArray(m.roles) && m.roles.includes(role.id));
    const notConnected = withRole
      .filter(m => !knownIds.has(m.user.id))
      .map(m => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.nick || m.user.global_name || m.user.username,
        avatarUrl: avatarUrl(m.user.id, m.user.avatar),
      }));
    res.json({ totalWithRole: withRole.length, notConnected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'unknown', message: 'Erreur lors de la vérification.' });
  }
});

function uniquePseudo(players, base){
  let candidate = base;
  let i = 2;
  while (players.find(p => p.pseudo.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${base} (${i})`; i++;
  }
  return candidate;
}

// Récupère (ou crée) le profil joueur correspondant à un utilisateur Discord.
// Utilisé à la fois par la connexion sur le site et par les clics sur les
// boutons "Rejoindre"/"Quitter" dans Discord (une personne peut rejoindre un
// groupe depuis Discord avant même de s'être jamais connectée sur le site).
function upsertPlayerFromDiscord(state, discordUser, member){
  state.players = state.players || [];
  const avatarUrlStr = avatarUrl(discordUser.id, discordUser.avatar);
  let p = state.players.find(pl => pl.discordId === discordUser.id);
  if (p) {
    p.discordUsername = discordUser.username;
    p.discordAvatar = avatarUrlStr;
    p.discordSynced = true;
    return p;
  }
  const displayName = (member && (member.nick || member.nickname)) || discordUser.global_name || discordUser.globalName || discordUser.username;
  p = {
    id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    pseudo: uniquePseudo(state.players, displayName),
    classId: '', secondClassId: '', status: 'Nouveau joueur',
    discordId: discordUser.id, discordUsername: discordUser.username, discordAvatar: avatarUrlStr,
    discordSynced: true,
  };
  state.players.push(p);
  return p;
}

/* ---------------------------------------------------------
   Bot Discord persistant (Gateway) — annonces de groupes avec
   boutons "Rejoindre" / "Quitter", inscription automatique.
   --------------------------------------------------------- */

const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

const CLASS_NAMES_FR = { c1: 'Gladiateur', c2: 'Templier', c3: 'Assassin', c4: 'Rôdeur', c5: 'Sorcier', c6: 'Spiritualiste', c7: 'Clerc', c8: 'Aède' };
// Discord n'affiche pas d'images dans le texte : on utilise des emojis pour
// représenter chaque classe, dans le même esprit que les icônes du site.
const CLASS_EMOJI = { c1: '⚔️', c2: '🛡️', c3: '🗡️', c4: '🏹', c5: '🔥', c6: '🌪️', c7: '✚', c8: '🎵' };

function classDisplayName(state, classId){
  if (!classId) return '?';
  const c = (state.classes || []).find(x => x.id === classId);
  return (c && c.name) || CLASS_NAMES_FR[classId] || classId;
}
function classEmoji(classId){
  return CLASS_EMOJI[classId] || '❔';
}

function buildGroupMessage(group, state){
  const lines = group.slots.map((s, i) => {
    if (!s.playerId) return `\`${i + 1}.\` *Emplacement libre*`;
    const p = (state.players || []).find(x => x.id === s.playerId);
    if (!p) return `\`${i + 1}.\` *Emplacement libre*`;
    return `\`${i + 1}.\` ${classEmoji(p.classId)} **${p.pseudo}** — ${classDisplayName(state, p.classId)}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x8b6bff)
    .setTitle(`⚔️ ${group.name}${group.activity ? ' — ' + group.activity : ''}`)
    .setDescription(lines)
    .setFooter({ text: 'Wingmate — cliquez sur un emplacement vide pour le rejoindre' });

  if (group.date || group.time) {
    embed.addFields({ name: '🗓️ Date', value: `${group.date || ''} ${group.time || ''}`.trim() || '—', inline: true });
  }
  embed.addFields({ name: '👥 Places', value: `${group.slots.filter(s => s.playerId).length} / ${group.slots.length}`, inline: true });

  // Un bouton par emplacement : vert et cliquable s'il est libre, gris et
  // désactivé (juste informatif) s'il est déjà pris. On regroupe 5 boutons
  // par ligne (limite Discord), plus une dernière ligne pour "Quitter".
  const slotButtons = group.slots.map((s, i) => {
    if (!s.playerId) {
      return new ButtonBuilder().setCustomId(`slot:${group.id}:${i}`).setLabel(`${i + 1}. Rejoindre`).setStyle(ButtonStyle.Success);
    }
    const p = (state.players || []).find(x => x.id === s.playerId);
    const label = p ? `${i + 1}. ${p.pseudo}`.slice(0, 80) : `${i + 1}. Pris`;
    return new ButtonBuilder().setCustomId(`slot:${group.id}:${i}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(true);
  });

  const rows = [];
  for (let i = 0; i < slotButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(slotButtons.slice(i, i + 5)));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`leave:${group.id}`).setLabel('🚪 Quitter').setStyle(ButtonStyle.Danger),
  ));

  return { embeds: [embed], components: rows };
}

async function updateGroupMessage(group, state){
  if (!group.discordChannelId || !group.discordMessageId) return;
  try {
    const channel = await discordClient.channels.fetch(group.discordChannelId);
    const message = await channel.messages.fetch(group.discordMessageId);
    await message.edit(buildGroupMessage(group, state));
  } catch (err) {
    console.error('Impossible de mettre à jour le message Discord du groupe', group.id, err.message);
  }
}

discordClient.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const parts = interaction.customId.split(':');
  const action = parts[0];
  if (action !== 'slot' && action !== 'leave') return;
  const groupId = action === 'slot' ? parts[1] : parts[1];
  const slotIndex = action === 'slot' ? Number(parts[2]) : null;

  const state = (await readState()) || { players: [], classes: [], groups: [] };
  state.players = state.players || [];
  state.groups = state.groups || [];
  const group = state.groups.find(g => g.id === groupId);
  if (!group) {
    return interaction.reply({ content: "Ce groupe n'existe plus.", ephemeral: true });
  }

  // Récupération fraîche du membre (fiable, ne dépend pas du cache du bot) et
  // vérification du rôle requis.
  let member;
  try {
    member = await interaction.guild.members.fetch(interaction.user.id);
  } catch (e) {
    return interaction.reply({ content: 'Impossible de vérifier votre profil Discord. Réessayez.', ephemeral: true });
  }
  let role;
  try {
    role = await getRoleByName(REQUIRED_ROLE_NAME);
  } catch (e) {
    return interaction.reply({ content: 'Erreur de vérification du rôle. Réessayez plus tard.', ephemeral: true });
  }
  const hasRole = role && member.roles.cache.has(role.id);
  if (!hasRole) {
    return interaction.reply({ content: `Vous devez avoir le rôle « ${REQUIRED_ROLE_NAME} » pour vous inscrire.`, ephemeral: true });
  }

  const player = upsertPlayerFromDiscord(state, interaction.user, member);

  if (action === 'leave') {
    const slot = group.slots.find(s => s.playerId === player.id);
    if (!slot) {
      await writeState(state);
      return interaction.reply({ content: "Vous n'êtes pas inscrit(e) à ce groupe.", ephemeral: true });
    }
    slot.playerId = null;
    await writeState(state);
    await updateGroupMessage(group, state);
    return interaction.reply({ content: 'Vous avez quitté le groupe.', ephemeral: true });
  }

  // action === 'slot' : rejoindre CET emplacement précis.
  if (group.slots.some(s => s.playerId === player.id)) {
    await writeState(state);
    return interaction.reply({ content: 'Vous êtes déjà inscrit(e) à ce groupe.', ephemeral: true });
  }
  if (!player.classId) {
    await writeState(state);
    return interaction.reply({ content: "Merci de choisir votre classe sur le site Wingmate avant de rejoindre un groupe.", ephemeral: true });
  }
  if (slotIndex == null || slotIndex < 0 || slotIndex >= group.slots.length) {
    await writeState(state);
    return interaction.reply({ content: 'Emplacement invalide.', ephemeral: true });
  }
  if (group.slots[slotIndex].playerId) {
    await writeState(state);
    await updateGroupMessage(group, state); // le message affiché était périmé (pris entre-temps) : on le rafraîchit
    return interaction.reply({ content: 'Cet emplacement vient d\'être pris par quelqu\'un d\'autre. Réessayez sur un autre emplacement.', ephemeral: true });
  }
  if (RESTRICTED_CLASS_IDS.includes(player.classId)) {
    const conflict = group.slots.some(s => {
      if (!s.playerId) return false;
      const pl = state.players.find(x => x.id === s.playerId);
      return pl && pl.classId === player.classId;
    });
    if (conflict) {
      await writeState(state);
      return interaction.reply({ content: `Un(e) ${classDisplayName(state, player.classId)} est déjà inscrit(e) dans ce groupe (une seule personne de cette classe autorisée).`, ephemeral: true });
    }
  }
  group.slots[slotIndex].playerId = player.id;
  await writeState(state);
  await updateGroupMessage(group, state);
  return interaction.reply({ content: 'Vous avez rejoint le groupe !', ephemeral: true });
});

if (BOT_TOKEN) {
  discordClient.login(BOT_TOKEN).catch(err => console.error('Échec de connexion du bot Discord (Gateway) :', err.message));
} else {
  console.warn('[ATTENTION] DISCORD_BOT_TOKEN manquant — le bot ne peut pas se connecter, les annonces Discord sont indisponibles.');
}

// Publie (ou met à jour) l'annonce d'un groupe dans un salon Discord.
app.post('/api/groups/:id/publish', requireSession, async (req, res) => {
  const targetChannelId = (req.body && req.body.channelId) || DEFAULT_ANNOUNCE_CHANNEL_ID;
  if (!targetChannelId) {
    return res.status(400).json({ error: 'channel_missing', message: "Aucun salon Discord configuré (DISCORD_ANNOUNCE_CHANNEL_ID ou channelId)." });
  }
  if (!discordClient.isReady()) {
    return res.status(503).json({ error: 'bot_offline', message: "Le bot Discord n'est pas connecté pour le moment. Réessayez dans quelques instants." });
  }
  const state = (await readState()) || { players: [], classes: [], groups: [] };
  const group = (state.groups || []).find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'not_found', message: 'Groupe introuvable.' });

  try {
    const channel = await discordClient.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({ error: 'invalid_channel', message: "Ce salon n'existe pas ou n'accepte pas de messages." });
    }
    const payload = buildGroupMessage(group, state);
    let message = null;
    if (group.discordMessageId) {
      try {
        message = await channel.messages.fetch(group.discordMessageId);
        await message.edit(payload); // republication : pas de mention, on met juste à jour
      } catch (e) {
        message = null; // ancien message introuvable : on en republie un nouveau (avec ping)
      }
    }
    if (!message) {
      // Première publication (ou message d'origine perdu) : on ping le rôle requis une seule fois.
      let sendPayload = payload;
      try {
        const role = await getRoleByName(REQUIRED_ROLE_NAME);
        if (role) {
          sendPayload = { ...payload, content: `<@&${role.id}>`, allowedMentions: { roles: [role.id] } };
        }
      } catch (e) {
        // Si la récupération du rôle échoue, on publie quand même, simplement sans ping.
      }
      message = await channel.send(sendPayload);
    }
    group.discordChannelId = targetChannelId;
    group.discordMessageId = message.id;
    await writeState(state);
    res.json({ ok: true, messageId: message.id, channelId: targetChannelId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'publish_failed', message: "Impossible de publier sur Discord. Vérifiez que le bot a la permission d'écrire dans ce salon." });
  }
});

// Supprime un groupe/event ET son annonce Discord associée (si publiée).
app.delete('/api/groups/:id', requireSession, async (req, res) => {
  const state = (await readState()) || { players: [], classes: [], groups: [] };
  state.groups = state.groups || [];
  const group = state.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'not_found', message: 'Groupe introuvable.' });

  if (group.discordChannelId && group.discordMessageId && discordClient.isReady()) {
    try {
      const channel = await discordClient.channels.fetch(group.discordChannelId);
      const message = await channel.messages.fetch(group.discordMessageId);
      await message.delete();
    } catch (e) {
      // Le message est peut-être déjà supprimé manuellement, ou le bot est hors ligne :
      // on n'empêche pas la suppression du groupe pour autant.
      console.warn('Impossible de supprimer le message Discord du groupe', group.id, e.message);
    }
  }

  state.groups = state.groups.filter(g => g.id !== req.params.id);
  await writeState(state);
  res.json({ ok: true });
});

// Étape 1 : on envoie la personne s'authentifier sur Discord.
app.get('/auth/discord/login', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).send("Connexion Discord non configurée côté serveur (DISCORD_CLIENT_ID manquant).");
  }
  const redirectUri = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    prompt: 'consent',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// Étape 2 : Discord renvoie ici avec un code. On vérifie l'identité et le rôle.
// Si tout est bon : on ajoute/actualise le joueur ET on ouvre une session
// (cookie). Si le rôle manque ou que la personne n'est pas membre du serveur,
// l'accès est refusé et aucune session n'est créée.
app.get('/auth/discord/callback', async (req, res) => {
  const { code, error: oauthError } = req.query;
  if (oauthError) return res.redirect('/?discord_login=denied&reason=cancelled');
  if (!code) return res.redirect('/?discord_login=error&reason=missing_code');
  if (!GUILD_ID) return res.redirect('/?discord_login=error&reason=guild_not_configured');
  if (!CLIENT_ID || !CLIENT_SECRET) return res.redirect('/?discord_login=error&reason=server_misconfigured');

  try {
    const redirectUri = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`;

    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) return res.redirect('/?discord_login=error&reason=token_exchange_failed');
    const tokenData = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) return res.redirect('/?discord_login=error&reason=user_fetch_failed');
    const user = await userRes.json();

    let role;
    try {
      role = await getRoleByName(REQUIRED_ROLE_NAME);
    } catch (e) {
      return res.redirect('/?discord_login=error&reason=role_lookup_failed');
    }
    if (!role) return res.redirect('/?discord_login=error&reason=role_not_found');

    const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${user.id}`);
    if (memberRes.status === 404) return res.redirect('/?discord_login=denied&reason=not_member');
    if (!memberRes.ok) return res.redirect('/?discord_login=error&reason=member_check_failed');
    const member = await memberRes.json();
    if (!Array.isArray(member.roles) || !member.roles.includes(role.id)) {
      return res.redirect('/?discord_login=denied&reason=missing_role');
    }

    // Rôle validé : on ajoute/actualise le joueur dans data.json.
    // Pas de "classes: []" par défaut ici : ce backend ne connaît pas les
    // classes par défaut (elles vivent côté site). Un tableau vide serait
    // ensuite considéré comme "sauvegardé" et écraserait les classes par
    // défaut du site au chargement suivant.
    const state = (await readState()) || { players: [] };
    state.groups = state.groups || [];
    state.players = state.players || [];

    const p = upsertPlayerFromDiscord(state, user, member);
    await writeState(state);

    // Rôle validé : on ouvre une session pour cette personne.
    const avatarUrlStr = avatarUrl(user.id, user.avatar);
    const sessionId = await createSession({ discordId: user.id, pseudo: p.pseudo, avatarUrl: avatarUrlStr });
    setSessionCookie(req, res, sessionId);

    res.redirect('/?discord_login=success');
  } catch (err) {
    console.error(err);
    res.redirect('/?discord_login=error');
  }
});

app.get('/api/discord/:id', requireSession, async (req, res) => {
  const { id } = req.params;

  if (!/^\d{17,20}$/.test(id)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Identifiant Discord invalide.' });
  }
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'server_misconfigured', message: 'Le token du bot Discord n\'est pas configuré côté serveur.' });
  }

  try {
    const userRes = await discordFetch(`/users/${id}`);

    if (userRes.status === 401) {
      return res.status(502).json({ error: 'unauthorized', message: 'Autorisation insuffisante : le token du bot est invalide ou expiré.' });
    }
    if (userRes.status === 404) {
      return res.status(404).json({ error: 'not_found', message: 'Utilisateur introuvable sur Discord.' });
    }
    if (!userRes.ok) {
      return res.status(502).json({ error: 'connection_error', message: `Erreur de connexion à Discord (code ${userRes.status}).` });
    }

    const user = await userRes.json();
    let nickname = null;
    let guildWarning = null;

    if (GUILD_ID) {
      try {
        const memberRes = await discordFetch(`/guilds/${GUILD_ID}/members/${id}`);
        if (memberRes.ok) {
          const member = await memberRes.json();
          nickname = member.nick || null;
        } else if (memberRes.status === 403) {
          guildWarning = 'bot_missing_permissions';
        } else if (memberRes.status === 404) {
          guildWarning = 'bot_not_in_guild_or_member_not_found';
        }
      } catch (e) {
        guildWarning = 'connection_error_guild';
      }
    }

    return res.json({
      id: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      nickname,
      avatarUrl: avatarUrl(user.id, user.avatar),
      guildWarning,
    });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'connection_error', message: 'Problème de connexion à Discord.' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend Discord de Wingmate en écoute sur http://localhost:${PORT}`);
});