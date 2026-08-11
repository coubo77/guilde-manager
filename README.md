# Backend Discord — Wingmate

Petit serveur qui interroge l'API Discord avec le token du bot, pour que
« Wingmate » puisse récupérer automatiquement pseudo, nom d'affichage
et avatar d'un joueur à partir de son identifiant Discord.

Le token du bot reste **uniquement** sur ce serveur — il n'est jamais exposé
au navigateur.

## 1. Créer le bot Discord

1. Allez sur https://discord.com/developers/applications
2. Cliquez sur **New Application**, donnez-lui un nom (ex. « Wingmate »).
3. Dans l'onglet **Bot**, cliquez sur **Reset Token** puis copiez le token
   (vous ne pourrez plus le revoir ensuite — gardez-le en sécurité).
4. Toujours dans **Bot**, activez si besoin l'intent **Server Members Intent**
   (nécessaire pour récupérer le surnom du serveur / la liste des membres).
5. Dans l'onglet **OAuth2 > URL Generator**, cochez le scope `bot`, puis la
   permission **View Channels** (le minimum nécessaire). Copiez l'URL générée
   et ouvrez-la dans un navigateur pour inviter le bot sur votre serveur de guilde.
6. Toujours dans l'onglet **OAuth2** (page générale, pas l'URL Generator),
   notez le **Client ID**, et cliquez sur **Reset Secret** pour obtenir le
   **Client Secret** — vous en aurez besoin à l'étape 3 pour la connexion des
   joueurs.
7. Dans la même page **OAuth2**, section **Redirects**, cliquez sur **Add
   Redirect** et entrez :
   - En local : `http://localhost:3001/auth/discord/callback`
   - En production : `https://guilde.votredomaine.com/auth/discord/callback`
     (remplacez par votre vraie adresse une fois déployé — voir plus bas)

   Vous pouvez ajouter les deux en même temps, pas de souci.

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
DISCORD_GUILD_ID=l'id_du_serveur_copié_à_l'étape_2
DISCORD_REQUIRED_ROLE_NAME=Aion 2
DISCORD_CLIENT_ID=le_client_id_copié_à_l'étape_6
DISCORD_CLIENT_SECRET=le_client_secret_copié_à_l'étape_6
PORT=3001
CORS_ORIGIN=*
```

**Important : connexion Discord obligatoire pour accéder au site.** Depuis
cette version, personne ne peut voir ni modifier quoi que ce soit sans
s'être connecté avec un compte Discord possédant le rôle requis. Une fois
connecté, tout le monde a les mêmes droits (voir, éditer, supprimer) — il
n'y a pas de rôle Admin séparé dans l'application elle-même.

## Connexion Discord obligatoire (remplace l'ancienne synchro manuelle)

À l'ouverture du site, un écran de connexion s'affiche avec un bouton
**🔗 Se connecter avec Discord**. La personne s'authentifie sur Discord
(OAuth2) ; le serveur vérifie qu'elle est bien membre du serveur configuré
(`DISCORD_GUILD_ID`) et qu'elle possède le rôle `DISCORD_REQUIRED_ROLE_NAME`
(« Aion 2 » par défaut) :

- **Rôle présent** → elle est automatiquement ajoutée à la liste des joueurs
  (pseudo, avatar et identifiant Discord pré-remplis, il ne reste qu'à
  choisir sa classe), une session s'ouvre (cookie valable 30 jours), et
  l'application s'affiche normalement.
- **Rôle absent, ou pas membre du serveur** → accès refusé, message explicite,
  aucune session n'est créée, l'écran de connexion reste affiché.

Une fois connectée, la personne voit son pseudo et son avatar dans la barre
latérale, avec un bouton pour se déconnecter (⏻) — qui referme la session et
raffiche l'écran de connexion.

Prérequis :
- `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID` et `DISCORD_CLIENT_SECRET` doivent
  être renseignés dans `.env`.
- L'URL de redirection (`http://localhost:3001/auth/discord/callback` en
  local, ou `https://votre-domaine/auth/discord/callback` en production)
  doit être enregistrée dans le portail développeur Discord (étape 1.7).
