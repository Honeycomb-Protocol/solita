import path from 'path'
import { UnreachableCaseError } from '../utils'
import {
  isSolitaConfigAnchor,
  isSolitaConfigShank,
  SolitaConfig,
} from './types'

import { promises as fs } from 'fs'
import { adaptIdl } from '../transform-type'

export async function enhanceIdl(
  config: SolitaConfig,
  binaryVersion: string,
  libVersion: string
) {
  const { idlDir, programName } = config
  const idlPath = path.join(idlDir, `${programName}.json`)

  const idl = require(idlPath)

  if (isSolitaConfigAnchor(config)) {
    idl.metadata = {
      ...idl.metadata,
      address: config.programId,
      origin: config.idlGenerator,
      binaryVersion,
      libVersion,
    }
  } else if (isSolitaConfigShank(config)) {
    idl.metadata = {
      ...idl.metadata,
      binaryVersion,
      libVersion,
    }
  } else {
    throw new UnreachableCaseError(
      // @ts-ignore this possible is when types were violated via JS
      `Unknown IDL generator ${config.idlGenerator}`
    )
  }

  let finalIdl = adaptIdl(idl, config)

  await fs.writeFile(idlPath, JSON.stringify(finalIdl, null, 2))
  return finalIdl
}
