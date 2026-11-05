# Phase 0 — Audit des dépendances Supabase

Contenu : inventaire des appels Supabase du front, état du schéma SQL, liste des endpoints API proposés et points à trancher. Aucune modification de code dans cette phase.

---

## 1. Point d'entrée et configuration

| Fichier | Rôle |
|---|---|
| `src/lib/supabaseClient.js` | `createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)`, PKCE, session dans `localStorage` (`onb-social-auth`), realtime 10 evt/s |
| `package.json` | `@supabase/supabase-js ^2.45.0` |
| `src/views/HomeView.vue:263` | `freezeIfGif` teste `url.includes('supabase.co')` pour faire un HEAD sur les anciens uploads |
| `src/lib/withTimeout.js` | aucune dépendance (le commentaire mentionne seulement Supabase) |
| `test_moderation.js` | aucun appel Supabase |
| `vercel.json` | rewrite SPA, sans lien avec Supabase |

---

## 2. Auth (`supabase.auth.*`)

| Fichier:ligne | Appel | Usage |
|---|---|---|
| `lib/authStore.js:21` | `getSession()` | init session (store partagé) |
| `lib/useAuth.js:11,25` | `onAuthStateChange`, `getSession()` | composable `useAuth` (doublon de authStore) |
| `App.vue:41` | `onAuthStateChange` | met à jour authStore, charge profil, présence, canal admin |
| `App.vue:115` | `signOut()` | déconnexion |
| `views/AuthView.vue:24,43,50` | `signUp`, `signInWithPassword`, `signOut` | formulaire email/mot de passe |
| `views/AuthCallbackView.vue:25,32` | `exchangeCodeForSession`, `setSession` | retour PKCE / lien email |
| `views/VerifyEmailView.vue:30` | `resend({type:'signup'})` | renvoi d'email de vérification |
| `router/index.js` | `getCurrentSession()` + `session.user.email_confirmed_at` | garde des routes + blocage si email non vérifié |

Usages indirects de `session.user.id` (via `sessionRef`/`getCurrentSession`) : quasiment toutes les vues, ainsi que `FloatingAi.vue` et `AiView.vue`.

---

## 3. Données (`supabase.from` / `supabase.rpc`), par domaine

Légende : S = select, I = insert, U = update, D = delete, Up = upsert, `count` = `{count:'exact', head:true}`. Les embeds PostgREST (`profiles(...)`, `likes(count)`…) devront être réécrits en jointures SQL côté API.

