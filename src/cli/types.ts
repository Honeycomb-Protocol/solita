import { RustbinConfig } from '@metaplex-foundation/rustbin'
import {
  Idl,
  IdlDefinedTypeDefinition,
  IdlType,
  Serializers,
  TypeAliases,
} from '../types'
export { RustbinConfig }

export type SolitaConfigBase = {
  programName: string
  idlDir: string
  sdkDir: string
  binaryInstallDir: string
  programDir: string
  idlHook?: (idl: Idl) => Idl
  idlHookPostAdaption?: (idl: Idl) => Idl
  customTypeMappers?: CustomTypeMapper[]
  idlTypeFallback?: IdlTypeFallback
  externalImports?: Record<string, string>
  rustbin?: RustbinConfig
  typeAliases?: TypeAliases
  serializers?: Serializers
  removeExistingIdl?: boolean
  binaryArgs?: string
  skipIdlBuildIfExists?: boolean
}

export type CustomTypeMapper = (
  strType: string,
  resolveType: (strType: string) => IdlType,
  registerGeneratedType: (def: IdlDefinedTypeDefinition) => void
) => IdlType | null

export type IdlTypeFallback = (
  strType: string,
  resolveType: (strType: string) => IdlType
) => IdlType | null

export type SolitaConfigAnchor = SolitaConfigBase & {
  idlGenerator: 'anchor'
  programId: string
  anchorRemainingAccounts?: boolean
}

export type SolitaConfigShank = SolitaConfigBase & {
  idlGenerator: 'shank'
}

export type SolitaConfig = SolitaConfigAnchor | SolitaConfigShank

export type SolitaHandlerResult = { exitCode: number; errorMsg?: string }

// -----------------
// Guards
// -----------------
export function isSolitaConfigAnchor(
  config: SolitaConfig
): config is SolitaConfigAnchor {
  return config.idlGenerator === 'anchor'
}

export function isSolitaConfigShank(
  config: SolitaConfig
): config is SolitaConfigShank {
  return config.idlGenerator === 'shank'
}

export function isErrorResult(
  result: SolitaHandlerResult
): result is SolitaHandlerResult & { errorMsg: string } {
  return result.errorMsg != null
}
