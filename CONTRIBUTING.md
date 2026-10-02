# 参与贡献 / Contributing

欢迎提 Issue 和 Pull Request。/ Issues and pull requests are welcome.

## 开发 / Development

需要 Node.js 22。/ Requires Node.js 22.

```bash
npm ci
npm run dev          # 开发模式 / development mode
npm run demo         # 离线演示，不需要账号 / offline demo, no account needed
```

实现细节、架构和测试方法见 [DEVELOPMENT.md](./DEVELOPMENT.md)；插件见 [PLUGINS.md](./PLUGINS.md)。
Architecture and testing notes: [DEVELOPMENT.md](./DEVELOPMENT.md); plugins: [PLUGINS.md](./PLUGINS.md).

## 提交前 / Before you send a change

```bash
npm run typecheck
npm run check:architecture
npm test
npm run test:e2e     # 涉及界面时 / for UI changes
```

- 一个 PR 做一件事，说明改了什么、为什么。/ One change per pull request, saying what and why.
- 界面改动最好附带端到端测试（`tests/e2e/`）。/ UI changes should come with an end-to-end test.
- 不要提交密钥、个人路径或真实账号数据；测试里用 example.com 之类的假数据。
  / Never commit keys, personal paths or real account data; use fake data such as example.com.

提交即表示你同意以 [MIT](./LICENSE) 许可发布你的贡献。
By contributing you agree that your contribution is released under the [MIT](./LICENSE) license.
