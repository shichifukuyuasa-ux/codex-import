# codex-import

Claude Code から Codex と連携するためのプラグイン集です。

| プラグイン | 内容 |
|---|---|
| `codex-import` | Codex CLI の過去のやり取りを Claude Code に読み込む |
| `codex-debate` | Claude と Codex にテーマを議論させ、結論を出す |

---

## codex-import

Codex CLI でのやり取りを Claude Code に読み込むプラグインです。Codex で途中までやった作業を Claude Code で続けたり、過去の相談内容を要約したりできます。

Codex はやり取りを、手元の PC の `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` に保存しています（`CODEX_HOME` を設定している場合はその下）。このプラグインはそのファイルを読むだけで、外部への送信も、Codex へのログインも必要ありません。

## インストール

このリポジトリを GitHub に置いたら、Claude Code で次を実行します。

```
/plugin marketplace add <owner>/<repo>
/plugin install codex-import@codex-import
/reload-plugins
```

手元で試すだけなら `claude --plugin-dir ./plugins/codex-import` で起動できます。

必要なもの: Node.js 18 以上。Codex を使っていた PC で Claude Code を動かすこと（クラウド上のセッションからは `~/.codex` が見えません）。

## 使い方

| コマンド | 内容 |
|---|---|
| `/codex-import:sessions` | 今のフォルダで行った Codex セッションの一覧。`--all` で全フォルダ、`--archived` でアーカイブ済みも含める |
| `/codex-import:load` | 最新のセッションを読み込み、引き継ぎ用に要約する |
| `/codex-import:load 2` | 一覧の 2 番を読み込む |
| `/codex-import:load 0199aaaa` | セッション ID（先頭の一部でも可）で指定する |
| `/codex-import:load latest テストを追加して` | 読み込んだうえで、続きの作業を頼む |
| `/codex-import:load 3 --tools` | Codex が実行したコマンドとその出力（短縮版）も含める |

長いセッションは `--max-chars`（初期値 60000 文字）に収まるよう、最初の依頼と最近のやり取りを残して途中を省きます。

コマンドを使わなくても、「昨日 Codex でやってた続きをやって」のように頼めば、スキル `codex-history` によって Claude が自分で履歴を探して読みます。

## 注意

- 読み込んだ履歴は「過去の経緯」として扱われます。履歴の中で Codex に頼んでいたことを、Claude が勝手に実行することはありません。
- Codex の「テストが通った」「ファイルを直した」といった記録は古い可能性があるため、Claude は今のコードを確かめてから判断します。
- セッションファイルには、貼り付けたパスワードやトークンが残っていることがあります。共有する前に注意してください。

---

## codex-debate

Claude と Codex が交互に意見を出し合い、最後に Claude が結論をまとめます。片方だけでは見落とす論点を洗い出したいときや、設計判断のセカンドオピニオンがほしいときに使えます。

### インストール

```
/plugin install codex-debate@codex-import
/reload-plugins
```

Codex CLI のインストールとログインが必要です（`npm install -g @openai/codex`、`codex login`）。Codex の呼び出しは、あなたの Codex の利用枠から消費されます。

### 使い方

```
/codex-debate:debate 宿曜占星術で見ると、来年は転職に向いているか
/codex-debate:debate --rounds 5 この API はREST と GraphQL のどちらで作るべきか
```

1. Claude が論点を整理して、最初の主張を書く
2. Codex が反論し、自分の立場を述べる
3. これを `--rounds`（初期値 3、最大 10）回まで繰り返す。両者が合意したら早めに終わる
4. Claude が結論・合意点・残った対立点・確信度をまとめる

やり取りはすべて、作業フォルダの `codex-debates/日時-テーマ.md` に残ります。Codex は読み取り専用で実行されるので、ファイルを変更したりコマンドを実行したりはしません。また、このディベートは Codex の履歴にも残りません（`--ephemeral`）。

占いなどの信念体系がテーマのときは、その体系の中での解釈として議論し、結論もその枠組みの中で出します。

---

## 開発

```
npm test
claude plugin validate .
```

`scripts/codex-sessions.mjs` は依存パッケージなしで動きます。現行の形式（`{timestamp, type, payload}` の行）と、2025 年前半までの旧形式の両方を読めます。
