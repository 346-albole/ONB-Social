# ONB-Social

Réseau social : SPA Vue 3 + Vite, API Node.js (Fastify) et PostgreSQL.
L'API sert aussi le front buildé, sur le même port. L'IA (`aiBrain.js`,
transformers.js) tourne dans le navigateur.

L'auth, le stockage de fichiers et le temps réel passent par des adaptateurs,
pour pouvoir être branchés plus tard sur Entra ID, Blob Storage et Web PubSub.

## Prérequis

- Node.js ≥ 20
- PostgreSQL 16, installé nativement en local (aucun Docker requis) ; Azure
  Database for PostgreSQL 16.15 en production. Il faut un compte propriétaire :
  superuser `postgres` en local, compte admin du serveur sur Azure.

## Lancement en local (sans Docker)

L'app tourne en local avec trois éléments : le front Vite, l'API Node et un
PostgreSQL 16 installé nativement sur le poste. Aucun conteneur n'est
nécessaire.

### 1. Installer PostgreSQL 16

| Système | Installation |
|---|---|
| Windows | installeur officiel « PostgreSQL 16 » (EDB) depuis postgresql.org. Notez le mot de passe du compte `postgres` choisi à l'installation. |
| macOS | `brew install postgresql@16 && brew services start postgresql@16` |
| Debian / Ubuntu | `sudo apt install postgresql-16` (dépôt PGDG si besoin) |
| Arch | `sudo pacman -S postgresql`, puis `initdb` et `systemctl start postgresql` |

### 2. Créer une base vide

```sh
createdb -U postgres onb_social
# ou : psql -U postgres -c "CREATE DATABASE onb_social"
```

### 3. Installer les dépendances et configurer `.env`

```sh
npm install
cp .env.example .env
```

Dans `.env`, il suffit en local d'adapter ces valeurs (le reste peut garder ses
valeurs par défaut) :

```dotenv
# compte propriétaire local (superuser postgres)
DATABASE_ADMIN_URL=postgres://postgres:<mot-de-passe-postgres>@localhost:5432/onb_social
# rôle de l'API, créé par db:migrate : mêmes utilisateur et mot de passe des deux côtés
API_DB_USER=onb_api
API_DB_PASSWORD=<choisir-un-mot-de-passe>
DATABASE_URL=postgres://onb_api:<le-même-mot-de-passe>@localhost:5432/onb_social
# mode dev : connexion par simple nom d'utilisateur
DEV_AUTH_ENABLED=true
VITE_AUTH_PROVIDER=dev
```

### 4. Initialiser la base

```sh
npm run db:migrate
```

### 5. Lancer l'app

```sh
npm run dev
```

- Front (Vite, rechargement à chaud) : http://localhost:5173
- API : http://localhost:3000. En dev, Vite relaie `/api` et `/media` vers
  l'API.

Connexion : en mode dev (`DEV_AUTH_ENABLED=true`, `VITE_AUTH_PROVIDER=dev`,
`AUTH_REQUIRED_SCOPE=access_as_user` ou vide),
l'écran de connexion ne demande qu'un nom d'utilisateur. Le compte est créé à la
première connexion, et le même nom redonne toujours le même compte. Pour
devenir admin, voir « Créer un compte admin ».

## `db:migrate` en détail

`db:migrate` se connecte avec `DATABASE_ADMIN_URL` (en TLS si
`DATABASE_SSL=true`) et peut être relancé sans risque :

1. `db/schema.sql` n'est appliqué que si la base est vierge. Ce n'est pas un
   système de migrations versionnées : une évolution future du schéma devra
   être appliquée par un script dédié.
2. `db/seed.sql` est rejoué à chaque fois ; il est idempotent.
3. Le rôle applicatif `API_DB_USER` / `API_DB_PASSWORD` est créé ou mis à jour.
   Il n'est pas superuser et n'a aucun droit direct (`NOINHERIT`). Il endosse
   `authenticated` ou `anon` à chaque requête, et les policies RLS
   s'appliquent. C'est le rôle de `DATABASE_URL` ; l'API n'utilise jamais
   l'admin.
4. Si `JOBS_DB_USER` / `JOBS_DB_PASSWORD` sont définis, le rôle des tâches
   planifiées est créé. Il peut seulement se connecter et exécuter
   `expire_lapsed_subscriptions()`, sans aucun accès aux tables.

Pour la base Azure, lancez la commande depuis un poste avec `DATABASE_SSL=true`
et l'IP du poste autorisée dans le pare-feu du serveur.

- `npm run db:migrate -- --reset` repart de zéro en supprimant les schémas
  `public` et `auth`. Commande réservée à une base locale : elle est refusée si
  `NODE_ENV=production` ou `DATABASE_SSL=true`.

## Production (App Service Node)

```sh
npm install
npm run build             # génère dist/
npm start                 # mode production : API + front buildé sur $PORT
```

