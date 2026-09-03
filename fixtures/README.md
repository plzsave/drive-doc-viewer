# HTML iframe テスト

`iframe-sample` フォルダを、フォルダ構造を保ったまま Google Drive へアップロードしてください。

```text
iframe-sample/
├── main.html
└── children/
    ├── child01.html
    ├── child02.html
    └── child02-assets/
        ├── diagram.svg
        ├── pattern.svg
        ├── style.css
        └── tokens.css
```

Drive Doc Viewer に `main.html` の共有URLを入力します。正常なら次を確認できます。

1. 親ページに「iframe表示テスト」と表示される
2. 左側に青い `child01.html` が表示される
3. 右側に緑色の `child02.html` が表示される
4. 右側の背景に薄い格子模様が表示される
5. 右側にSVGの処理フロー図が表示される

4はCSS内の `url()`、5はHTMLの相対画像、右側全体の装飾は外部CSSとCSS `@import` のテストです。

Mermaid は、同じ `fixtures` フォルダにある `mermaid-sample.md` を単独ファイルとしてDriveへアップロードして確認できます。
