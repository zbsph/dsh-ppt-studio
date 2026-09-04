#!/usr/bin/env node
/**
 * Build: copy src/ → lib/（免编译形态：源码即产物，纯 ESM JS）。
 * 依赖（yaml）从 node_modules 解析，构建时无需 tsc / DSH_CHECKOUT。
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'lib'), { recursive: true, force: true })
mkdirSync(join(root, 'lib'), { recursive: true })
cpSync(join(root, 'src'), join(root, 'lib'), { recursive: true })
console.log('build: src → lib copied')
