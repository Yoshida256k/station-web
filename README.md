# ESPmono Clock Web

ESPmono 時計(ファーム: private リポジトリ `station`)の表示設定を、スマホから Web Bluetooth で変更するページです。

- 公開 URL: https://yoshida256k.github.io/station-web/
- 対応ブラウザ: Android の Chrome、PC の Chrome / Edge(iPhone は Bluefy 等が必要)
- ビルド不要の静的ファイルです。BLE の UUID は `app.js` の先頭にあり、ファームの `include/config.h` と一致させます。
- ローカル確認: `python -m http.server` → `http://localhost:8000/`(localhost は HTTPS なしでも Web Bluetooth が使えます)
