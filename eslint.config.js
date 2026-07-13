/**
 * ESLint Flat Config (ESLint 9+)
 * ============================================================================
 * 项目：VersePC - 纯 JavaScript + CommonJS
 *
 * 设计说明：
 * - no-empty 默认会报告空 catch 块（包括 catch(_) {}）。本项目把 catch(_) {}
 *   视为"故意忽略错误"的已知约定，因此用 allowEmptyCatch 关闭 no-empty 对
 *   catch 的检测，改用 no-restricted-syntax 精确报告"参数名不是 _ 的空
 *   catch 块"，从而既捕获潜在问题的空 catch，又不打扰 catch(_) {} 模式。
 * - 全部规则按需求设置为 warning 或 error，warning 不阻塞构建。
 */

module.exports = [
    {
        // 忽略的目录/文件
        ignores: [
            'node_modules/',
            'dist/',
            'js/three.bundle.js',
            'js/skinview3d.bundle.js',
            'js/marked.min.js',
            'js/mod-chinese-names.js',
            'js/mod-slug-map.js',
            'installer-app/',
            'xmcl-source/',
            'build-tools/',
            '.trae/'
        ]
    },
    {
        // 主配置：适用于所有项目 JS 文件
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                // Electron 主进程 / 渲染进程通用全局
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                setInterval: 'readonly',
                clearTimeout: 'readonly',
                clearInterval: 'readonly',
                queueMicrotask: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
                AbortController: 'readonly',
                // 浏览器/DOM 环境（渲染进程使用）
                window: 'readonly',
                document: 'readonly',
                localStorage: 'readonly',
                navigator: 'readonly',
                location: 'readonly',
                history: 'readonly',
                fetch: 'readonly',
                HTMLElement: 'readonly',
                Event: 'readonly',
                CustomEvent: 'readonly',
                FileReader: 'readonly',
                Blob: 'readonly',
                FormData: 'readonly',
                WebSocket: 'readonly',
                indexedDB: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                matchMedia: 'readonly',
                getComputedStyle: 'readonly',
                IntersectionObserver: 'readonly',
                MutationObserver: 'readonly',
                ResizeObserver: 'readonly',
                DOMParser: 'readonly',
                XMLSerializer: 'readonly',
                // Electron API
                electron: 'readonly',
                ipcRenderer: 'readonly',
                contextBridge: 'readonly'
            }
        },
        rules: {
            // 空块语句：关闭 catch 检测，交由 no-restricted-syntax 精确处理
            'no-empty': ['warn', { allowEmptyCatch: true, allowEmptyBlock: false }],

            // 精确报告"参数名不是 _ 的空 catch 块"
            // catch(_) {} 是本项目"故意忽略错误"的已知约定，不报告
            'no-restricted-syntax': [
                'warn',
                {
                    selector: "CatchClause[param!=null][param.name!='_'] > BlockStatement.body[body.length=0]",
                    message: '空的 catch 块必须忽略错误（使用 catch (_) {} 或添加处理逻辑）。'
                },
                {
                    selector: "CatchClause[param=null] > BlockStatement.body[body.length=0]",
                    message: '空的 catch 块必须忽略错误（使用 catch (_) {} 或添加处理逻辑）。'
                }
            ],

            // 未使用变量：warning，忽略 catch 参数后的变量
            'no-unused-vars': [
                'warn',
                {
                    args: 'after-used',
                    caughtErrors: 'after-used',
                    ignoreRestSiblings: true
                }
            ],

            // 未定义变量：error
            'no-undef': 'error',

            // 异步函数缺少 await：warning
            'require-await': 'warn',

            // 优先使用 const：warning
            'prefer-const': 'warn',

            // 禁止 var：error
            'no-var': 'error'
        }
    }
];
