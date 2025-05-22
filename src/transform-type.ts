import assert from 'assert'
import { CustomTypeMapper, SolitaConfig } from './cli/types'
import {
  Idl,
  IdlAccount,
  IdlAccountType,
  IdlDefinedTypeDefinition,
  IdlType,
  IdlTypeBTreeMap,
  IdlTypeDefined,
  IdlTypeHashMap,
  IdlTypeOption,
  IdlTypeVec,
  isDataEnumVariantWithNamedFields,
  isDataEnumVariantWithUnnamedFields,
  isFieldsType,
  isIdlTypeDataEnum,
  isIdlTypeDefined,
  // isIdlTypeDefinedWithTypeArgs,
  isIdlTypeOption,
  isIdlTypeVec,
  isShankIdl,
} from './types'

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
  f64: {
    array: ['u8', 8],
  },
}

let idlTypeFallback = (
  strType: string,
  resolveType: (strType: string) => IdlType
): IdlType | null => null

const parseGenericType = (input: string) => {
  let result: { type: string; parameters: string[] } = {
    type: '',
    parameters: [],
  }
  let depth = 0,
    param = '',
    typeName = ''

  for (let char of input) {
    if (char === '<') {
      if (depth++ === 0) result.type = typeName.trim()
      else param += char
    } else if (char === '>') {
      if (--depth === 0) {
        result.parameters.push(param.trim())
        param = ''
      } else param += char
    } else if (char === ',' && depth === 1) {
      result.parameters.push(param.trim())
      param = ''
    } else if (depth > 0) param += char
    else typeName += char
  }

  return result
}

const mapMapper: CustomTypeMapper = (strType, resolveType) => {
  const parsed = parseGenericType(strType)
  if (parsed && parsed.type.endsWith('Map')) {
    const [inner1, inner2] = parsed.parameters

    const innerTy1 = resolveType(inner1)
    const innerTy2 = resolveType(inner2)

    if (parsed.type === 'BTreeMap') {
      const map: IdlTypeBTreeMap = { bTreeMap: [innerTy1, innerTy2] }
      return map
    } else if (parsed.type === 'VecMap') {
      return {
        vec: resolveType('(' + strType.slice(7, -1) + ')'), // Adjust slicing based on "VecMap"
      }
    } else {
      const map: IdlTypeHashMap = { hashMap: [innerTy1, innerTy2] }
      return map
    }
  }
  return null
}

const tuppleMapper: CustomTypeMapper = (strType, resolveType) => {
  if (strType.startsWith('(') && strType.endsWith(')')) {
    const items = strType
      .slice(1, -1)
      .split(/\s*,\s*/)
      .map(resolveType)
    return {
      tuple: items,
    }
  }
  return null
}

const vecMapper: CustomTypeMapper = (strType, resolveType) => {
  if (strType.startsWith('Vec<')) {
    return {
      vec: resolveType(strType.slice(4, -1)),
    }
  }
  return null
}

const optionMapper: CustomTypeMapper = (strType, resolveType) => {
  if (strType.startsWith('Option<')) {
    return {
      option: resolveType(strType.slice(7, -1)),
    }
  }
  return null
}

const nodeMapper: CustomTypeMapper = (strType, resolveType) => {
  if (strType === 'Node') {
    return {
      array: ['u8', 32],
    }
  }
  return null
}

const customTypeMappers: CustomTypeMapper[] = [
  mapMapper,
  vecMapper,
  tuppleMapper,
  optionMapper,
  nodeMapper,
]

