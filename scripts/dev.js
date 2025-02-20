// @ts-check

// Using esbuild for faster dev builds.
// We are still using Rollup for production builds because it generates
// smaller files and provides better tree-shaking.

import esbuild from 'esbuild'
import fs from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'

// import.meta.url 是当前模块的URL，即file:///Vue3/scripts/dev.js
const require = createRequire(import.meta.url) // 创建一个require函数，用于动态解析CJS模块
const __dirname = dirname(fileURLToPath(import.meta.url)) // 获取当前脚本所在的目录，即/Vue3/scripts

const {
  values: { format: rawFormat, prod, inline: inlineDeps },
  positionals,
} = parseArgs({
  // 按照配置解析出命令行参数（process.argv...）
  allowPositionals: true,
  options: {
    format: {
      // 产物格式
      type: 'string',
      short: 'f',
      default: 'global',
    },
    prod: {
      // 是否为生产环境
      type: 'boolean',
      short: 'p',
      default: false,
    },
    inline: {
      // 是否内联依赖
      type: 'boolean',
      short: 'i',
      default: false,
    },
  },
})

const format = rawFormat || 'global'
const targets = positionals.length ? positionals : ['vue'] // 目标包，默认是vue

// resolve output
const outputFormat = format.startsWith('global')
  ? 'iife' // 产物格式为iife，即浏览器中
  : format === 'cjs'
    ? 'cjs' // 产物格式为cjs，即node中
    : 'esm' // 产物格式为esm

const postfix = format.endsWith('-runtime')
  ? `runtime.${format.replace(/-runtime$/, '')}`
  : format

const privatePackages = fs.readdirSync('packages-private') // 读取packages-private目录下的所有【文件/目录】信息

for (const target of targets) {
  const pkgBase = privatePackages.includes(target)
    ? `packages-private`
    : `packages`
  const pkgBasePath = `../${pkgBase}/${target}`
  // 动态解析pkgBasePath/package.json文件
  // 为什么不直接用esm模块解析？
  // 因为是不确定需要解析的模块位于哪个包中，所以需要动态解析，所以需要CJS的require
  const pkg = require(`${pkgBasePath}/package.json`)
  const outfile = resolve(
    __dirname,
    `${pkgBasePath}/dist/${
      target === 'vue-compat' ? `vue` : target
    }.${postfix}.${prod ? `prod.` : ``}js`,
  )
  //
  // process.cwd()node进程运行时所在的工作目录，对应/Vue3/
  // outfile是产物文件路径，对应/Vue3/packages/vue/dist/vue.global.js
  // relative(a, b)用来计算a到b的相对路径，所以这里会返回packages/vue/dist/vue.global.js
  const relativeOutfile = relative(process.cwd(), outfile)

  // resolve externals
  // TODO this logic is largely duplicated from rollup.config.js
  /** @type {string[]} */
  let external = []
  if (!inlineDeps) {
    // cjs & esm-bundler: external all deps
    if (format === 'cjs' || format.includes('esm-bundler')) {
      external = [
        ...external,
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
        // for @vue/compiler-sfc / server-renderer
        'path',
        'url',
        'stream',
      ]
    }

    if (target === 'compiler-sfc') {
      // require.resolve 动态解析【模块路径】
      const consolidatePkgPath = require.resolve(
        '@vue/consolidate/package.json',
        {
          paths: [resolve(__dirname, `../packages/${target}/`)], // 从哪里开始解析
        },
      )
      const consolidateDeps = Object.keys(
        require(consolidatePkgPath).devDependencies,
      )
      external = [
        ...external,
        ...consolidateDeps,
        'fs',
        'vm',
        'crypto',
        'react-dom/server',
        'teacup/lib/express',
        'arc-templates/dist/es5',
        'then-pug',
        'then-jade',
      ]
    }
  }
  /** @type {Array<import('esbuild').Plugin>} */
  const plugins = [
    {
      name: 'log-rebuild',
      setup(build) {
        build.onEnd(() => {
          console.log(`built: ${relativeOutfile}`)
        })
      },
    },
  ]

  if (format !== 'cjs' && pkg.buildOptions?.enableNonBrowserBranches) {
    plugins.push(polyfillNode())
  }

  esbuild
    .context({
      entryPoints: [resolve(__dirname, `${pkgBasePath}/src/index.ts`)],
      outfile,
      bundle: true,
      external,
      sourcemap: true,
      format: outputFormat,
      globalName: pkg.buildOptions?.name,
      platform: format === 'cjs' ? 'node' : 'browser',
      plugins,
      define: {
        __COMMIT__: `"dev"`,
        __VERSION__: `"${pkg.version}"`,
        __DEV__: prod ? `false` : `true`,
        __TEST__: `false`,
        __BROWSER__: String(
          format !== 'cjs' && !pkg.buildOptions?.enableNonBrowserBranches,
        ),
        __GLOBAL__: String(format === 'global'),
        __ESM_BUNDLER__: String(format.includes('esm-bundler')),
        __ESM_BROWSER__: String(format.includes('esm-browser')),
        __CJS__: String(format === 'cjs'),
        __SSR__: String(format !== 'global'),
        __COMPAT__: String(target === 'vue-compat'),
        __FEATURE_SUSPENSE__: `true`,
        __FEATURE_OPTIONS_API__: `true`,
        __FEATURE_PROD_DEVTOOLS__: `false`,
        __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__: `true`,
      },
    })
    .then(ctx => ctx.watch())
}
