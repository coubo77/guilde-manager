/**
 * Backend "Wingmate" — récupération de profils Discord.
 *
 * Ce serveur est le SEUL endroit où le token du bot Discord doit exister.
 * Il n'est jamais envoyé au navigateur. Le front-end appelle uniquement
 * GET /api/discord/:id sur ce serveur.
 *
 * Démarrage :
 *   1. npm install
 *   2. cp .env.example .env   puis renseigner DISCORD_BOT_TOKEN
 *   3. npm start
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REQUIRED_ROLE_NAME = process.env.DISCORD_REQUIRED_ROLE_NAME || 'Aion 2';
const DISCORD_API = 'https://discord.com/api/v10';
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '5mb' }));

// Sert le site (public/index.html) depuis ce même serveur : un seul service à
// héberger, et plus de souci de CORS puisque tout vient du même domaine.
app.use(express.static(path.join(__dirname, 'public')));

if (!BOT_TOKEN) {
  console.warn('[ATTENTION] DISCORD_BOT_TOKEN est manquant dans .env — les requêtes /api/discord/:id échoueront.');
}
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('[ATTENTION] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET manquants dans .env — la connexion Discord des joueurs échouera.');
}

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

// Accès libre : aucune authentification. Toute personne ayant accès au
// backend peut lire et écrire les données.
app.get('/api/state', (req, res) => {
  const state = readState();
  res.json(state || { players: [], classes: [], groups: [] });
});

app.put('/api/state', (req, res) => {
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
  res.json({ ok: true, botTokenConfigured: !!BOT_TOKEN, guildConfigured: !!GUILD_ID });
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

// Étape 1 : on envoie le joueur s'authentifier sur Discord.
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

// Étape 2 : Discord renvoie ici avec un code. On vérifie l'identité et le rôle,
// puis on ajoute/actualise automatiquement le joueur dans data.json.
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

    const state = readState() || { players: [], classes: [], groups: [] };
    state.players = state.players || [];
    const avatarUrlStr = avatarUrl(user.id, user.avatar);
    const displayName = member.nick || user.global_name || user.username;

    let p = state.players.find(pl => pl.discordId === user.id);
    if (p) {
      p.discordUsername = user.username;
      p.discordAvatar = avatarUrlStr;
      p.discordSynced = true;
    } else {
      state.players.push({
        id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        pseudo: uniquePseudo(state.players, displayName),
        classId: '', secondClassId: '', status: 'Nouveau joueur',
        discordId: user.id, discordUsername: user.username, discordAvatar: avatarUrlStr,
        discordSynced: true,
      });
    }
    writeState(state);

    res.redirect('/?discord_login=success');
  } catch (err) {
    console.error(err);
    res.redirect('/?discord_login=error');
  }
});

app.get('/api/discord/:id', async (req, res) => {
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