const generatedTypes = new Map<string, IdlDefinedTypeDefinition>()

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

  if (config.customTypeMappers != null) {
    if (!Array.isArray(config.customTypeMappers))
      throw new Error(
        `customTypeMappers needs to be array of the type: (strType: string, resolveType: (strType: string) => IdlType, registerGeneratedType: (def: IdlDefinedTypeDefinition) => void) => IdlType | null, but is of type ${typeof config.customTypeMappers}`
      )

    config.customTypeMappers.forEach((mapper) => {
      assert.equal(
        typeof mapper,
        'function',
        `customTypeMappers items needs to be of the type: (strType: string, resolveType: (strType: string) => IdlType, registerGeneratedType: (def: IdlDefinedTypeDefinition) => void) => IdlType | null, but one of them is of type ${typeof mapper}`
      )
      customTypeMappers.push(mapper)
    })
  }

  // Set Idl type fallback if provided
  if (config.idlTypeFallback != null) {
    assert.equal(
      typeof config.idlTypeFallback,
      'function',
      `idlTypeFallback needs to be a function of the type: (strType: string, resolveType: (strType: string) => IdlType) => IdlType | null, but is of type ${typeof config.idlTypeFallback}`
    )
    idlTypeFallback = config.idlTypeFallback
  }

  if (isShankIdl(idl)) return idl

  const typeCache = new Map<string, IdlDefinedTypeDefinition>()

  if (idl.types != null) {
    for (let i = 0; i < idl.types.length; i++) {
      typeCache.set(idl.types[i].name, transformDefinition(idl.types[i]))
    }
  }

  if (idl.accounts != null) {
    for (let i = 0; i < idl.accounts.length; i++) {
      const accountType = typeCache.get(idl.accounts[i].name)
      typeCache.delete(idl.accounts[i].name)
      const account: IdlAccount = {
        name: idl.accounts[i].name,
        discriminator: idl.accounts[i].discriminator,
        type: accountType!.type as IdlAccountType,
      }
      idl.accounts[i] = account
    }
  }

  idl.types = Array.from(typeCache.values())

  for (let ix of idl.instructions) {
    ix.name = snakeToCamel(ix.name)
    for (let account of ix.accounts) {
      account.name = snakeToCamel(account.name)
    }
    for (let i = 0; i < ix.args.length; i++) {
      ix.args[i].name = snakeToCamel(ix.args[i].name)
      ix.args[i].type = transformType(ix.args[i].type)
    }
  }

  if (generatedTypes.size > 0) {
    if (idl.types == null) idl.types = []
    idl.types.push(...Array.from(generatedTypes.values()))
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
  if (def.name == 'Number') debugger
  const ty = def.type
  if (isFieldsType(ty)) {
    for (const f of ty.fields) {
      f.name = snakeToCamel(f.name)
      f.type = transformType(f.type)
    }
  } else if (isIdlTypeDataEnum(ty)) {
    for (const v of ty.variants) {
      if (isDataEnumVariantWithNamedFields(v)) {
        for (const f of v.fields) {
          f.name = snakeToCamel(f.name)
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

const snakeToCamel = (str: string) =>
  str
    .toLowerCase()
    .replace(/([-_][a-z0-9])/g, (group) =>
      group.toUpperCase().replace('-', '').replace('_', '')
    )

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
    const resolvedType = resolveType(ty.defined.name)

    if (isIdlTypeDefined(resolvedType) && ty.defined.generics?.length) {
      const mapped: IdlTypeDefined = {
        defined: {
          ...(resolvedType as IdlTypeDefined).defined,
          generics: ty.defined.generics?.map((t) => ({
            kind: 'type',
            type: transformType(t.type),
          })),
        },
      }
      return mapped
    }

    return resolvedType
  }
  if (typeof ty === 'string') {
    let k = ty.toLocaleLowerCase()
    if (k in premitiveTypes) {
      // @ts-ignore
      return premitiveTypes[k]
    }
  }
  return ty
}

const resolveType = (strType: string): IdlType => {
  if (strType.toLocaleLowerCase() in premitiveTypes) {
    // @ts-ignore
    return premitiveTypes[strType.toLocaleLowerCase()]
  }

  for (let mapper of customTypeMappers) {
    const type = mapper(strType, resolveType, (def) =>
      generatedTypes.set(def.name, def)
    )
    if (type) return type
  }

  return idlTypeFallback(strType, resolveType) || { defined: { name: strType } }
}

// -----------------
// Instruction
// -----------------
