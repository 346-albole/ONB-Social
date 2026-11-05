// Erreurs HTTP et traduction des erreurs PostgreSQL.

export class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export const badRequest = (msg = 'Requête invalide') => new HttpError(400, msg, 'bad_request')
export const unauthorized = (msg = 'Authentification requise') => new HttpError(401, msg, 'unauthorized')
export const forbidden = (msg = 'Accès refusé') => new HttpError(403, msg, 'forbidden')
export const notFound = (msg = 'Introuvable') => new HttpError(404, msg, 'not_found')

// Codes SQLSTATE → statut HTTP
const PG_STATUS = {
  '42501': [403, 'forbidden'],        // insufficient_privilege / violation RLS
  '23505': [409, 'conflict'],         // unique_violation
  '23503': [400, 'invalid_reference'],// foreign_key_violation
  '23514': [400, 'check_violation'],
  '23502': [400, 'not_null_violation'],
  '22P02': [400, 'invalid_input'],
  '22001': [400, 'value_too_long'],
  'P0001': [400, 'rejected'],         // RAISE EXCEPTION dans une fonction/trigger
}

/** Gestionnaire d'erreurs Fastify. */
export function errorHandler(err, request, reply) {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } })
  }
  if (err.validation) {
    return reply.code(400).send({ error: { code: 'validation', message: err.message } })
  }
  const mapped = err.code && PG_STATUS[err.code]
  if (mapped) {
    const [status, code] = mapped
    request.log.info({ pg: err.code, detail: err.detail }, err.message)
    return reply.code(status).send({ error: { code, message: err.message } })
  }
  if (err.statusCode && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: { code: err.code || 'error', message: err.message } })
  }
  request.log.error(err)
  return reply.code(500).send({ error: { code: 'internal', message: 'Erreur interne' } })
}
