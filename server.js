/**
 * Backend "Guilde Manager" — récupération de profils Discord.
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

// Récupère les membres du serveur Discord possédant un rôle donné (par nom).
// Utilisé pour importer automatiquement les joueurs ayant le rôle "Aion 2".
// IMPORTANT : cette route doit être déclarée AVANT '/api/discord/:id' ci-dessous,
// sinon Express interprète "role-members" comme une valeur de :id.
app.get('/api/discord/role-members', async (req, res) => {
  if (!GUILD_ID) {
    return res.status(400).json({ error: 'guild_not_configured', message: 'DISCORD_GUILD_ID doit être renseigné dans .env pour synchroniser les membres du serveur.' });
  }
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'server_misconfigured', message: 'Le token du bot Discord n\'est pas configuré côté serveur.' });
  }
  const roleName = (req.query.role || process.env.DISCORD_SYNC_ROLE_NAME || 'Aion 2').toString();

  try {
    const rolesRes = await discordFetch(`/guilds/${GUILD_ID}/roles`);
    if (rolesRes.status === 401) {
      return res.status(502).json({ error: 'unauthorized', message: 'Autorisation insuffisante : le token du bot est invalide.' });
    }
    if (!rolesRes.ok) {
      return res.status(502).json({ error: 'connection_error', message: `Erreur de connexion à Discord (code ${rolesRes.status}).` });
    }
    const roles = await rolesRes.json();
    const role = roles.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
      return res.status(404).json({ error: 'role_not_found', message: `Aucun rôle nommé « ${roleName} » n'a été trouvé sur ce serveur Discord.` });
    }

    const result = await fetchAllGuildMembers(GUILD_ID);
    if (result.error) {
      if (result.status === 403) {
        return res.status(502).json({ error: 'forbidden', message: 'Autorisation insuffisante : vérifiez que le "Server Members Intent" est activé pour le bot et qu\'il a la permission de voir les membres.' });
      }
      return res.status(502).json({ error: 'connection_error', message: `Erreur de connexion à Discord (code ${result.status}).` });
    }

    const members = result.members
      .filter(m => m.user && !m.user.bot && Array.isArray(m.roles) && m.roles.includes(role.id))
      .map(m => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.user.global_name || m.user.username,
        nickname: m.nick || null,
        avatarUrl: avatarUrl(m.user.id, m.user.avatar),
      }));

    res.json({ role: { id: role.id, name: role.name }, members });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'connection_error', message: 'Problème de connexion à Discord.' });
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
  console.log(`Backend Discord de Guilde Manager en écoute sur http://localhost:${PORT}`);
});