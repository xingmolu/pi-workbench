// The arm64 and x64 Mac builds run on separate runners and each write their own latest-mac.yml.
// electron-updater expects one file listing both, and picks the entry for its architecture.
//
//   node scripts/merge-mac-update-info.mjs latest-mac-arm64.yml latest-mac-x64.yml > latest-mac.yml
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'

const inputs = process.argv.slice(2).map((file) => yaml.load(readFileSync(file, 'utf8')))
if (!inputs.length) throw new Error('usage: merge-mac-update-info.mjs <latest-mac-*.yml>...')
const versions = new Set(inputs.map((info) => info.version))
if (versions.size !== 1) throw new Error(`versions differ: ${[...versions].join(', ')}`)

// Apple silicon first: the top-level path/sha512 are only read by very old updaters.
inputs.sort((a, b) => Number(b.path.includes('arm64')) - Number(a.path.includes('arm64')))
const files = []
for (const info of inputs)
  for (const file of info.files ?? [])
    if (!files.some((existing) => existing.url === file.url)) files.push(file)

process.stdout.write(yaml.dump({ ...inputs[0], files }, { lineWidth: -1 }))
