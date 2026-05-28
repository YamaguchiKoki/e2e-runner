# codex-e2e-runner

Cloudflare Workers などにホストされたプロダクトに対して、Codex CLI と
`playwright-cli` を使った定期 E2E (リグレッション検出) を回すための IaC とランナー。

## ステータス

ブレスト完了。設計書のみ。実装はこれから。

## 構成 (予定)

```
.
├── infra/           Hetzner Cloud VPS の terraform + cloud-init
├── Dockerfile       codex CLI + node + chromium + playwright-cli + gh
├── compose.yml      codex-e2e + ofelia (cron sidecar)
├── prompts/         Codex 用の実行プロンプト
├── lib/             parse-scenario / build-issue / resolve-repo (tsx)
├── scripts/         run-regression / propose-scenarios / validate
├── tests/           vitest (lib のテスト)
└── docs/specs/      設計書
```

## 設計書

[2026-05-28 設計書](./docs/specs/2026-05-28-codex-e2e-runner-design.md)

## 想定する使い方

1. このリポを clone
2. `infra/terraform.tfvars` を用意して `terraform apply` で VPS を立てる
3. SSH して `.env` を埋め、`codex login` してから `docker compose up -d`
4. 平日朝に対象プロダクトの stg 環境に対して E2E が回り、失敗時は対象リポに GitHub Issue が立つ
