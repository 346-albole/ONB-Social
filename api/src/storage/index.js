// Adaptateur de stockage de fichiers.
//
// Interface (toute implémentation doit la fournir) :
//   put(key, stream, { contentType })  → Promise<{ key, url }>   écrit le fichier
//   getUrl(key)                        → string                  URL publique de lecture
//   delete(key)                        → Promise<void>           supprime (sans erreur si absent)
//   register(app)                      → Promise<void>           routes de service éventuelles
//
// `key` est un chemin relatif sûr (ex. "posts/<user>/<uuid>.jpg"). Les URL
// renvoyées par getUrl() sont stockées telles quelles en base.
//
// Implémentations : 'local' (disque, servi par l'API). Azure Blob Storage
// viendra plus tard (STORAGE_PROVIDER=azure-blob, voir PORTAGE_AZURE.md).
import { config } from '../config.js'
import { createLocalDiskStorage } from './localDisk.js'

const PROVIDERS = {
  local: createLocalDiskStorage,
}

export function createStorage() {
  const factory = PROVIDERS[config.storage.provider]
  if (!factory) throw new Error(`STORAGE_PROVIDER inconnu : ${config.storage.provider}`)
  return factory(config.storage)
}
