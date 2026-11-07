# ESPmono 3D Lab (Web Bluetooth controller)

ESP32-S3 + 128x64 モノクロ液晶で動く 3D ワイヤーフレーム/シミュレーション映像(ファーム: private リポジトリ `station`)を、
スマホからリアルタイムに操作するページです。

- 公開 URL: https://yoshida256k.github.io/station-web/
- 対応ブラウザ: Android の Chrome、PC の Chrome / Edge(iPhone は Bluefy 等が必要)
- ビルド不要の静的ファイル(HTML/JS/CSS + 最小 PWA)

## できること
- 8 つのシーンの選択と自動切り替え間隔、スピード、シーンごとのパラメータ(ρ、波速、4D 視点距離 など)
- 「水滴を落とす」「やり直す」「次のシーン」ボタン
- **ライブ画面**: ESP32 の液晶そのものを BLE で差分圧縮して約 3 コマ/秒で表示
- バックライト(昼夜)、LCD コントラスト/反転、メッセージ
- **診断・復旧**: 液晶の再初期化、自動復旧テスト、今すぐ時刻合わせ、前回の再起動理由と起動回数(接触不良が電源側か液晶側かの切り分け用)

## 通信仕様
UUID・フォーマットは `app.js` の先頭とファームの `include/config.h` に同じものがあります(詳細はファーム側 README)。
Web Bluetooth は GATT 操作を 1 つずつしか受け付けないため、すべての操作を直列キューに通し、
スライダーは「最新値だけ送る」ライターで間引いています。

## ローカル確認
`python -m http.server` → `http://localhost:8000/`(localhost は HTTPS なしでも Web Bluetooth が使えます)
