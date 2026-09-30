#!/usr/bin/env node
// Focused direct-edge guard. This does not attempt transitive dependency analysis.
const fs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')
const ts = require('typescript')
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const neutralModules = new Set([
  'agent-runtime',
  'runtime-directory',
  'session-worker-supervisor',
  'session-worker-pool',
  'session-worker-controller',
  'capability-broker',
  'foreground-capability-router',
  'background-session-service',
  'session-task-main-bridge',
  'session-task-orchestrator',
  'session-task-capability-broker'
])
const slash = (value) => value.split(path.sep).join('/')
const isTest = (file) =>
  /(?:^|\/)tests?\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
const optionsCache = new Map()
function compilerOptions(root) {
  if (!optionsCache.has(root)) {
    const options = []
    for (const name of ['tsconfig.node.json', 'tsconfig.web.json']) {
      const file = path.join(root, name)
      if (!fs.existsSync(file)) continue
      const config = ts.readConfigFile(file, ts.sys.readFile)
      if (config.error)
        throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
      options.push(ts.parseJsonConfigFileContent(config.config, ts.sys, root).options)
    }
    optionsCache.set(root, options)
  }
  return optionsCache.get(root)
}
function targets(specifier, file, root) {
  const resolved = new Set()
  if (specifier.startsWith('.')) resolved.add(path.resolve(path.dirname(file), specifier))
  for (const options of compilerOptions(root)) {
    const module = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule
    if (module) resolved.add(module.resolvedFileName)
    // Also check normalized alias targets even for a newly introduced file that
    // does not exist yet. Resolution alone would overlook this boundary edge.
    for (const [alias, replacements] of Object.entries(options.paths ?? {})) {
      const star = alias.indexOf('*')
      const match =
        star < 0
          ? specifier === alias
            ? ''
            : null
          : specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1))
            ? specifier.slice(star, specifier.length - (alias.length - star - 1))
            : null
      if (match === null) continue
      for (const replacement of replacements)
        resolved.add(path.resolve(options.baseUrl ?? root, replacement.replace('*', match)))
    }
  }
  return [...resolved].map((target) => slash(path.relative(root, target)))
}
function checkSource(filename, text, root = process.cwd()) {
  const relative = slash(path.relative(root, path.resolve(root, filename)))
  if (isTest(relative)) return []
  const file = path.resolve(root, filename)
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const errors = []
  const restricted = relative.startsWith('src/renderer/') || relative.startsWith('src/shared/')
  const neutral =
    relative.startsWith('src/main/') &&
    neutralModules.has(path.basename(relative, path.extname(relative)))
  function inspect(node) {
    const specifier = node.text
    const sdk = /^@(earendil-works|mariozechner)\/pi-[^/]+(?:\/|$)/.test(specifier) || specifier.startsWith('@anthropic-ai/claude-agent-sdk')
    const electron = specifier === 'electron' || specifier.startsWith('electron/')
    const nodeApi = specifier.startsWith('node:') || builtins.has(specifier)
    let reason
    if (restricted && (sdk || electron || nodeApi))
      reason = 'renderer/shared must not import Node, Electron or Pi SDK modules'
    else if (neutral && (sdk || electron))
      reason = 'neutral orchestration must not import Electron or Pi SDK modules'
    else if (relative.startsWith('src/main/') && sdk)
      reason = 'Main must use the AgentRuntime boundary instead of the Pi SDK'
    if (
      !reason &&
      restricted &&
      targets(specifier, file, root).some((target) =>
        /^src\/(main|agent-host|preload|terminal-host|plugin-host)(\/|$)/.test(target)
      )
    ) {
      reason = 'renderer/shared must not cross into another process implementation'
    }
    if (reason) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      errors.push(
        `${relative}:${position.line + 1}:${position.character + 1}: ${reason} (${specifier})`
      )
    }
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      inspect(node.moduleSpecifier)
    else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      inspect(node.arguments[0])
    else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    )
      inspect(node.argument.literal)
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    )
      inspect(node.moduleReference.expression)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return errors
}
function checkArchitecture(root) {
  const errors = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.[cm]?[jt]sx?$/.test(entry.name))
        errors.push(...checkSource(file, fs.readFileSync(file, 'utf8'), root))
    }
  }
  walk(path.join(root, 'src'))
  return errors
}
module.exports = { checkSource, checkArchitecture }
if (require.main === module) {
  const errors = checkArchitecture(path.resolve(__dirname, '..'))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log('Architecture direct-edge checks passed.')
}
