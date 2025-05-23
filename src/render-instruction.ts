import { BEET_PACKAGE } from '@metaplex-foundation/beet'
import { PathLike } from 'fs'
import { InstructionDiscriminator } from './instruction-discriminator'
import {
  isKnownPubkey,
  renderKnownPubkeyAccess,
  ResolvedKnownPubkey,
  resolveKnownPubkey,
} from './known-pubkeys'
import { renderScalarEnums } from './render-enums'
import { renderDataStruct } from './serdes'
import { ForceFixable, TypeMapper } from './type-mapper'
import {
  IdlInstruction,
  IdlInstructionAccount,
  IdlInstructionArg,
  isAccountsCollection,
  isIdlInstructionAccountWithDesc,
  PrimitiveTypeKey,
  SOLANA_SPL_TOKEN_EXPORT_NAME,
  SOLANA_SPL_TOKEN_PACKAGE,
  SOLANA_WEB3_EXPORT_NAME,
  SOLANA_WEB3_PACKAGE,
  TypeMappedSerdeField,
} from './types'

type ProcessedAccountKey = IdlInstructionAccount & {
  knownPubkey?: ResolvedKnownPubkey
  optional: boolean
}

class InstructionRenderer {
  readonly upperCamelIxName: string
  readonly camelIxName: string
  readonly argsTypename: string
  readonly accountsTypename: string
  readonly instructionDiscriminatorName: string
  readonly structArgName: string
  private readonly defaultOptionalAccounts: boolean
  private readonly instructionDiscriminator: InstructionDiscriminator
  private readonly programIdPubkey: string

  constructor(
    readonly ix: IdlInstruction,
    readonly fullFileDir: PathLike,
    readonly programId: string,
    private readonly typeMapper: TypeMapper,
    private readonly renderAnchorRemainingAccounts: boolean
  ) {
    this.upperCamelIxName = ix.name
      .charAt(0)
      .toUpperCase()
      .concat(ix.name.slice(1))

    this.camelIxName = ix.name.charAt(0).toLowerCase().concat(ix.name.slice(1))

    this.argsTypename = `${this.upperCamelIxName}InstructionArgs`
    this.accountsTypename = `${this.upperCamelIxName}InstructionAccounts`
    this.instructionDiscriminatorName = `${this.camelIxName}InstructionDiscriminator`
    this.structArgName = `${ix.name}Struct`

    this.instructionDiscriminator = new InstructionDiscriminator(
      ix,
      'instructionDiscriminator',
      typeMapper
    )
    this.programIdPubkey = `new ${SOLANA_WEB3_EXPORT_NAME}.PublicKey('${this.programId}')`
    this.defaultOptionalAccounts = !ix.legacyOptionalAccountsStrategy
  }

  // -----------------
  // Instruction Args Type
  // -----------------
  private renderIxArgField = (arg: IdlInstructionArg) => {
    const typescriptType = this.typeMapper.map(arg.type, arg.name)
    return `${arg.name}: ${typescriptType}`
  }

  private renderIxArgsType() {
    if (this.ix.args.length === 0) return ''
    const fields = this.ix.args
      .map((field) => this.renderIxArgField(field))
      .join(',\n  ')

    const code = `
/**
 * @category Instructions
 * @category ${this.upperCamelIxName}
 * @category generated
 */
export type ${this.argsTypename} = {
  ${fields}
}`.trim()
    return code
  }

  // -----------------
  // Imports
  // -----------------
  private renderImports(processedKeys: ProcessedAccountKey[]) {
    const typeMapperImports = this.typeMapper.importsUsed(
      this.fullFileDir.toString(),
      new Set([SOLANA_WEB3_PACKAGE, BEET_PACKAGE])
    )
    const needsSplToken = processedKeys.some(
      (x) => x.knownPubkey?.pack === SOLANA_SPL_TOKEN_PACKAGE
    )
    const splToken = needsSplToken
      ? `\nimport * as ${SOLANA_SPL_TOKEN_EXPORT_NAME} from '${SOLANA_SPL_TOKEN_PACKAGE}';`
      : ''

    return `
${splToken}
${typeMapperImports.join('\n')}`.trim()
  }

