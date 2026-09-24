# 发布指南（RELEASING）

本仓库的发布由 Release Please 自动化：`.github/workflows/release.yml` + `.release-please-config.json` / `.release-please-manifest.json` 负责版本计算、Release PR、GitHub Release 与 tag；npm 发布由同 workflow 中独立的 `publish` job 在 Release 创建后执行，走 npm Trusted Publishing（OIDC），**不使用 npm token**。

## 基线：0.2.0

- npm 上已发布 `opencode-sweeper@0.2.0`。
- `.release-please-manifest.json` 记录 `".": "0.2.0"`，git tag `v0.2.0` 已存在。
- Release Please 以 `0.2.0` / `v0.2.0` commit 为基线，只统计该 tag 之后的提交；`bootstrap-sha`（`d3b5c6d`）仅用于初始化，后续发布不再依赖它。

## 版本与 bump 策略（0.x）

- `release-type: node`；tag 带 `v` 前缀（`include-v-in-tag: true`），形如 `v0.2.0`、`v0.3.0`，不包含组件名（`include-component-in-tag: false`）。
- 0.x 阶段：`feat` 触发 **minor** bump（`bump-minor-pre-major: true`），如 `0.2.0 → 0.3.0`。
- `fix` 触发 **patch** bump（`bump-patch-for-minor-pre-major: false`），如 `0.2.0 → 0.2.1`。
- `chore` / `docs` / `refactor` 等非 feat/fix 提交默认不触发新版本。

## 发布流程（正常路径）

1. 向 `main` 推送包含 conventional commits 的提交。workflow 只在 `github.ref == refs/heads/main && github.repository == jeffusion/opencode-sweeper` 时运行；`concurrency` 组 `release-please-main`（`cancel-in-progress: false`）保证同一时间只有一个 Release Please 运行。
2. `release-please` job 用 GitHub App token 运行 `googleapis/release-please-action@v4`：扫描自 `v0.2.0` 以来的提交，存在可发布提交时创建/更新 Release PR（分支名默认形如 `release-please--branches--main`），PR 内含 CHANGELOG.md（首次会生成该文件）、`package.json` version 与 manifest 的更新。
3. **人工审查并合并** Release PR——Release Please 只负责自动创建，合并必须人工完成。
4. 合并触发 workflow 再次运行：Release Please 检测到 Release PR 已合并，创建 `vX.Y.Z` tag 与 GitHub Release（`release_created == 'true'`）。
5. `publish` job 在 `release_created == 'true' && NPM_PUBLISH_ENABLED == 'true'` 同时成立时运行（仅 `main` 的 Release 触发路径），将包发布到 npm。

## 一次性前置配置

### GitHub App（Release Please 的 token 来源）

Release Please 不使用默认的 `GITHUB_TOKEN`，而是通过 GitHub App 生成的 token 操作仓库：

1. 在 GitHub 创建（或复用）一个 GitHub App。
2. 授予 **contents、issues、pull requests 的 write** 权限——与 workflow 中 `permission-contents/issues/pull-requests: write` 对应。
3. 将该 App **安装到目标仓库 `jeffusion/opencode-sweeper`**。
4. 在仓库 Settings → Secrets and variables 中手工设置：
   - `vars.RELEASE_APP_ID` = App ID
   - `secrets.RELEASE_APP_PRIVATE_KEY` = App 私钥

若这两项未配置，workflow 的 "Check GitHub App credentials" 步骤会直接报错并退出，Release Please 不会运行。

### npm Trusted Publishing（无 npm token）

npm 上已存在 `opencode-sweeper` 包，因此**必须先**在 npm 包页面配置 trusted publisher：

- owner：`jeffusion`
- repository：`opencode-sweeper`
- workflow 文件：`release.yml`（npm Trusted Publisher UI 中只填文件名，不含 `.github/workflows/` 路径）
- 发布访问方式：**直接发布（direct publish）**

`publish` job 通过 `actions/setup-node@v4` + `id-token: write` 以 OIDC 完成 npm 认证，全流程不使用 `NPM_TOKEN`。

### NPM_PUBLISH_ENABLED

- 在**合并首个 Release PR 之前**，手工在仓库设置中配置 `vars.NPM_PUBLISH_ENABLED = true`。
- 若保持为 `false`：合并 Release PR 仍会创建 GitHub Release 与 tag，但 `publish` job 会因条件不满足而跳过（job 状态为 skipped，并非失败）。之后**不能靠普通 `workflow_dispatch` 自动补发**：重跑时 `release_created` 已为 `false`（tag 已存在），`publish` 不会再自动触发。需要人工审定后按[排障](#排障)节的方式恢复发布。

## publish job 细节（排障参考）

`publish` job 在 Release tag（`needs.release-please.outputs.tag_name`）上执行：

- `oven-sh/setup-bun@v2` 安装 Bun 1.4.2，`bun install --frozen-lockfile`。
- 依次运行 typecheck、lint、test；默认 `bun test` 之后**额外执行 `bun test ./tests/sweep.cascade.ts`**（默认测试会漏掉 cascade 用例）。
- 构建前记录 `package.json`、`.release-please-manifest.json`、`bun.lock` 的 sha256，构建后校验一致性，确保 build 不修改发布元数据。
- 校验 Node ≥ 24 与 npm ≥ 11.5.1。
- `scripts/check-release.mjs` 三道校验：
  - `metadata`：tag 与 `package.json` version、manifest、仓库名、checkout 的 commit 与 tag commit 一致；
  - `registry`：向 `registry.npmjs.org` 请求包元数据，**必须 HTTP 200**（404 等非 200 一律报错）；校验响应中的 `name`、`versions`、`dist-tags.latest` 正常，目标版本未发布，且目标版本**严格高于最高已发布 stable 版本与 `latest`**（两者任一不高于即拒绝）；
  - `pack`：`npm pack --dry-run` 必须包含 `dist/index.js`、`dist/v2.js`、`dist/cli.js`、`server.js`。
- 最后 `npm publish --access public`。

## 排障

- **publish job 失败且版本未发布**：整轮重跑 Release Please 可能得到 `release_created=false`（Release/tag 已存在），从而不再触发 publish；切忌依赖整轮重跑。正确做法是优先在**原 workflow 中仅重跑失败的 `publish` job**（GitHub 的 re-run 可按 job 操作），它仍会在对应 `vX.Y.Z` tag 上执行全部校验后发布；前提是该版本确未被 npm 接受。若因 `NPM_PUBLISH_ENABLED=false` 导致 job 被跳过，则 job 从未真正失败、无法简单靠重跑或普通 `workflow_dispatch` 自动补发——需人工审定后恢复（开启开关并重新走发布，或经人工确认后在原 tag 上补发）。本仓库不提供本地复现 GitHub OIDC 发布的方式，恢复发布以 GitHub 原生 job 重跑为优先路径。
- **npm 版本不可变**：一旦某版本已发布到 registry，无法覆盖或删除重发；`check-release.mjs registry` 也会拒绝已发布的版本。后续修复只能随下一个版本发布。
- **GitHub App 凭证检查失败**：优先确认 `vars.RELEASE_APP_ID` / `secrets.RELEASE_APP_PRIVATE_KEY` 已设置、App 已安装到本仓库且权限含 contents/issues/pull-requests write。
- **Release PR 冲突**：在 PR 分支上解决冲突后推送，或关闭 PR 让 Release Please 在下次 main push 时重建。
