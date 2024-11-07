import { PathLike, promises as fs, accessSync } from 'fs'
import path from 'path'
import { sha256 } from 'js-sha256'
import camelcase from 'camelcase'
import { snakeCase } from 'snake-case'
import { IdlTypeArray } from '../types'
import { TypeMapper } from '../type-mapper'
import { R_OK, W_OK } from 'constants'

export * from './logs'

// -----------------
// FileSystem
// -----------------

/**
 * Ensures that the given directory exists by creating it recursively when necessary.
 * It also removes all existing files from the directory (non-recursively).
 *
 * @throws Error if the path already exists and is not a directory
 * @category utils
 * @private
 */
export async function prepareTargetDir(dir: PathLike) {
  await ensureDir(dir)
  await cleanDir(dir)
}

async function ensureDir(dir: PathLike) {
  if (!(await canAccess(dir))) {
    await fs.mkdir(dir, { recursive: true })
    return
  }
  // dir already exists, make sure it isn't a file
  const stat = await fs.stat(dir)
  if (!stat.isDirectory()) {
    throw new Error(`'${dir}' is not a directory`)
  }
}

async function cleanDir(dir: PathLike) {
  const files = await fs.readdir(dir)
  const unlinks = files.map((filename) =>
    fs.unlink(path.join(dir.toString(), filename))
  )
  return Promise.all(unlinks)
}

export async function canAccess(p: PathLike, mode: number = R_OK | W_OK) {
  try {
    await fs.access(p, mode)
    return true
  } catch (_) {
    return false
  }
}

/**
 * Ensures that a file or directory is accessible to the current user.
 * @private
 */
export function canAccessSync(p: PathLike, mode: number = R_OK | W_OK) {
  try {
    accessSync(p, mode)
    return true
  } catch (_) {
    return false
  }
}

export function withoutTsExtension(p: string) {
  return p.replace(/\.ts$/, '')
}

export async function removeFileIfExists(file: string) {
  try {
    await fs.access(file)
  } catch (_) {
    return false
  }
  await fs.rm(file)
  return true
}

export function prependGeneratedWarning(code: string) {
  return `
/**
 * This code was GENERATED using the solita package.
 * Please DO NOT EDIT THIS FILE, instead rerun solita to update it or write a wrapper to add functionality.
 *
 * See: https://github.com/metaplex-foundation/solita 
 */

${code}
`.trim()
}

export class UnreachableCaseError extends Error {
  constructor(value: never) {
    super(`Unreachable case: ${value}`)
  }
}

// -----------------
// Discriminators
// -----------------

/**
 * Number of bytes of the account discriminator.
 */
export const ACCOUNT_DISCRIMINATOR_SIZE = 8

/**
 * Calculates and returns a unique 8 byte discriminator prepended to all
 * accounts.
 *
 * @param name The name of the account to calculate the discriminator.
 */
export function accountDiscriminator(name: string): Buffer {
  return Buffer.from(
    sha256.digest(`account:${camelcase(name, { pascalCase: true })}`)
  ).slice(0, ACCOUNT_DISCRIMINATOR_SIZE)
}

/**
 * Namespace for global instruction function signatures (i.e. functions
 * that aren't namespaced by the state or any of its trait implementations).
 */
export const SIGHASH_GLOBAL_NAMESPACE = 'global'

/**
 * Calculates and returns a unique 8 byte discriminator prepended to all instruction data.
 *
 * @param name The name of the instruction to calculate the discriminator.
 */
export function instructionDiscriminator(name: string): Buffer {
  return sighash(SIGHASH_GLOBAL_NAMESPACE, name)
}

function sighash(nameSpace: string, ixName: string): Buffer {
  let name = snakeCase(ixName)
  let preimage = `${nameSpace}:${name}`
  return Buffer.from(sha256.digest(preimage)).slice(0, 8)
}

export function anchorDiscriminatorField(name: string) {
  const ty: IdlTypeArray = { array: ['u8', 8] }
  return { name, type: ty }
}

export function anchorDiscriminatorType(
  typeMapper: TypeMapper,
  context: string
) {
  const ty: IdlTypeArray = { array: ['u8', 8] }
  return typeMapper.map(ty, context)
}

// -----------------
// Maps
// -----------------
export function getOrCreate<K, V>(map: Map<K, V>, key: K, initial: V): V {
  const current = map.get(key)
  if (current != null) return current
  map.set(key, initial)
  return initial
}

export function genericsToTokens(typeName: string, _generics: string[]) {
  const generics = _generics.length ? `<${_generics.join(', ')}>` : ''
  const genericsDefaults = _generics.length
    ? `<${_generics.map((a) => `${a} = any`).join(', ')}>`
    : ''
  const enumRecordName = `${typeName}Record${generics}`
  const typeNameWithGenerics = `${typeName}${generics}`
  return {
    typeNameWithGenerics,
    enumRecordName,
    genericsDefaults,
    generics,
    renderBeetExport: (beetVarName: string) =>
      'export const ' +
      (generics.length
        ? `${beetVarName}Factory = ${generics}(
  ${_generics.map((a) => `${a}: beet.FixableBeet<${a}> | FixedSizeBeet<${a}>`).join(',\n  ')}
) =>`
        : `${beetVarName} = `),
  }
}