  // -----------------
  // Accounts
  // -----------------
  private processIxAccounts(): ProcessedAccountKey[] {
    let processedAccountsKey: ProcessedAccountKey[] = []
    for (const acc of this.ix.accounts) {
      if (isAccountsCollection(acc)) {
        for (const ac of acc.accounts) {
          // Make collection items easy to identify and avoid name clashes
          ac.name = deriveCollectionAccountsName(ac.name, acc.name)
          const knownPubkey = resolveKnownPubkey(ac.name)
          const optional = ac.optional ?? false
          if (knownPubkey == null) {
            processedAccountsKey.push({ ...ac, optional })
          } else {
            processedAccountsKey.push({ ...ac, knownPubkey, optional })
          }
        }
      } else {
        const knownPubkey = resolveKnownPubkey(acc.name)
        const optional = acc.optional ?? false
        if (knownPubkey == null) {
          processedAccountsKey.push({ ...acc, optional })
        } else {
          processedAccountsKey.push({ ...acc, knownPubkey, optional })
        }
      }
    }
    return processedAccountsKey
  }

  // -----------------
  // AccountKeys
  // -----------------

  /*
   * Main entry to render account metadata for provided account keys.
   * The `defaultOptionalAccounts` strategy determines how optional accounts
   * are rendered.
   *
   * a) If the defaultOptionalAccounts strategy is set all accounts will be
   *    added to the accounts array, but default to the program id when they weren't
   *    provided by the user.
   *
   * b) If the defaultOptionalAccounts strategy is not enabled optional accounts
   *    that are not provided will be omitted from the accounts array.
   *
   * @private
   */
  private renderIxAccountKeys(processedKeys: ProcessedAccountKey[]) {
    const fixedAccountKeys = this.defaultOptionalAccounts
      ? this.renderAccountKeysDefaultingOptionals(processedKeys)
      : this.renderAccountKeysNotDefaultingOptionals(processedKeys)

    const anchorRemainingAccounts =
      this.renderAnchorRemainingAccounts && processedKeys.length > 0
        ? `
  if (accounts.anchorRemainingAccounts != null) {
    for (const acc of accounts.anchorRemainingAccounts) {
      keys.push(acc)
    }
  }
`
        : ''

    return `${fixedAccountKeys}\n${anchorRemainingAccounts}\n`
  }

  // -----------------
  // AccountKeys: with strategy to not defaultOptionalAccounts
  // -----------------
  private renderAccountKeysNotDefaultingOptionals(
    processedKeys: ProcessedAccountKey[]
  ) {
    const indexOfFirstOptional = processedKeys.findIndex((x) => x.optional)
    if (indexOfFirstOptional === -1) {
      return this.renderAccountKeysInsideArray(processedKeys) + '\n'
    }

    const accountsInsideArray = this.renderAccountKeysInsideArray(
      processedKeys.slice(0, indexOfFirstOptional)
    )
    const accountsToPush = this.renderAccountKeysToPush(
      processedKeys.slice(indexOfFirstOptional)
    )

    return `${accountsInsideArray}\n${accountsToPush}`
  }

  private renderAccountKeysInsideArray(processedKeys: ProcessedAccountKey[]) {
    const metaElements = processedKeys
      .map((processedKey) =>
        renderRequiredAccountMeta(processedKey, this.programIdPubkey)
      )
      .join(',\n    ')
    return `[\n    ${metaElements}\n  ]`
  }

  private renderAccountKeysToPush(processedKeys: ProcessedAccountKey[]) {
    if (processedKeys.length === 0) {
      return ''
    }

    const statements = processedKeys
      .map((processedKey, idx) => {
        if (!processedKey.optional) {
          const accountMeta = renderRequiredAccountMeta(
            processedKey,
            this.programIdPubkey
          )
          return `keys.push(${accountMeta})`
        }

        const requiredOptionals = processedKeys
          .slice(0, idx)
          .filter((x) => x.optional)
        const requiredChecks = requiredOptionals
          .map((x) => `accounts.${x.name} == null`)
          .join(' || ')
        const checkRequireds =
          requiredChecks.length > 0
            ? `if (${requiredChecks}) { throw new Error('When providing \\'${processedKey.name}\\' then ` +
              `${requiredOptionals
                .map((x) => `\\'accounts.${x.name}\\'`)
                .join(', ')} need(s) to be provided as well.') }`
            : ''
        const pubkey = `accounts.${processedKey.name}`
        const accountMeta = renderAccountMeta(
          pubkey,
          (processedKey.writable ?? false).toString(),
          (processedKey.signer ?? false).toString()
        )

        // renderRequiredAccountMeta
        // NOTE: we purposely don't add the default resolution here since the intent is to
        // only pass that account when it is provided
        return `
if (accounts.${processedKey.name} != null) {
  ${checkRequireds}
  keys.push(${accountMeta})
}`.trim()
      })
      .join('\n')

    return `\n${statements}\n`
  }