### 3.1 Profils / session
| Fichier:ligne | Table | Op | Détail |
|---|---|---|---|
| `App.vue:89` | profiles | S | profil courant (colonnes premium/official/coins…) |
| `App.vue:96-105` | follows, profiles | S | following/followers → amis mutuels |
| `FloatingAi.vue:161,192`, `AiView.vue:95` | profiles | S `*` | profil courant |
| `ProfileView.vue:61` | profiles | S `*` | profil courant |
| `ProfileView.vue:69` | profiles | I | crée le profil s'il manque (fait doublon avec `handle_new_user`) |
| `ProfileView.vue:80-82` | posts, follows | S, count | mes posts + `likes(count)`, compteurs abonnés |
| `ProfileView.vue:101-114` | follows, profiles | S | listes abonnés / abonnements |
| `ProfileView.vue:135` | profiles | U | édition profil (payload libre) |
| `ProfileView.vue:167,185,198,213,223,238,248` | profiles | U | avatar / chat_bg / banner / badge (url ou null) |
| `ProfileView.vue:279,303` | notification_preferences | S, Up | préférences notifs |
| `UserProfileView.vue:43-57` | profiles, posts, follows | S, count | profil public, posts, compteurs |
| `UserProfileView.vue:70` | follows | S `id` | est-ce que je suis ? (**la colonne `follows.id` n'existe pas**) |
| `UserProfileView.vue:89,94` | follows | D, I | unfollow/follow |
| `UserProfileView.vue:118,123` | follows→profiles | S | `profiles!follower_id` / `!following_id` |
| `ExploreView.vue:34,37` | profiles, follows | S | annuaire (tous sauf moi) + mes follows |
| `ExploreView.vue:54,63` | follows | D, I | follow/unfollow |
| `ExploreView.vue:75` | posts | S | posts d'un user + `likes(count)` |

### 3.2 Feed / posts / likes / commentaires / reels
| Fichier:ligne | Table/RPC | Op | Détail |
|---|---|---|---|
| `HomeView.vue:56` | posts | S | feed complet + profiles + likes(id,user_id) + comments(+profiles), **sans limite** |
| `HomeView.vue:84,88` / `ReelsView.vue:65,71` | likes | D, I | like/unlike |
| `HomeView.vue:97-99` | likes, comments, posts | D | suppression post (cascade côté client) |
| `HomeView.vue:149` / `ReelsView.vue:78` | comments | I | commentaire |
| `HomeView.vue:174` | comments | D | suppression commentaire |
| `HomeView.vue:221` / `ReelsView.vue:109` | posts | I | nouveau post (après upload) |
| `HomeView.vue:292` / `ReelsView.vue:162` | rpc `increment_post_views` | — | compteur de vues |
| `HomeView.vue:310,341` | posts, comments | S | re-fetch d'une ligne reçue en realtime |
| `HomeView.vue:367,378` | announcements, admin_broadcasts | S | bannières actives (le `js_content` est exécuté via `new Function`) |
| `ReelsView.vue:30` | posts | S | vidéos (`media_url ilike %.mp4/webm/mov/m4v`), limit 30 |
| `HomeView.vue:115,165,199,230,302` (et ailleurs) | profiles | S | relit `warnings_count, is_banned` avant d'écrire |

### 3.3 Messages privés (ChatView)
| Ligne | Table | Op | Détail |
|---|---|---|---|
| 56, 81, 206, 252 | profiles | S | moi / ami / état ban |
| 66, 98, 179, 314 | messages | U | marquer lu (tout / par ami / un message) |
| 109-112 | follows, messages, blocks | S | construction de la liste d'amis (mutuels + interlocuteurs − bloqués) |
| 130 | profiles | S | profils des amis |
| 138, 145 | messages | S, count | dernier message et non-lus **par ami (N+1)** |
| 171 | messages | S | conversation (100 derniers) |
| 237 | messages | I | envoi (texte + image) |
| 280, 288 | messages | U | édition / suppression logique |
| 351, 363 | follows, blocks | I | suivre / bloquer depuis le chat |

### 3.4 Chat global
`GlobalChatView.vue` : 40 (profil), 90 (S 200 msgs + profiles), 110 (re-fetch realtime), 153 (I), 196 (U deleted), 225 (U edit), 144/169 (état ban).

### 3.5 Groupes
`GroupsView.vue` : 70 (profil), 81 (S groups + `group_members(count)`), 88 (mes adhésions), 116/142 (S group_messages + profiles), 196 (I message, `created_at` fourni par le client), 218 (S membres + profiles), 236 (D kick), 257 (D quitter), 268 (I rejoindre), 289+299 (I groupe puis I membre admin, sans transaction), 323 (S profiles `ilike username` pour invitations), 335 (I invitation), 396 (D groupe).

### 3.6 Forum
`ForumView.vue` : 73 (profil), 90 (S forum_posts + profiles + votes/comments count, limit 50), 101/165 (mes votes post/commentaire), 157/190 (S commentaires), 206/212/224/230 (D/I votes), 253 (I commentaire), 285-287 (D post : votes, commentaires, post), 294-295 (D commentaire), 336 (I post), 246/272/309/320/353 (état ban).

### 3.7 Coins / abonnements
`CoinView.vue` : 58 (profil), 64/100 (S coin_transactions, limit 30), 80 (rpc `buy_subscription`).

### 3.8 Modération côté utilisateur
| Fichier:ligne | Table | Op | Détail |
|---|---|---|---|
| `lib/moderation.js:47` | forbidden_words | S | mots actifs (filtrage fait dans le navigateur) |
| `lib/moderation.js:98,109` | profiles | U | **l'utilisateur s'avertit / se bannit lui-même** |
| `lib/spam.js:35,65,68` | profiles | U | idem (anti-spam) |
| `lib/spam.js:39,58` | `item.table` (dynamique) | U `deleted=true` | tables passées : `global_messages`, `forum_comments`, `forum_posts`, `comments`, `posts`, `messages`. **`posts`, `comments` et `forum_posts` n'ont pas de colonne `deleted`**, donc la requête échoue aujourd'hui sans que personne ne le voie |

### 3.9 Stats pour aiBrain
`lib/aiBrain.js:64-65` et `AiView.vue:100-101` : count profiles et posts. `aiBrain.js:152` : `site_settings.is_troll_mode`.

### 3.10 Admin (`AdminView.vue`, 80 appels)
| Lignes | Tables / RPC | Fonction |
|---|---|---|
| 86 | profiles | vérif `is_admin` |
| 98-103 | profiles, posts, comments, messages, groups, global_messages | compteurs |
| 119, 247, 264, 287, 501 | profiles | liste users, toggle d'un champ `[field]` dynamique, bio, couleur, champs premium/official |
| 272-277 | posts, comments, likes, group_members, global_messages, profiles | suppression user (cascade côté client) |
| 293 | admin_commands | I `reload` |
| 133, 146, 300-302 | posts (+likes/comments) | liste posts / reels, suppression |
| 160, 313, 320 | groups | liste, suppression, privé/public |
| 173, 326, 333 | global_messages | liste, suppression, **purge totale** (`neq id 0`) |
| 186, 197, 341 | messages, profiles | liste DMs, suppression |
| 220, 348 | comments | liste, suppression |
| 235, 358, 373, 378 | announcements | CRUD |
| 240, 387, 407, 412 | admin_broadcasts | CRUD (`html_content`, `js_content`) |
| **421** | **rpc `admin_run_sql`** | **console SQL → à supprimer** |
| 469, 483 | profiles, rpc `admin_grant_coins` | coins |
| 537-597 | profiles, posts, comments, coin_transactions, global_messages | analytics (tire **toutes** les lignes, agrégation dans le navigateur) |
| 666, 1809, 1813 | user_reports (+`reporter:reporter_id(*)`, `resolved_by(*)`) | signalements |
| 685, 698 | moderation_flags | flags |
| 708, 724, 745, 751 | forbidden_words | CRUD |
| 761, 780, 788, 813, 818, 834, 838 | profiles, moderation_action_logs | avertir / sanctionner / bannir + journal |
| 877, 893, 916, 929 | featured_content, posts | mise en avant |
| 952, 968, 992, 998 | content_curation_rules | CRUD |
| 1009, 1016 | site_settings | mode troll |

Remarque : aucune vue n'insère dans `user_reports`. Le front ne fait que les lire.

---

## 4. Stockage (`supabase.storage.from('media')`)

Toujours `upload(path, file)` suivi de `getPublicUrl(path)`. C'est l'URL publique complète qui est enregistrée en base. Le front ne supprime jamais de fichier.

| Fichier:ligne | Usage → colonne |
|---|---|
| `HomeView.vue:218` | post → `posts.media_url` |
| `ReelsView.vue:103` | reel → `posts.media_url` |
| `ChatView.vue:223` | image DM → `messages.image_url` |
| `ForumView.vue:330` | image forum → `forum_posts.image_url` |
| `GroupsView.vue:283` | bannière → `groups.banner_url` |
| `ProfileView.vue:164,182,210,235` | `avatar_url`, `chat_bg_url`, `banner_url`, `custom_badge_url` |

---

## 5. Temps réel (`supabase.channel`)

| Fichier:ligne | Canal | Événements | Filtre / autorisation nécessaire |
|---|---|---|---|
| `HomeView.vue:308` | `home-feed` | posts INSERT/DELETE, likes INSERT/DELETE, comments INSERT | tous les authentifiés |
| `ChatView.vue:297` | `dm_inbox:{uid}` | messages INSERT `receiver_id=uid` | uniquement l'utilisateur concerné |
| `GlobalChatView.vue:107` | `global-chat-v3` | global_messages INSERT/UPDATE/DELETE | authentifiés |
| `GroupsView.vue:136` | `grpchat:{gid}` | group_messages INSERT/UPDATE/DELETE | membres du groupe (selon policy) |
| `ForumView.vue:184` | `forum-post-{id}` | forum_comments INSERT | authentifiés |
| `App.vue:125` | `admin_cmd_{uid}` | admin_commands INSERT `target_user_id=uid` | utilisateur ciblé (rechargement à distance) |
| `aiBrain.js:157` | `public:site_settings` | site_settings UPDATE | tous |
| `stores/presence.js:19` | `online-users` | presence sync/join/leave, `track()` sauf si `is_invisible` | authentifiés |

Supabase Realtime appliquait le RLS sur `postgres_changes`. Le serveur WebSocket devra faire lui-même ces vérifications au moment de l'abonnement.

---

## 6. Schéma SQL : état des lieux

Fichiers analysés : `migration/MIGRATION.sql`, `V4` à `V15`, `V9_COINS`, `NOTIFICATIONS`, `supabase/migrations/20260325_moderation.sql`, `MIGRATION_V16_BETA_FEATURES.sql`, `setup_site_settings.sql`. `ROLLBACK_V7.sql` est ignoré.

**Constats importants :**
1. **La table `profiles` n'est créée nulle part.** Les migrations ne font qu'y ajouter des colonnes (`ALTER TABLE ... ADD COLUMN`). Elle venait du template Supabase. Il faudra la reconstruire : `id uuid PK`, `email`, `username`, `bio`, `avatar_url`, `updated_at`, plus les colonnes ajoutées (is_admin, banner_*, chat_bg_url, username_color, is_premium/official, coins/abonnements, warnings_count, is_banned, is_anonymous, is_invisible, created_at).
2. **FK vers `auth.users`** sur follows, messages, group_*, etc. (une soixantaine d'occurrences). Les embeds `profiles!follower_id` du front supposent des FK vers `profiles`. Je propose de les remplacer toutes par des FK vers `profiles(id)`.
3. **Migrations redondantes** : V4, V5 et V6 se présentent chacune comme « complètes » et recréent les mêmes policies ; V9 et V9_COINS sont quasi identiques (V9_COINS ajoute `DEFAULT 'admin_grant'`, je retiens celle-là). `MIGRATION.sql` crée `group_chats` et un `group_members` qui pointe dessus, alors que le front utilise `groups`. Je retiens la version `groups` (V4 et suivantes) et j'abandonne `group_chats`, qui n'est pas utilisée.
4. **Spécifique Supabase à retirer** : `ALTER PUBLICATION supabase_realtime` (~24 lignes), trigger `on_auth_user_created`/`handle_new_user` sur `auth.users` (remplacé par l'upsert API), `MIGRATION_V10` (UPDATE `auth.users.email_confirmed_at`, supprimé), `admin_run_sql`. Aucune policy sur le schéma `storage` n'a été trouvée.
5. **Shim nécessaire** : `auth.uid()` (≈250 occurrences), `auth.role()` (uniquement dans `site_settings`), rôles `anon`/`authenticated`, `GRANT ... TO authenticated` (V14).
6. **Fonctions/triggers conservés** : `buy_subscription`, `admin_grant_coins`, `expire_lapsed_subscriptions`, `increment_post_views` (tous SECURITY DEFINER), `is_admin(uuid)`, `check_message_block` (trigger blocks), `handle_new_like/follow/comment` (alimentent `notifications`).
7. **Tables sans usage côté front** : `group_posts`, `group_post_likes`, `notifications`, `subscription_payments` (utilisée par `buy_subscription`), `trending_content`. Je les conserve dans le schéma.

**Failles de sécurité constatées** (aujourd'hui, seul le RLS protège les données) :
- `profiles_update_own` : `USING (auth.uid() = id)` sans `WITH CHECK` par colonne. N'importe quel utilisateur peut se donner `is_admin`, des `onb_coins`, `is_premium`, ou se débannir.
- `site_settings` : n'importe quel utilisateur authentifié peut modifier le mode troll.
- Le ban et les avertissements sont décidés et écrits par le navigateur (`moderation.js`, `spam.js`).
- `admin_broadcasts.js_content` est exécuté via `new Function` dans le navigateur de chaque utilisateur. Fonctionnalité voulue, mais c'est du XSS stocké réservé aux admins.

---

## 7. Endpoints API proposés

Toutes les routes sont sous `/api`. Elles sont authentifiées (JWT) sauf mention contraire. Chaque requête passe dans une transaction avec `SET LOCAL ROLE authenticated` et le `sub` positionné. Les champs modifiables sont listés explicitement dans chaque route.

**Auth / moi**
- `POST /dev-auth/login` `{username}` → JWT signé localement · `GET /dev-auth/jwks.json` *(publics, actifs seulement si `DEV_AUTH_ENABLED=true`)*
- `GET /me` → profil complet (créé par upsert à la première requête)
- `PATCH /me` → champs autorisés : username, bio, banner_color, username_color, avatar_url, banner_url, chat_bg_url, custom_badge_url (url ou null), is_anonymous/is_invisible (admins)
- `GET /me/social` → ids suivis, ids abonnés, profils des amis mutuels
- `GET|PUT /me/notification-preferences`
- `GET /me/coin-transactions` · `POST /me/subscriptions` `{type}` (→ `buy_subscription`)

**Profils / follows / blocks**
- `GET /profiles?search=&limit=` (annuaire Explore, recherche pour invitations)
- `GET /profiles/:id` → champs publics + `followers_count`, `following_count`, `is_following`
- `GET /profiles/:id/posts` · `GET /profiles/:id/followers` · `GET /profiles/:id/following`
- `PUT|DELETE /profiles/:id/follow` · `PUT /profiles/:id/block`

**Posts / feed**
- `GET /posts?kind=feed|reels&limit=&before=` (le feed est illimité aujourd'hui, je propose une limite par défaut sans changer l'UI)
- `POST /posts` · `DELETE /posts/:id` (cascade likes/commentaires dans une transaction)
- `POST /posts/:id/views` · `PUT|DELETE /posts/:id/like`
- `POST /posts/:id/comments` · `DELETE /comments/:id`
- `GET /announcements/active` · `GET /broadcasts/active`

**Messages privés**
- `GET /conversations` → amis avec dernier message et nombre de non-lus (une seule requête SQL au lieu du N+1)
- `GET /conversations/:userId/messages` · `POST /conversations/:userId/messages`
- `POST /conversations/:userId/read` · `POST /conversations/read-all`
- `PATCH /messages/:id` · `DELETE /messages/:id` (suppression logique)

**Chat global** : `GET|POST /global-messages` · `PATCH|DELETE /global-messages/:id`

**Groupes**
- `GET /groups` (avec nombre de membres et `is_member`) · `POST /groups` (crée le groupe et ajoute le créateur comme admin dans la même transaction) · `DELETE /groups/:id`
- `POST /groups/:id/join` · `DELETE /groups/:id/members/me`
- `GET /groups/:id/members` · `POST /groups/:id/members` `{user_id}` · `DELETE /groups/:id/members/:userId`
- `GET|POST /groups/:id/messages` (`created_at` fixé par le serveur)

**Forum**
- `GET|POST /forum/posts` · `DELETE /forum/posts/:id`
- `GET|POST /forum/posts/:id/comments` · `DELETE /forum/comments/:id`
- `PUT|DELETE /forum/posts/:id/vote` · `PUT|DELETE /forum/comments/:id/vote`

**Modération (utilisateur)** : `GET /moderation/forbidden-words` + endpoints de sanction, à définir selon la décision D3 ci-dessous.

**Divers** : `GET /site-settings` · `GET /stats` (`{profiles, posts}` pour aiBrain)

**Fichiers** : `POST /files` (multipart, `{kind}` → `{url}`) · `GET /files/*` (service disque local)

**Temps réel** : `GET /realtime` (upgrade WebSocket, JWT dans le premier message ou en query). Abonnements : `feed`, `dm:{uid}`, `global-chat`, `group:{gid}`, `forum-post:{id}`, `user-commands:{uid}`, `site-settings`, `presence`. Les événements transportent la ligne déjà enrichie (avec le profil), ce qui évite au front de refaire un fetch.

**Admin** (`/admin/*`, `is_admin` vérifié dans l'API et par le RLS)
- `GET /admin/overview` · `GET /admin/analytics` (agrégations faites en SQL)
- `GET /admin/users?sort=` · `PATCH /admin/users/:id` (champs autorisés) · `DELETE /admin/users/:id` · `POST /admin/users/:id/reload`
- `POST /admin/users/:id/warn` · `POST /admin/users/:id/sanction` · `POST /admin/users/:id/ban` (avec `moderation_action_logs`)
- `GET /admin/posts?kind=` · `DELETE /admin/posts/:id` · `GET /admin/comments` · `DELETE /admin/comments/:id`
- `GET /admin/messages` · `DELETE /admin/messages/:id`
- `GET /admin/global-messages` · `DELETE /admin/global-messages/:id` · `DELETE /admin/global-messages` (purge)
- `GET /admin/groups` · `PATCH|DELETE /admin/groups/:id`
- CRUD `/admin/announcements`, `/admin/broadcasts`, `/admin/forbidden-words`, `/admin/featured`, `/admin/curation-rules`
- `GET /admin/featured/candidates?since=` · `GET /admin/reports` · `PATCH /admin/reports/:id` · `GET /admin/moderation-flags` · `PATCH /admin/moderation-flags/:id`
- `GET /admin/coins/users` · `POST /admin/coins/grant` (→ `admin_grant_coins`)
- `PATCH /admin/site-settings`
- ~~`admin_run_sql`~~ supprimé, ainsi que l'onglet « SQL » de l'admin

---

## 8. Choix techniques proposés

- **Fastify** plutôt qu'Express : validation par JSON Schema intégrée (utile puisque chaque route liste ses champs autorisés), plugins officiels maintenus (`@fastify/websocket`, `@fastify/multipart`, `@fastify/static`), hooks `onRequest` pour la transaction RLS, support ESM natif, et ça tourne sur App Service sans adaptation (Functions possible via un adaptateur).
- **`pg` (node-postgres)** avec du SQL paramétré, sans ORM, pour garder la main sur `SET LOCAL ROLE` et `set_config`.
- **`jose`** pour valider les JWT via JWKS distant (issuer/audience/claim en variables d'env) et pour signer les tokens du mode dev.
- Monorepo minimal : `api/` (package séparé) et front à la racine. `npm run dev` lance les deux via `concurrently`.

---

## 9. Points à décider (avant la Phase 1)

- **D1 – Table `profiles`** : je la reconstruis (voir §6.1). `username` doit-il être `UNIQUE` ? Valeur par défaut : claim `preferred_username`/`name`, sinon partie locale de l'email.
- **D2 – Failles RLS** : faut-il, en plus du filtrage des champs par l'API, durcir le schéma (trigger qui empêche un non-admin de modifier is_admin/coins/premium/ban sur son profil, `site_settings` modifiable par les admins seulement) ? Ou recopier le RLS tel quel ?
- **D3 – Modération/anti-spam** : (a) garder la détection dans le navigateur avec un endpoint étroit `POST /me/strike` qui avertit et bannit selon le seuil côté serveur ; ou (b) déplacer `checkModeration` et l'anti-spam dans l'API, à l'écriture.
- **D4 – Canaux temps réel hors liste** : l'existant comprend aussi `admin_cmd_{uid}`, `site_settings` et `forum-post-{id}`. Je les inclus dans l'adaptateur ?
- **D5 – URL des fichiers en base** : stocker l'URL publique renvoyée par l'adaptateur (comportement actuel) plutôt qu'une clé à résoudre à chaque lecture.
- **D6 – UI d'auth** : `AuthView` remplacé par un écran minimal (champ « nom d'utilisateur » en mode dev, bouton « Se connecter avec Microsoft » plus tard). `VerifyEmailView` supprimée. `/auth/callback` conservée en squelette pour la redirection MSAL. `useAuth.js` fusionné dans le nouveau module d'auth.
- **D7 – `js_content` des broadcasts** : conserver l'exécution via `new Function` (comportement actuel) ?
- **D8 – Bugs existants** : `follows.id` lu mais inexistant ; soft-delete anti-spam sur des tables sans colonne `deleted`. Je corrige au minimum (booléen `is_following` ; whitelist des tables qui ont `deleted`) ou je laisse tel quel ?

### Décisions retenues (validées le 2026-11-05)

- **D1** : `profiles.username` UNIQUE. En cas de collision à l'upsert, un suffixe numérique est ajouté.
- **D2** : l'API filtre les champs modifiables. En plus, un trigger `profiles_guard` empêche un utilisateur non-admin (rôle `authenticated`) de modifier les colonnes sensibles (is_admin, coins, premium/official, is_official…). Les fonctions SECURITY DEFINER ne sont pas concernées. `site_settings` est modifiable par les admins seulement.
- **D3** : `moderation.js` reste tel quel (détection dans le navigateur). L'API expose seulement ce qu'il lui faut : augmenter `warnings_count` et passer `is_banned` à true sur son propre profil (jamais l'inverse).
- **D4** : les 8 canaux temps réel sont inclus.
- **D5** : l'URL publique des fichiers est stockée en base (un CDN est prévu côté Azure).
- **D6** : auth prête pour MSAL : écran de connexion minimal, `/auth/callback` en squelette.
- **D7** : `js_content` des broadcasts conservé (réservé aux admins, comportement actuel).
- **D8** : anti-spam (`spam.js`) supprimé ; `follows.id` remplacé par un booléen `is_following`.
- **Vérification d'email** : supprimée entièrement (vue, route, garde, MIGRATION_V10).
