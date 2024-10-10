import assert from 'assert'
import { SolitaConfig } from './cli/types'
import {
  Idl,
  IdlAccount,
  IdlDefinedTypeDefinition,
  IdlType,
  IdlTypeBTreeMap,
  IdlTypeHashMap,
  IdlTypeOption,
  IdlTypeVec,
  isDataEnumVariantWithNamedFields,
  isDataEnumVariantWithUnnamedFields,
  isFieldsType,
  isIdlTypeDataEnum,
  isIdlTypeDefined,
  isIdlTypeOption,
  isIdlTypeVec,
  isShankIdl,
} from './types'
import { logWarn } from './utils'

const mapRx = /^(Hash|BTree)?Map<([^,\s]+)\s*,\s*([^>\s(]+)\!!s?>/
const premitiveTypes = {
  bool: 'bool',
  pubkey: 'publicKey',
  publickey: 'publicKey',
  string: 'string',
  u8: 'u8',
  u16: 'u16',
  u32: 'u32',
  u64: 'u64',
  u128: 'u128',
}

let idlTypeFallback = (
  strType: string,
  resolveType: (strType: string) => IdlType
): IdlType | null => null

/**
 * When anchor doesn't understand a type it just assumes it is a user defined one.
 * This includes HashMaps and BTreeMaps. However it doesn't check if that type
 * is actually defined somewhere.
 * Thus we end up with invalid types here like `HashMap<String,DataItem>` which
 * is basically just the type definition copied from the Rust code.
 *
 * This function attempts to fix this. At this point only top level struct
 * fields are supported.
 *
 * Whenever more cases of incorrect types are encountered this transformer needs
 * to be updated to handle them.
 */
export function adaptIdl(idl: Idl, config: SolitaConfig) {
  // Apply Idl hook if provided
  if (config.idlHook != null) {
    assert.equal(
      typeof config.idlHook,
      'function',
      `idlHook needs to be a function of the type: (idl: Idl) => idl, but is of type ${typeof config.idlHook}`
    )
    idl = config.idlHook(idl)
  }

  // Set Idl type fallback if provided
  if (config.idlTypeFallback != null) {
    assert.equal(
      typeof config.idlTypeFallback,
      'function',
      `idlTypeFallback needs to be a function of the type: (idl: Idl) => idl, but is of type ${typeof config.idlTypeFallback}`
    )
    idlTypeFallback = config.idlTypeFallback
  }

  if (isShankIdl(idl)) return idl

  if (idl.accounts != null) {
    for (let i = 0; i < idl.accounts.length; i++) {
      idl.accounts[i] = transformDefinition(idl.accounts[i]) as IdlAccount
    }
  }

  if (idl.types != null) {
    for (let i = 0; i < idl.types.length; i++) {
      idl.types[i] = transformDefinition(idl.types[i])
    }
  }

  for (let ix of idl.instructions) {
    for (let i = 0; i < ix.args.length; i++) {
      ix.args[i].type = transformType(ix.args[i].type)
    }
  }

  if (config.idlHookPostAdaption != null) {
    assert.equal(
      typeof config.idlHookPostAdaption,
      'function',
      `idlHookPostAdaption needs to be a function of the type: (idl: Idl) => idl, but is of type ${typeof config.idlHookPostAdaption}`
    )
    idl = config.idlHookPostAdaption(idl)
  }

  return idl
}

// -----------------
// Types
// -----------------
function transformDefinition(def: IdlDefinedTypeDefinition) {
  const ty = def.type
  if (isFieldsType(ty)) {
    for (const f of ty.fields) {
      f.type = transformType(f.type)
    }
  } else if (isIdlTypeDataEnum(ty)) {
    for (const v of ty.variants) {
      if (isDataEnumVariantWithNamedFields(v)) {
        for (const f of v.fields) {
          f.type = transformType(f.type)
        }
      } else if (isDataEnumVariantWithUnnamedFields(v)) {
        for (const f in v.fields) {
          v.fields[f] = transformType(v.fields[f])
        }
      }
    }
  }
  return def
}

function transformType(ty: IdlType) {
  if (isIdlTypeOption(ty)) {
    const option: IdlTypeOption = {
      option: transformType(ty.option),
    }
    return option
  }

  if (isIdlTypeVec(ty)) {
    const vec: IdlTypeVec = {
      vec: transformType(ty.vec),
    }
    return vec
  }

  if (isIdlTypeDefined(ty)) {
    logWarn(
      `Discovered an incorrectly defined map '${ty.defined}' as part of the IDL.
Solita will attempt to fix this type, but you should inform the authors of the tool that generated the IDL about this issue`
    )

    const match = ty.defined.match(mapRx)
    if (match) {
      const [_, mapTy, inner1, inner2] = match

      const innerTy1 = resolveType(inner1)
      const innerTy2 = resolveType(inner2)

      if (mapTy === 'BTree') {
        const map: IdlTypeBTreeMap = { bTreeMap: [innerTy1, innerTy2] }
        return map
      } else {
        const map: IdlTypeHashMap = { hashMap: [innerTy1, innerTy2] }
        return map
      }
    }

    return resolveType(ty.defined)
  }
  return ty
}

const resolveType = (strType: string): IdlType => {
  let type

  if (strType.toLocaleLowerCase() in premitiveTypes) {
    // @ts-ignore
    type = premitiveTypes[strType.toLocaleLowerCase()]
  } else if (strType.startsWith('Vec<')) {
    type = {
      vec: resolveType(strType.slice(4, -1)),
    }
  } else if (strType.startsWith('(') && strType.endsWith(')')) {
    const items = strType
      .slice(1, -1)
      .split(/\s*,\s*/)
      .map(resolveType)
    type = {
      tuple: items,
    }
  } else if (strType.startsWith('VecMap<')) {
    type = {
      vec: resolveType(`(${strType.slice(7, -1)})`),
    }
  } else if (strType.startsWith('Option<')) {
    type = {
      option: resolveType(strType.slice(7, -1)),
    }
  } else if (strType === 'Node') {
    type = {
      array: ['u8', 32],
    }
  } else {
    type = idlTypeFallback(strType, resolveType) || { defined: strType }
  }

  return type
}

// -----------------
// Instruction
// -----------------