`npm start` force `NODE_ENV=production`. Il sert le front buildé, avec renvoi
vers `index.html` pour les routes de l'app, et refuse de démarrer si
`DEV_AUTH_ENABLED=true`. En local, utilisez `npm run dev`.

En production, les variables sont définies dans les « App settings ».
`DATABASE_URL` y utilise le rôle applicatif `API_DB_USER`, avec
`DATABASE_SSL=true`.

### Rôles PostgreSQL

| Rôle | Utilisé par | Droits |
|---|---|---|
| admin du serveur (`DATABASE_ADMIN_URL`) | `db:migrate`, `db:make-admin`, depuis un poste ou la CI | propriétaire du schéma |
| `API_DB_USER` (`DATABASE_URL`) | API (App Service) | aucun droit direct ; endosse `anon` / `authenticated`, RLS appliqué |
| `JOBS_DB_USER` | Function timer (Phase 7) | `CONNECT` et `EXECUTE` sur `expire_lapsed_subscriptions()` uniquement |
| `anon`, `authenticated` | rôles RLS (`NOLOGIN`) | droits sur les tables, filtrés par les policies |

La Function timer utilise donc `JOBS_DB_USER`. Elle ne peut rien faire d'autre
qu'appeler la fonction : `SECURITY DEFINER` l'exécute avec les droits de son
propriétaire, ce qui lui permet de mettre à jour les profils expirés.

## Authentification Microsoft Entra ID (MSAL)

Le front choisit son fournisseur d'auth au build avec `VITE_AUTH_PROVIDER` :

- `dev` : en local, connexion par simple nom d'utilisateur. Nécessite
  `DEV_AUTH_ENABLED=true` côté API, ce qui n'est accepté qu'avec `npm run dev`.
- `msal` : Microsoft Entra ID, flux par redirection avec PKCE
  (`@azure/msal-browser` v5).

### App registration (une seule, pour la SPA et l'API)

1. **Inscription** : single tenant (« Comptes dans cet annuaire
   organisationnel uniquement »).
2. **Authentification → plateforme « Application monopage » (SPA)**, avec les
   URI de redirection :
   - `http://localhost:5173/auth/callback` (dev)
   - `https://<webapp>.azurewebsites.net/auth/callback` (prod)
3. **Exposer une API** :
   - URI d'ID d'application `api://<client-id>` ;
   - scope `access_as_user`, consentement « Administrateurs et utilisateurs ».
4. **Manifeste** : `"requestedAccessTokenVersion": 2` (champ
   `api.requestedAccessTokenVersion`). Le token d'accès est alors émis par
   `https://login.microsoftonline.com/<tenant-id>/v2.0`, avec `aud = <client-id>`.
5. **Autorisations d'API** : ajouter `access_as_user` de cette même app, et
   accorder le consentement administrateur si besoin.

Aucun secret n'est nécessaire : la SPA est un client public (PKCE), et l'API
valide les tokens avec les clés publiques du tenant.

### Variables

