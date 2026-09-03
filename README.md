# Drive Doc Viewer

Google Drive 上の Markdown / HTML ファイルを、URLを貼るだけで読みやすく表示する読み取り専用の Google Apps Script Web アプリです。

`md-collab` のような専用ワークスペースや管理フォルダは作りません。Web アプリはアクセス中のユーザーとして実行され、そのユーザーが Drive 上で閲覧できるファイルだけを開きます。

## 主な機能

- Google Drive の共有URL、またはファイルIDから `.md` / `.markdown` / `.html` / `.htm` を表示
- Markdown の GFM 表示、コードハイライト、Mermaid図、HTMLサニタイズ
- Markdown と同じフォルダにある相対パス画像を表示
- HTML の相対パス CSS・画像・フォントを表示
- `iframe src="children/child.html"` を再帰的に `srcdoc` へ変換して表示
- HTMLプレビューの高さをブラウザの表示領域へ追従
- ドキュメント表示中はURL入力欄を自動的に折りたたみ
- OS設定に追従し、手動選択を保存するライト／ダークモード
- ダークモードではMarkdown、コードハイライト、Mermaidを専用配色で再描画（HTMLは元の配色を維持）
- `?id=FILE_ID` で直接開けるURL
- 将来の Google Drive「アプリで開く」が渡す `state` パラメーターを受け入れ可能

## HTMLプレビューの安全境界

HTMLは文書表示用途を対象にしています。プレビューは sandbox iframe 内で実行し、次を無効化します。

- JavaScriptとイベントハンドラー
- フォーム送信
- `object` / `embed` / `applet`
- 外部iframe
- パッケージの親フォルダより外側を参照する `../`

選択したHTMLの親フォルダを、その閲覧中だけ「パッケージルート」として扱います。恒久的な管理フォルダではありません。フォルダ全体は走査せず、HTML/CSSから実際に参照されたファイルだけを取得します。

## セットアップ

このディレクトリで実行します。

```bash
bun install
bun run clasp:login
bun run clasp:create
bun run push
```

既存の Apps Script プロジェクトを利用する場合は、次のように設定します。

```bash
cp .clasp.json.example .clasp.json
# .clasp.json の scriptId を書き換える
bun run push
```

デプロイ設定は `static/appsscript.json` に次のように定義されています。

- 実行ユーザー: Webアプリにアクセスしているユーザー (`USER_ACCESSING`)
- アクセス: Googleにログインしているユーザー (`ANYONE`)
- OAuthスコープ: Drive読み取り専用

利用者は初回アクセス時にDrive読み取り権限を承認する必要があります。公開範囲や組織ポリシーによっては、Google Cloud側のOAuth同意画面設定も必要です。

## 開発

```bash
bun run check
bun run build
bun run push
```

ビルド成果物は `dist/` に出力されます。フロントエンドJavaScriptはGASの単一HTMLファイルへインライン化されます。

### iframe表示の確認

`fixtures/iframe-sample` をフォルダ構造ごとDriveへアップロードし、`main.html` の共有URLを開きます。期待する表示と確認項目は `fixtures/README.md` にあります。

## 現在の制限

- 1ファイルおよび関連ファイルは各4MBまで
- HTMLの関連ファイルは最大100件まで
- JavaScript、ES Modules、Service Worker、動的な `fetch()` は実行しない
- 同一フォルダ内に同名のファイルまたはフォルダが複数ある場合、その相対参照は解決しない
- Google Docs形式そのものは対象外。Driveに保存された通常ファイルとしての Markdown / HTML が対象

動作確認用として、`fixtures/iframe-sample/` と `fixtures/mermaid-sample.md` を収録しています。

## Google Drive「アプリで開く」への発展

Drive UI integration をGoogle Cloud側で設定すると、DriveはOpen URLへ `state` クエリを付けてファイルIDとresource keyを渡します。このアプリの `doGet` はその形式をすでに解釈します。

実際にDriveのメニューへ登録する段階では、Drive APIのUI integration、`drive.install` スコープ、OAuth同意画面、URL所有権確認、必要に応じてGoogle Workspace Marketplace公開を別途設定します。URL貼り付けによる利用にはこれらは不要です。