  // -----------------
  // AccountKeys: with strategy to defaultOptionalAccounts
  // -----------------

  /*
   * This renders optional accounts when the defaultOptionalAccounts strategy is
   * enabled.
   * This means that all accounts will be added to the accounts array, but default
   * to the program id when they weren't provided by the user.
   * @category private
   */
  private renderAccountKeysDefaultingOptionals(
    processedKeys: ProcessedAccountKey[]
  ) {
    const metaElements = processedKeys
      .map((processedKey) => {
        return processedKey.optional
          ? renderOptionalAccountMetaDefaultingToProgramId(processedKey)
          : renderRequiredAccountMeta(processedKey, this.programIdPubkey)
      })
      .join(',\n    ')
    return `[\n    ${metaElements}\n  ]`
  }

  // -----------------
  // AccountsType
  // -----------------

  private renderAccountsType(processedKeys: ProcessedAccountKey[]) {
    if (processedKeys.length === 0) return ''
    const web3 = SOLANA_WEB3_EXPORT_NAME
    const fields = processedKeys
      .map((x) => {
        if (x.knownPubkey != null) {
          return `${x.name}?: ${web3}.PublicKey`
        }
        const optional = x.optional ? '?' : ''
        return `${x.name}${optional}: ${web3}.PublicKey`
      })
      .join('\n  ')

    const anchorRemainingAccounts = this.renderAnchorRemainingAccounts
      ? 'anchorRemainingAccounts?: web3.AccountMeta[]'
      : ''

    const propertyComments = processedKeys
      // known pubkeys are not provided by the user and thus aren't part of the type
      .filter((x) => !isKnownPubkey(x.name))
      .map((x) => {
        const attrs = []
        if (x.writable) attrs.push('_writable_')
        if (x.signer) attrs.push('**signer**')

        const optional = x.optional ? ' (optional) ' : ' '
        const desc = isIdlInstructionAccountWithDesc(x) ? x.desc : ''
        return (
          `* @property [${attrs.join(', ')}] ` + `${x.name}${optional}${desc} `
        )
      })

    const properties =
      propertyComments.length > 0
        ? `\n *\n  ${propertyComments.join('\n')} `
        : ''

    const docs = `
/**
  * Accounts required by the _${this.ix.name}_ instruction${properties}
  * @category Instructions
  * @category ${this.upperCamelIxName}
  * @category generated
  */
`.trim()
    return `${docs}
          export type ${this.accountsTypename} = {
  ${fields}
  ${anchorRemainingAccounts}
        }
        `
  }

  private renderAccountsParamDoc(processedKeys: ProcessedAccountKey[]) {
    if (processedKeys.length === 0) return '  *'
    return `  *
  * @param accounts that will be accessed while the instruction is processed`
  }

  private renderAccountsArg(processedKeys: ProcessedAccountKey[]) {
    if (processedKeys.length === 0) return ''
    return `accounts: ${this.accountsTypename}, \n`
  }

  // -----------------
  // Data Struct
  // -----------------
  private serdeProcess() {
    return this.typeMapper.mapSerdeFields(this.ix.args)
  }

  private renderDataStruct(args: TypeMappedSerdeField[]) {
    const discriminatorField = this.typeMapper.mapSerdeField(
      this.instructionDiscriminator.getField()
    )
    const discriminatorType = this.instructionDiscriminator.renderType()
    const struct = renderDataStruct({
      fields: args,
      discriminatorName: 'instructionDiscriminator',
      discriminatorField,
      discriminatorType,
      structVarName: this.structArgName,
      argsTypename: this.argsTypename,
      isFixable: this.typeMapper.usedFixableSerde,
    })
    return `
/**
 * @category Instructions
 * @category ${this.upperCamelIxName}
 * @category generated
 */
${struct} `.trim()
  }