| Où | Variable | Valeur |
|---|---|---|
| Build du front | `VITE_AUTH_PROVIDER` | `msal` |
| | `VITE_MSAL_TENANT_ID` / `VITE_MSAL_CLIENT_ID` | ID du tenant / ID d'application (client) |
| | `VITE_MSAL_API_SCOPE` | optionnel ; défaut `api://<client-id>/access_as_user` |
| API (App settings) | `AUTH_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| | `AUTH_AUDIENCE` | `<client-id>` |
| | `AUTH_JWKS_URL` | `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys` |
| | `AUTH_USER_ID_CLAIM` / `AUTH_REQUIRED_SCOPE` | `oid` / `access_as_user` |
| | `DEV_AUTH_ENABLED` | `false` (`npm start` refuse de démarrer sinon) |

Les variables `VITE_*` sont injectées **au moment du build**. L'identifiant
`oid` du compte Entra devient `profiles.id`, et le profil est créé à la
première requête.

### Page « redirect bridge »

MSAL v5 reçoit la réponse d'Entra ID sur une page dédiée, `auth/callback.html`.
C'est la deuxième entrée du build Vite. Elle appelle
`broadcastResponseToMainFrame()` pour transmettre la réponse à la page qui a
lancé la connexion. L'API la sert à `/auth/callback`, avec
`Cache-Control: no-store` et sans en-tête COOP, depuis la même origine.

### Temps réel avec MSAL

`GET /api/realtime/negotiate` est authentifié par le token Bearer (MSAL ou dev,
même validation que le reste de l'API). Il renvoie l'URL du WebSocket et un
ticket à usage unique, valable 30 s. Le WebSocket s'authentifie avec ce ticket,
donc le token n'est jamais envoyé sur la socket.

## Fichiers et temps réel

**Fichiers.** Le front envoie ses uploads à `POST /api/files` via
`uploadFile(file, kind)` (`src/lib/storage.js`). L'API contrôle le type (images
JPEG, PNG, WebP et GIF, vidéos MP4, WebM et MOV ; pas de SVG) et la taille
(`MAX_UPLOAD_MB`). L'adaptateur « disque local » écrit dans `MEDIA_DIR` et
l'API sert les fichiers sous `/media/…`, avec un cache long. L'URL renvoyée est
stockée telle quelle en base. Sur App Service, `MEDIA_DIR=/home/data/media`
pointe vers le stockage persistant, hors du dossier de l'app.

**Temps réel.** Le front utilise `realtime.subscribe(canal, handler)`
(`src/lib/realtime/`). L'API publie après chaque écriture concernée
(`request.server.realtime.publish(canal, événement, données)`). Le transport
local est un WebSocket intégré à l'API, sur le même serveur et le même port
(`/api/realtime`, découvert via `GET /api/realtime/negotiate`). Sur App Service,
il faut activer « Web sockets ».

| Canal | Événements | Qui peut s'abonner |
|---|---|---|
| `feed` | `post:created`, `post:deleted`, `like:created`, `like:deleted`, `comment:created` | tout utilisateur connecté |
| `global-chat` | `message:created`, `message:updated`, `message:deleted`, `messages:cleared` | tout utilisateur connecté |
| `dm:<userId>` | `message:created`, `message:updated` | l'utilisateur lui-même |
| `group:<groupId>` | `message:created`, `member:joined`, `member:left` | membres et admins (révoqué à l'exclusion) |
| `forum-post:<id>` | `comment:created` | tout utilisateur connecté |
| `user:<userId>` | `command` (rechargement à distance par un admin) | l'utilisateur lui-même |
| `site-settings` | `updated` (mode troll) | tout utilisateur connecté |
| `presence` | `sync` (`{ online: [...] }`) | tout utilisateur connecté |

Limite du WebSocket local : l'état est gardé en mémoire et ne vaut que pour une
seule instance de l'API. Pour plusieurs instances, il faudra passer à Azure Web
PubSub (voir `PORTAGE_AZURE.md`).

## Créer un compte admin

1. Connectez-vous une fois avec le compte voulu : le profil est créé à la
   première requête.
2. Exécutez :

   ```sh
   npm run db:make-admin -- <username>
   # retirer les droits : npm run db:make-admin -- <username> --revoke
   ```

Équivalent SQL, avec le compte propriétaire :
`UPDATE public.profiles SET is_admin = true WHERE username = '<username>';`

## Variables d'environnement

La liste complète et commentée est dans `.env.example`. Principales variables :

| Variable | Rôle |
|---|---|
| `PORT` | Port HTTP de l'API (et du front buildé) |
| `DATABASE_URL` | Connexion de l'API (rôle non-superuser) |
| `DATABASE_ADMIN_URL` | Connexion propriétaire, uniquement pour `db:migrate` / `db:make-admin` |
| `API_DB_USER`, `API_DB_PASSWORD` | Rôle applicatif créé par `db:migrate` (utilisateur de `DATABASE_URL`) |
| `JOBS_DB_USER`, `JOBS_DB_PASSWORD` | Rôle de la Function timer (optionnel) |
| `DATABASE_SSL` | `true` pour imposer TLS (Azure) |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` | Validation générique des JWT |
| `AUTH_USER_ID_CLAIM` | Claim portant l'identifiant (GUID) de l'utilisateur, `oid` par défaut |
| `DEV_AUTH_ENABLED` | Active le fournisseur de tokens local (jamais en production) |
| `STATIC_DIR` | Dossier du front buildé (`dist` par défaut) |
| `MEDIA_DIR` | Dossier des fichiers uploadés (`/home/data/media` en production) |
| `STORAGE_PROVIDER`, `MEDIA_PUBLIC_PATH`, `MAX_UPLOAD_MB` | Adaptateur de stockage, préfixe d'URL des médias, taille maximale |
| `REALTIME_PROVIDER` | Adaptateur temps réel (`ws`) |
| `VITE_AUTH_PROVIDER` | `dev` ou `msal` (front, au build) |
| `AUTH_REQUIRED_SCOPE` | Scope exigé dans les tokens (`access_as_user`) |
| `VITE_MSAL_TENANT_ID`, `VITE_MSAL_CLIENT_ID`, `VITE_MSAL_API_SCOPE` | Configuration MSAL (front, au build) |

Aucun secret n'est commité : `.env`, la clé de signature dev (`api/.dev-auth/`)
et les médias (`data/`) sont ignorés par git.

## Structure

```
api/                 API Fastify
  src/auth/          validation JWT, création du profil, fournisseur dev
  src/routes/        endpoints par domaine
  src/storage/       adaptateur de fichiers (disque local)
  src/realtime/      adaptateur temps réel (WebSocket)
  scripts/           db-migrate, make-admin
db/                  schema.sql (schéma consolidé + RLS), seed.sql
src/                 front Vue
  lib/api.js         client unique de l'API
  lib/auth/          module d'auth (interface, fournisseurs dev et MSAL)
  lib/realtime/      client temps réel (interface + WebSocket)
  lib/storage.js     upload de fichiers
docs/                audit et notes de portage
```
