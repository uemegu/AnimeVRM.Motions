# AnimeVRM Motions

VRM 向けのポーズのモーション（Mixamo 形式の FBX）を配るサイトです。一覧から選ぶと、
[AnimeVRM engine](https://github.com/uemegu/AnimeVRM.engine) で描いたアオイがそのポーズで動きます。

プレビューの場所はアオイの部屋（順光の簡易3D）です。上半身のポーズは正面のバストアップ、全身のポーズは体が収まる距離から撮ります（座り・寝そべりは少し上から）。
座り・横座り・寝そべりのポーズは、幅 1.6 m × 長さ 2.6 m のベッドの上で見せます。寝そべりは頭を枕側へ向け、マットレスの高さに合わせて置きます。
カメラはドラッグで回せます。回したあとは、ほかのポーズを選んでもその向きのままです。

FBX に入っているのは骨とモーションだけで、モデル（メッシュ・テクスチャ）は入っていません。骨の長さはアオイの体型に合わせてあります。

- どのモーションも 6 秒のループで、止まった姿勢に胴の呼吸（吸って吐くを 2 回と、ゆっくりしたひねり）を付けてあります。
- 「呼吸の強さ」を 0〜150% から選べます。0% は止まった姿勢、100% が標準の大きさです。
- 「FBX をダウンロード」を押すと、選んだ強さの FBX をブラウザの中で作って保存します。

全身 P049・P052・P056・P058・P059 と座り系には、接地の補正を付けています。腰と胴の高さ・傾きを合わせ、膝・足先・支える手は IK で合わせ直します。プレビューとダウンロードには同じ補正を使い、FBX は床を基準にした座標で保存します。

全身 P041 は両手を腿に、P042 は両手を前のベッド面に、P044 は両手を後ろにつく姿勢として支持点を指定しています。P001・P002・P046・P047 は右手でベッドを支え、P048 は右手を腿に置きます。P041・P042・P044・P048 の膝は大腿・下腿の屈曲面を揃え、支える腕は胴の傾き・肘・前腕のねじれも合わせます。

## 手元で動かす

```bash
git clone --recurse-submodules https://github.com/uemegu/AnimeVRM.Motions.git
cd AnimeVRM.Motions
npm install
npm run dev
```

http://localhost:5194 を開きます。

`npm run check:contacts` で、この8姿勢の支持点・骨長・膝の屈曲面・手首のリグ設定範囲・呼吸中の固定と、保存する FBX の読み戻しを確認できます。実メッシュの接触はアオイとベッド上の表示でも確認します。

## 公開

GitHub Pages（main ブランチの `docs/`）で https://uemegu.github.io/AnimeVRM.Motions/ に出しています。
サイトを直したら、`docs/` を作り直してコミットします。

```bash
npm run build:pages
```

共有したときの画像（OGP）は `public/ogp.jpg`（1200×630。上半身 P001 を選んだ画面）です。

## 呼吸の付け方

`public/motions/*.fbx` は、全フレームが同じ止まった姿勢で、呼吸は入っていません。
ブラウザで、胴・首・鎖骨に式で作った呼吸を「選んだ強さ」倍で掛け、FBX の曲線の値だけを書き換えて保存します
（`src/fbx/breath.ts`、FBX の読み書きは `src/fbx/binary.ts`）。骨ごとの角度は `breath.ts` の `BREATH` で変えられます。
胴が動いても手首の位置と手の向きが変わらないよう、腕は IK で合わせ直します。腕がほぼ伸びきったポーズだけは届かず、手首が少し動きます（80% で最大 0.34 cm）。

motion-create の FBX には待機モーションから作った呼吸が入っているので、取り込むときに `scripts/strip_breath.ts` で抜きます
（`import_motions.py` が呼びます）。手で抜くときは次を実行します。

```bash
node scripts/strip_breath.ts public/motions
```

## 腕の直し

手が体にめり込む・届かないなどは、`scripts/pose_edit.ts` で FBX の腕の曲線を書き換えて直します。

```bash
node scripts/pose_edit.ts fixes.json
```

`fixes.json` は直しの一覧です。`public/motions/<id>.fbx` をその場で書き換えるので、同じ直しを二度当てないでください。

```json
[
  { "id": "upper_P010", "move": { "side": "Right", "effector": "HandIndex4", "offset": [-0.03, 0, 0] } },
  { "id": "full_P032", "mirror": { "from": "Left" } }
]
```

- `move`：1 フレーム目で `effector`（`Hand`・`HandIndex4` など）が `offset`（m。+x は左手側、+y は上、+z は正面）だけ動くよう、上腕を肩の周りに回します。
- `mirror`：反対の腕（肩から指先まで）を `from` の腕の鏡写しにします。

## モーションの追加

モーションは、絵から姿勢を推定して FBX にしたものです。追加するときは、FBX と一覧の情報、確認用の絵を取り込みます。

```bash
python scripts/import_motions.py <FBX のフォルダ（index.json がある所）> <変換の出力フォルダ>
```

- `public/motions/<id>.fbx`：モーション
- `public/thumbs/<id>.avif`：一覧の絵（変換の確認用に描いたアオイの姿勢を切り抜いたもの）
- `src/motions.json`：一覧（id・番号・名前・分類）

切り抜きに Pillow と numpy を使います。