  render() {
    this.typeMapper.clearUsages()

    const ixArgType = this.renderIxArgsType()
    const processedKeys = this.processIxAccounts()
    const accountsType = this.renderAccountsType(processedKeys)

    const processedArgs = this.serdeProcess()
    const argsStructType = this.renderDataStruct(processedArgs)

    const keys = this.renderIxAccountKeys(processedKeys)
    const accountsParamDoc = this.renderAccountsParamDoc(processedKeys)
    const accountsArg = this.renderAccountsArg(processedKeys)
    const instructionDisc = this.instructionDiscriminator.renderValue()
    const enums = renderScalarEnums(this.typeMapper.scalarEnumsUsed).join('\n')

    const web3 = SOLANA_WEB3_EXPORT_NAME
    const imports = this.renderImports(processedKeys)

    const [
      createInstructionArgsComment,
      createInstructionArgs,
      createInstructionArgsSpread,
      comma,
    ] =
      this.ix.args.length === 0
        ? ['', '', '', '']
        : [
            `\n * @param args to provide as instruction data to the program\n * `,
            `args: ${this.argsTypename} `,
            '...args',
            ', ',
          ]
    const programIdArg = `${comma}programId = ${this.programIdPubkey}`

    const optionalAccountsComment = optionalAccountsStrategyDocComment(
      this.defaultOptionalAccounts,
      processedKeys.some((x) => x.optional)
    )
    return `${imports}

${enums}
${ixArgType}
${argsStructType}
${accountsType}
    export const ${this.instructionDiscriminatorName} = ${instructionDisc};

    /**
     * Creates a _${this.upperCamelIxName}_ instruction.
    ${optionalAccountsComment}${accountsParamDoc}${createInstructionArgsComment}
     * @category Instructions
     * @category ${this.upperCamelIxName}
     * @category generated
     */
    export function create${this.upperCamelIxName}Instruction(
      ${accountsArg}${createInstructionArgs}${programIdArg}
    ) {
      const [data] = ${this.structArgName}.serialize({
        instructionDiscriminator: ${this.instructionDiscriminatorName},
    ${createInstructionArgsSpread}
    });
    const keys: ${web3}.AccountMeta[] = ${keys}
    const ix = new ${web3}.TransactionInstruction({
      programId,
      keys,
      data
  });
  return ix; 
}
`
  }
}

export function renderInstruction(
  ix: IdlInstruction,
  fullFileDir: PathLike,
  programId: string,
  accountFilesByType: Map<string, string>,
  customFilesByType: Map<string, string>,
  externalPackagesByType: Map<string, string>,
  typeAliases: Map<string, PrimitiveTypeKey>,
  forceFixable: ForceFixable,
  renderAnchorRemainingAccounts: boolean
) {
  const typeMapper = new TypeMapper(
    accountFilesByType,
    customFilesByType,
    externalPackagesByType,
    typeAliases,
    forceFixable
  )
  const renderer = new InstructionRenderer(
    ix,
    fullFileDir,
    programId,
    typeMapper,
    renderAnchorRemainingAccounts
  )
  return renderer.render()
}

// -----------------
// Utility Functions
// -----------------

function renderAccountMeta(
  pubkey: string,
  isWritable: string,
  isSigner: string
): string {
  return `{
      pubkey: ${pubkey},
      isWritable: ${isWritable},
      isSigner: ${isSigner},
    }`
}

function deriveCollectionAccountsName(
  accountName: string,
  collectionName: string
) {
  const camelAccount = accountName
    .charAt(0)
    .toUpperCase()
    .concat(accountName.slice(1))

  return `${collectionName}Item${camelAccount}`
}

function renderOptionalAccountMetaDefaultingToProgramId(
  processedKey: ProcessedAccountKey
): string {
  const { name, writable, signer } = processedKey
  const pubkey = `accounts.${name} ?? programId`
  const mut = writable ? `accounts.${name} != null` : 'false'
  const sign = signer ? `accounts.${name} != null` : 'false'
  return renderAccountMeta(pubkey, mut, sign)
}

function renderRequiredAccountMeta(
  processedKey: ProcessedAccountKey,
  programIdPubkey: string
): string {
  const { name, writable, signer, knownPubkey } = processedKey
  const pubkey =
    knownPubkey == null
      ? `accounts.${name}`
      : `accounts.${name} ?? ${renderKnownPubkeyAccess(
          knownPubkey,
          programIdPubkey
        )}`
  return renderAccountMeta(
    pubkey,
    (writable ?? false).toString(),
    (signer ?? false).toString()
  )
}

function optionalAccountsStrategyDocComment(
  defaultOptionalAccounts: boolean,
  someAccountIsOptional: boolean
) {
  if (!someAccountIsOptional) return ''

  if (defaultOptionalAccounts) {
    return ` * 
 * Optional accounts that are not provided default to the program ID since 
 * this was indicated in the IDL from which this instruction was generated.
`
  }
  return ` * 
 * Optional accounts that are not provided will be omitted from the accounts
 * array passed with the instruction.
 * An optional account that is set cannot follow an optional account that is unset.
 * Otherwise an Error is raised.
`
}