- Un rôle nommé exactement « Aion 2 » (insensible à la casse) doit exister
  sur le serveur.

Se reconnecter avec un compte déjà enregistré met simplement à jour son
pseudo Discord et son avatar, sans créer de doublon.

**Remarque sur les sessions** : elles sont gardées en mémoire par le
serveur. Si le service redémarre (mise en veille sur le plan gratuit de
Render après une longue inactivité, par exemple), tout le monde devra se
reconnecter — c'est normal, aucune donnée de la guilde n'est perdue pour
autant (elle reste dans `data.json`).

## 4. Lancer le serveur

```bash
npm start
```

Vous devriez voir :

```
Backend Discord de Wingmate en écoute sur http://localhost:3001
```

Testez avec :

```bash
curl http://localhost:3001/api/discord/123456789012345678
```

## 5. Le site est déjà branché

Depuis cette version, `server.js` sert directement le site (`public/index.html`)
— une seule adresse pour tout (le site *et* l'API). Ouvrez simplement
`http://localhost:3001` dans votre navigateur : plus besoin de configurer
d'URL de backend, l'application détecte automatiquement qu'elle tourne sur
le même serveur.

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

## Annonces de groupes dans Discord (boutons Rejoindre / Quitter)

Depuis un groupe PvE ou PvP sur le site, le bouton **📣 Publier sur Discord**
envoie (ou met à jour) un message dans un salon Discord de votre choix, avec
le nom du groupe, l'activité, la date, et la liste des emplacements. Deux
boutons apparaissent sous le message :

- **✅ Rejoindre** — prend automatiquement le premier emplacement libre.
  Vérifie que la personne a bien le rôle requis, qu'elle a déjà choisi une
  classe sur le site, et qu'elle n'est pas déjà inscrite. Trois classes ne
  peuvent apparaître qu'une seule fois par groupe : **Templier, Clerc et
  Aède** — si l'une d'elles est déjà prise, l'inscription est refusée avec
  un message explicite (visible seulement par la personne qui clique).
- **🚪 Quitter** — libère l'emplacement de la personne dans ce groupe.

Toute inscription/désinscription via Discord met à jour **le site** en temps
réel (le fichier de données partagé), et inversement : si vous modifiez le
groupe sur le site, republiez-le pour rafraîchir le message Discord.

Si la personne qui clique sur "Rejoindre" ne s'est jamais connectée sur le
site, un profil est créé automatiquement à partir de son compte Discord
(comme lors d'une connexion classique), mais sans classe — elle devra en
choisir une sur le site avant de pouvoir rejoindre un groupe.

### Prérequis

- `DISCORD_ANNOUNCE_CHANNEL_ID` dans `.env` : l'ID du salon Discord où
  publier par défaut (clic droit sur le salon → Copier l'identifiant, avec
  le Mode développeur activé dans Discord).
- Le bot doit avoir la permission d'**envoyer des messages** et d'**intégrer
  des liens (embeds)** dans ce salon.
- Le bot reste connecté en permanence à Discord (pas seulement pour des
  requêtes ponctuelles) : c'est nécessaire pour recevoir les clics sur les
  boutons en temps réel.

### ⚠️ Limite du plan gratuit Render

Sur le plan gratuit, Render met le service en veille après ~15 minutes sans
visite sur le site — et le bot se déconnecte avec lui. Le premier clic sur
un bouton Discord après une période d'inactivité peut donc échouer ou mettre
quelques secondes à fonctionner, le temps que Render redémarre le service.
Pour un bot toujours actif, deux options :
- Un service de "ping" gratuit (ex. [UptimeRobot](https://uptimerobot.com))
  qui visite votre site toutes les 10 minutes pour l'empêcher de s'endormir.
- Passer sur un plan Render payant (pas de mise en veille).

## Sauvegarde automatique des joueurs et des groupes

Ce backend sauvegarde aussi automatiquement toutes les données de
l'application (joueurs, classes, groupes) dans un fichier `data.json` créé
à côté de `server.js`, dès que l'URL du backend est configurée dans
« Wingmate ».

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

## Déploiement en ligne avec un nom de domaine OVH

Vous n'avez besoin ni de VPS ni de compétences serveur : un hébergeur Node
gratuit (Render) fait tourner `server.js` (qui sert aussi le site), et vous
pointez votre domaine OVH dessus.

### A. Mettre le code sur GitHub

1. Créez un compte sur https://github.com si besoin.
2. Créez un nouveau dépôt (ex. « guilde-manager »), et mettez-y tout le
   contenu du dossier `discord-backend/` (avec son sous-dossier `public/`).
   *Ne mettez jamais votre fichier `.env` dedans* — il est déjà exclu via
   `.gitignore`.

### B. Déployer sur Render

1. Créez un compte sur https://render.com (gratuit) et connectez-le à GitHub.
2. **New +** → **Web Service** → sélectionnez votre dépôt.
3. Renseignez :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
4. Dans l'onglet **Environment**, ajoutez vos variables (les mêmes que dans
   votre `.env` local) :
   ```
   DISCORD_BOT_TOKEN=...
   DISCORD_GUILD_ID=...
   DISCORD_REQUIRED_ROLE_NAME=Aion 2
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   CORS_ORIGIN=*
   ```
   *(pas besoin de `PORT`, Render le fournit automatiquement)*
5. Cliquez sur **Create Web Service**. Après quelques minutes, Render vous
   donne une adresse du type `https://guilde-manager.onrender.com` — ouvrez-la
   pour vérifier que le site s'affiche bien.

### C. Brancher votre domaine OVH

1. Dans Render, ouvrez votre service → **Settings** → **Custom Domain** →
   **Add Custom Domain**. Entrez le sous-domaine voulu, par exemple
   `guilde.votredomaine.com`, et notez la valeur **CNAME** que Render affiche
   (quelque chose comme `guilde-manager.onrender.com`).
2. Connectez-vous sur https://www.ovh.com/manager/ → **Noms de domaine** →
   votre domaine → onglet **Zone DNS**.
3. **Ajouter une entrée** → type **CNAME** :
   - Sous-domaine : `guilde`
   - Cible : la valeur donnée par Render (avec un point `.` à la fin, ex.
     `guilde-manager.onrender.com.`)
4. Validez. La propagation DNS prend de quelques minutes à quelques heures.
5. Une fois propagé, Render active automatiquement le HTTPS pour votre
   domaine. Votre site est accessible sur `https://guilde.votredomaine.com`.
6. **N'oubliez pas** de retourner sur le portail développeur Discord (étape
   1.7) pour ajouter `https://guilde.votredomaine.com/auth/discord/callback`
   à la liste des Redirects OAuth2 — sans ça, la connexion Discord échouera
   une fois en ligne (le lien local `http://localhost:3001/...` ne suffit
   plus depuis votre domaine public).

### Remarque sur le plan gratuit de Render

Sur le plan gratuit, le service se met en veille après une quinzaine de
minutes sans visite, et met quelques secondes à se "réveiller" au premier
accès suivant — sans conséquence pour un usage occasionnel entre membres de
guilde. Pour un accès toujours instantané, un plan payant (quelques dollars/
mois) ou un VPS reste une option, mais n'est pas nécessaire pour démarrer.

### Rappel sécurité

Ce backend exige désormais une connexion Discord avec le rôle requis pour
tout accès aux données. Toute personne sans ce rôle ne peut ni consulter ni
modifier quoi que ce soit. Une fois connectées, en revanche, toutes les
personnes autorisées ont les mêmes droits complets (voir, éditer,
supprimer) — il n'y a pas de rôle Admin séparé au sein de l'application.

## Déploiement (autres options)

Ce serveur peut aussi être déployé sur Railway, Fly.io, un VPS, etc. — la
même logique s'applique (variables d'environnement, `npm install` puis
`npm start`). Gardez toujours `DISCORD_BOT_TOKEN` en variable d'environnement
secrète, jamais dans le code ou le dépôt Git.
