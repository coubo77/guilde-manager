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
const DATA_FILE = path.join(__dirname, 'data.json');
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
   Sessions (en mémoire) — la connexion Discord est obligatoire
   pour accéder aux données de l'application.
   --------------------------------------------------------- */

const sessions = new Map(); // sessionId -> { discordId, pseudo, avatarUrl, expiresAt }

function createSession(user){
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { ...user, expiresAt: Date.now() + SESSION_DURATION_MS });
  return sessionId;
}

function getSessionUser(req){
  const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function requireSession(req, res, next){
  const user = getSessionUser(req);
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
app.get('/api/session', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: { pseudo: user.pseudo, avatarUrl: user.avatarUrl, discordId: user.discordId } });
});

app.get('/auth/discord/logout', (req, res) => {
  const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
  if (sessionId) sessions.delete(sessionId);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/');
});

/* ---------------------------------------------------------
   Stockage persistant (fichier data.json à côté de server.js)
   --------------------------------------------------------- */

function readState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null; // fichier absent ou illisible = pas encore de données sauvegardées
  }
}

function writeState(state) {
  // Écriture "atomique" : on écrit dans un fichier temporaire puis on renomme,
  // pour éviter de corrompre data.json si le processus est interrompu en cours d'écriture.
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, DATA_FILE);
}

// Lecture et écriture des données : réservées aux personnes connectées via Discord.
app.get('/api/state', requireSession, (req, res) => {
  const state = readState();
  res.json(state || { players: [], classes: [], groups: [] });
});

app.put('/api/state', requireSession, (req, res) => {
  const { players, classes, groups } = req.body || {};
  if (!Array.isArray(players) || !Array.isArray(classes) || !Array.isArray(groups)) {
    return res.status(400).json({ error: 'invalid_body', message: 'players, classes et groups doivent être des tableaux.' });
  }
  try {
    writeState({ players, classes, groups, savedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'write_failed', message: 'Impossible d\'écrire le fichier de sauvegarde.' });
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
  const displayName = (member && member.nick) || discordUser.global_name || discordUser.globalName || discordUser.username;
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

function classDisplayName(state, classId){
  if (!classId) return '?';
  const c = (state.classes || []).find(x => x.id === classId);
  return (c && c.name) || CLASS_NAMES_FR[classId] || classId;
}

function buildGroupMessage(group, state){
  const lines = group.slots.map((s, i) => {
    if (!s.playerId) return `**${i + 1}.** _Emplacement libre_`;
    const p = (state.players || []).find(x => x.id === s.playerId);
    if (!p) return `**${i + 1}.** _Emplacement libre_`;
    return `**${i + 1}.** ${p.pseudo} — ${classDisplayName(state, p.classId)}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x8b6bff)
    .setTitle(`${group.name}${group.activity ? ' — ' + group.activity : ''}`)
    .setDescription(lines)
    .setFooter({ text: 'Wingmate — cliquez sur Rejoindre pour vous inscrire' });

  if (group.date || group.time) {
    embed.addFields({ name: '🗓️ Date', value: `${group.date || ''} ${group.time || ''}`.trim() || '—', inline: true });
  }
  embed.addFields({ name: '👥 Places', value: `${group.slots.filter(s => s.playerId).length} / 5`, inline: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`join:${group.id}`).setLabel('✅ Rejoindre').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave:${group.id}`).setLabel('🚪 Quitter').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
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
  const [action, groupId] = interaction.customId.split(':');
  if (action !== 'join' && action !== 'leave') return;

  const state = readState() || { players: [], classes: [], groups: [] };
  state.players = state.players || [];
  state.groups = state.groups || [];
  const group = state.groups.find(g => g.id === groupId);
  if (!group) {
    return interaction.reply({ content: "Ce groupe n'existe plus.", ephemeral: true });
  }

  // Vérification du rôle requis.
  let role;
  try {
    role = await getRoleByName(REQUIRED_ROLE_NAME);
  } catch (e) {
    return interaction.reply({ content: 'Erreur de vérification du rôle. Réessayez plus tard.', ephemeral: true });
  }
  const hasRole = role && interaction.member && interaction.member.roles && interaction.member.roles.cache
    ? interaction.member.roles.cache.has(role.id)
    : false;
  if (!hasRole) {
    return interaction.reply({ content: `Vous devez avoir le rôle « ${REQUIRED_ROLE_NAME} » pour vous inscrire.`, ephemeral: true });
  }

  const player = upsertPlayerFromDiscord(state, interaction.user, interaction.member);

  if (action === 'leave') {
    const slot = group.slots.find(s => s.playerId === player.id);
    if (!slot) {
      writeState(state);
      return interaction.reply({ content: "Vous n'êtes pas inscrit(e) à ce groupe.", ephemeral: true });
    }
    slot.playerId = null;
    writeState(state);
    await updateGroupMessage(group, state);
    return interaction.reply({ content: 'Vous avez quitté le groupe.', ephemeral: true });
  }

  // action === 'join'
  if (group.slots.some(s => s.playerId === player.id)) {
    writeState(state);
    return interaction.reply({ content: 'Vous êtes déjà inscrit(e) à ce groupe.', ephemeral: true });
  }
  if (!player.classId) {
    writeState(state);
    return interaction.reply({ content: "Merci de choisir votre classe sur le site Wingmate avant de rejoindre un groupe.", ephemeral: true });
  }
  if (RESTRICTED_CLASS_IDS.includes(player.classId)) {
    const conflict = group.slots.some(s => {
      if (!s.playerId) return false;
      const pl = state.players.find(x => x.id === s.playerId);
      return pl && pl.classId === player.classId;
    });
    if (conflict) {
      writeState(state);
      return interaction.reply({ content: `Un(e) ${classDisplayName(state, player.classId)} est déjà inscrit(e) dans ce groupe (une seule personne de cette classe autorisée).`, ephemeral: true });
    }
  }
  const freeIdx = group.slots.findIndex(s => !s.playerId);
  if (freeIdx === -1) {
    writeState(state);
    return interaction.reply({ content: 'Ce groupe est complet.', ephemeral: true });
  }
  group.slots[freeIdx].playerId = player.id;
  writeState(state);
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
  const state = readState() || { players: [], classes: [], groups: [] };
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
        await message.edit(payload);
      } catch (e) {
        message = null; // ancien message introuvable : on en republie un nouveau
      }
    }
    if (!message) {
      message = await channel.send(payload);
    }
    group.discordChannelId = targetChannelId;
    group.discordMessageId = message.id;
    writeState(state);
    res.json({ ok: true, messageId: message.id, channelId: targetChannelId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'publish_failed', message: "Impossible de publier sur Discord. Vérifiez que le bot a la permission d'écrire dans ce salon." });
  }
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
    const state = readState() || { players: [] };
    state.groups = state.groups || [];
    state.players = state.players || [];

    const p = upsertPlayerFromDiscord(state, user, member);
    writeState(state);

    // Rôle validé : on ouvre une session pour cette personne.
    const avatarUrlStr = avatarUrl(user.id, user.avatar);
    const sessionId = createSession({ discordId: user.id, pseudo: p.pseudo, avatarUrl: avatarUrlStr });
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