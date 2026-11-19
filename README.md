# ONB-Social

Réseau social : SPA Vue 3 + Vite, API Node.js (Fastify) et PostgreSQL.
L'API sert aussi le front buildé, sur le même port. L'IA (`aiBrain.js`,
transformers.js) tourne dans le navigateur.

L'auth, le stockage de fichiers et le temps réel passent par des adaptateurs,
pour pouvoir être branchés plus tard sur Entra ID, Blob Storage et Web PubSub.

## Prérequis

- Node.js ≥ 20
- PostgreSQL 16 (Azure Database for PostgreSQL : 16.15), local ou distant,
  avec un compte propriétaire (superuser en local, compte admin du serveur sur
  Azure)

## Installation

```sh
npm install
cp .env.example .env      # puis adapter les valeurs (voir ci-dessous)
```

Créez une base vide, par exemple `createdb onb_social`, puis initialisez-la :

```sh
npm run db:migrate
```

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

## Lancement en développement

```sh
npm run dev
```

- Front (Vite, rechargement à chaud) : http://localhost:5173
- API : http://localhost:3000. En dev, Vite relaie `/api` vers l'API.

Connexion : en mode dev (`DEV_AUTH_ENABLED=true`, `VITE_AUTH_PROVIDER=dev`),
l'écran de connexion ne demande qu'un nom d'utilisateur. Le compte est créé à la
première connexion, et le même nom redonne toujours le même compte.

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
| `VITE_AUTH_PROVIDER` | `dev` ou `msal` (front) |

Aucun secret n'est commité : `.env`, la clé de signature dev (`api/.dev-auth/`)
et les médias (`data/`) sont ignorés par git.

## Structure

```
api/                 API Fastify
  src/auth/          validation JWT, création du profil, fournisseur dev
  src/routes/        endpoints par domaine
  scripts/           db-migrate, make-admin
db/                  schema.sql (schéma consolidé + RLS), seed.sql
src/                 front Vue
  lib/api.js         client unique de l'API
  lib/auth/          module d'auth (interface, implémentation dev, squelette MSAL)
docs/                audit et notes de portage
```
