import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * 不写以 `packages` 开头的相对路径：那是相对**配置所在目录**解析的，
     * 而 `pnpm -r test` 会在每个包自己的目录里跑 vitest，
     * 于是它去找 packages/knowledge 底下再套一层 packages——一个文件都匹配不到，
     * 然后以"没有测试文件"退出码 1 收场。看起来像测试挂了，其实是根本没跑。
     */
    include: ['**/src/**/*.test.ts'],
    environment: 'node',
  },
});
