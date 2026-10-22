# Discover Articles

地図上に、近くの日本語版ウィキペディア記事をピンで表示するWebアプリ。
ビルド不要（HTML/CSS/JavaScriptのみ）。GitHub Pagesでそのまま公開できる。

## 使い方
- 「現在地」で現在地へ移動（位置は実行時に取得するだけで、保存しない）
- 「検索」で住所・地名を探し、候補を選ぶとその場所へ移動（国土地理院の住所検索API）
- 地図を動かすと、表示範囲の記事を自動で取得
- ピンをタップすると要約・サムネイル・記事へのリンクを表示
- 開いた記事は既読としてピンが灰色になる（記録はブラウザのlocalStorage）
- 「☆ 保存」でブックマーク。保存先リストは「設定」で事前に選ぶ。保存した記事は地図上で★になる（このアプリ内だけの記録で、端末のブラウザに保存）
- 「設定」から文字サイズ・ライト／ダーク・ブックマークのリスト・既読記録の消去

## アクセスの記録
公開ページでは、アクセスの日時・IPアドレス・おおよその地域・ブラウザの種類などを、自前の Cloudflare Worker に記録している。

## 公開ページ
https://lertroo.github.io/discover-articles/

## 使用しているもの
- [Leaflet](https://leafletjs.com/) / [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster)
- 地図：国土地理院タイル（淡色地図・標準地図・航空写真）、OpenStreetMap
- 記事データ：日本語版ウィキペディア GeoSearch API・REST API（CC BY-SA）
