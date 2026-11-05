# ONB-Social

Réseau social : SPA Vue 3 + Vite, API Node.js (Fastify) et PostgreSQL.
L'API sert aussi le front buildé, sur le même port. L'IA (`aiBrain.js`,
transformers.js) tourne dans le navigateur.

L'auth, le stockage de fichiers et le temps réel passent par des adaptateurs,
pour pouvoir être branchés plus tard sur Entra ID, Blob Storage et Web PubSub.

## Prérequis

- Node.js ≥ 20
- PostgreSQL 16, local ou distant, avec un compte propriétaire (superuser en
  local)

## Installation

```sh
npm install
cp .env.example .env      # puis adapter les valeurs (voir ci-dessous)
```

Créez une base vide, par exemple `createdb onb_social`, puis initialisez-la :

```sh
npm run db:init
```

Cette commande applique `db/schema.sql` et `db/seed.sql` si la base est vierge.
Elle crée ou met à jour ensuite le rôle de connexion de l'API, avec
l'utilisateur et le mot de passe de `DATABASE_URL`. Ce rôle n'est pas
superuser : il endosse `authenticated` ou `anon` à chaque requête, et les
policies RLS s'appliquent.

- `npm run db:init -- --reset` repart de zéro (supprime les schémas `public` et
  `auth`). Refusé si `NODE_ENV=production`.

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
npm start                 # API + front buildé sur $PORT, fallback SPA vers index.html
```

En production, les variables sont définies dans les « App settings ». Désactivez
le mode dev : `DEV_AUTH_ENABLED=false`. L'API refuse de démarrer si
`NODE_ENV=production` et que le mode dev est actif.

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
| `DATABASE_ADMIN_URL` | Connexion propriétaire, uniquement pour `db:init` / `db:make-admin` |
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
  scripts/           db-init, make-admin
db/                  schema.sql (schéma consolidé + RLS), seed.sql
src/                 front Vue
  lib/api.js         client unique de l'API
  lib/auth/          module d'auth (interface, implémentation dev, squelette MSAL)
docs/                audit et notes de portage
```
