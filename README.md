# Backend Discord — Guilde Manager

Petit serveur qui interroge l'API Discord avec le token du bot, pour que
« Guilde Manager » puisse récupérer automatiquement pseudo, nom d'affichage
et avatar d'un joueur à partir de son identifiant Discord.

Le token du bot reste **uniquement** sur ce serveur — il n'est jamais exposé
au navigateur.

## 1. Créer le bot Discord

1. Allez sur https://discord.com/developers/applications
2. Cliquez sur **New Application**, donnez-lui un nom (ex. « Guilde Manager »).
3. Dans l'onglet **Bot**, cliquez sur **Reset Token** puis copiez le token
   (vous ne pourrez plus le revoir ensuite — gardez-le en sécurité).
4. Toujours dans **Bot**, activez si besoin l'intent **Server Members Intent**
   (nécessaire pour récupérer le surnom du serveur / la liste des membres).
5. Dans l'onglet **OAuth2 > URL Generator**, cochez le scope `bot`, puis la
   permission **View Channels** (le minimum nécessaire). Copiez l'URL générée
   et ouvrez-la dans un navigateur pour inviter le bot sur votre serveur de guilde.

## 2. Récupérer l'ID du serveur (facultatif mais recommandé)

Dans Discord : Paramètres > Avancés > activer le **Mode développeur**, puis
clic droit sur le nom du serveur > **Copier l'identifiant du serveur**.

## 3. Installer et configurer

```bash
cd discord-backend
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez :

```
DISCORD_BOT_TOKEN=le_token_copié_à_l'étape_1
DISCORD_GUILD_ID=l'id_du_serveur_copié_à_l'étape_2   # obligatoire pour la synchro par rôle
PORT=3001
CORS_ORIGIN=*
```

**Important : accès libre, sans mot de passe.** Cette version n'a plus de
distinction Admin/Joueur ni de protection par mot de passe — toute personne
qui ouvre `guilde-manager.html` et peut joindre ce backend a les mêmes
droits complets (voir, éditer, supprimer, synchroniser). Adapté pour un
usage strictement local/personnel. Si vous exposez un jour ce backend au-delà
de votre machine, il faudra remettre une protection (dites-le-moi si besoin).

## Synchroniser les joueurs depuis un rôle Discord

Depuis l'onglet **Joueurs**, le bouton **🔄 Synchroniser (rôle
Aion2)** importe automatiquement tous les membres du serveur Discord
possédant le rôle **Aion2** (nom configurable via `DISCORD_SYNC_ROLE_NAME`
dans `.env`) comme nouveaux joueurs — pseudo, avatar et identifiant Discord
sont pré-remplis ; il ne reste qu'à choisir leur classe.

Prérequis :
- `DISCORD_GUILD_ID` doit être renseigné dans `.env` (voir étape 2 plus haut).
- Le **Server Members Intent** doit être activé dans le portail développeur
  Discord (onglet Bot de votre application) — voir étape 1.4.
- Un rôle nommé exactement « Aion2 » (insensible à la casse) doit exister
  sur le serveur.

Les joueurs déjà importés (même identifiant Discord) ne sont pas dupliqués
lors des synchronisations suivantes — seuls les nouveaux membres du rôle
sont ajoutés.

## 4. Lancer le serveur

```bash
npm start
```

Vous devriez voir :

```
Backend Discord de Guilde Manager en écoute sur http://localhost:3001
```

Testez avec :

```bash
curl http://localhost:3001/api/discord/123456789012345678
```

## 5. Brancher le front-end (Guilde Manager)

Dans l'application, sur l'écran de connexion admin ou dans le formulaire
joueur, indiquez l'URL de ce backend (ex. `http://localhost:3001`) : voir la
variable `DISCORD_API_BASE_URL` en haut du script de `guilde-manager.html`.
En développement local, laissez `CORS_ORIGIN=*` ; en production, restreignez
`CORS_ORIGIN` au domaine exact où l'application est hébergée.

## Réponses de l'API

`GET /api/discord/:id` renvoie :

- `200` → `{ id, username, displayName, nickname, avatarUrl, guildWarning }`
- `400` → identifiant invalide
- `404` → utilisateur introuvable
- `502` avec `error: "unauthorized"` → token du bot invalide
- `502` avec `error: "connection_error"` → problème de connexion à Discord
- `500` avec `error: "server_misconfigured"` → `DISCORD_BOT_TOKEN` manquant

Si `guildWarning` vaut `bot_not_in_guild_or_member_not_found`, le bot n'est
probablement pas présent sur le serveur configuré (`DISCORD_GUILD_ID`) : le
profil global Discord est tout de même renvoyé.

## Sauvegarde automatique des joueurs et des groupes

Ce backend sauvegarde aussi automatiquement toutes les données de
l'application (joueurs, classes, groupes) dans un fichier `data.json` créé
à côté de `server.js`, dès que l'URL du backend est configurée dans
« Guilde Manager ».

- `GET /api/state` renvoie l'état actuel.
- `PUT /api/state` enregistre un nouvel état (l'app l'appelle automatiquement
  environ 600 ms après chaque modification).

Au premier lancement, `data.json` n'existe pas encore : l'application garde
ses données de démonstration et les envoie immédiatement au backend pour
créer le fichier. À chaque rechargement de la page suivant, vos vraies
données sont rechargées depuis ce fichier — plus rien n'est perdu au F5.

**Sauvegardez ce fichier `data.json`** (copie régulière, ou dossier
synchronisé) si vous voulez pouvoir restaurer vos données en cas de
problème : il n'y a pas d'autre copie.

## Déploiement

Ce serveur peut être déployé sur n'importe quel hébergeur Node (Render,
Railway, Fly.io, un VPS, etc.). Gardez toujours `DISCORD_BOT_TOKEN` en
variable d'environnement secrète, jamais dans le code ou le dépôt Git.
