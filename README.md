# AnimeVRM Motions

VRM 向けのポーズのモーション（Mixamo 形式の FBX）を配るサイトです。一覧から選ぶと、
[AnimeVRM engine](https://github.com/uemegu/AnimeVRM.engine) で描いたアオイがそのポーズで動きます。

プレビューの場所は学校の中庭です。上半身のポーズは正面のバストアップ、全身のポーズは体が収まる距離から撮ります（座り・寝そべりは少し上から）。
カメラはドラッグで回せます。回したあとは、ほかのポーズを選んでもその向きのままです。

FBX に入っているのは骨とモーションだけで、モデル（メッシュ・テクスチャ）は入っていません。骨の長さはアオイの体型に合わせてあります。

- どのモーションも 6 秒のループで、止まった姿勢に待機モーション（Standing Idle）の胴の動き（呼吸）を混ぜてあります。
- 「呼吸の強さ」で混ぜる割合を 0〜150% から選べます。0% は止まった姿勢、100% は待機モーションと同じ大きさです。
- 「FBX をダウンロード」を押すと、選んだ強さの FBX をブラウザの中で作って保存します。

## 手元で動かす

```bash
git clone --recurse-submodules https://github.com/uemegu/AnimeVRM.Motions.git
cd AnimeVRM.Motions
npm install
npm run dev
```

http://localhost:5194 を開きます。

## 公開

GitHub Pages（main ブランチの `docs/`）で https://uemegu.github.io/AnimeVRM.Motions/ に出しています。
サイトを直したら、`docs/` を作り直してコミットします。

```bash
npm run build:pages
```

共有したときの画像（OGP）は `public/ogp.jpg`（1200×630。上半身 P001 を選んだ画面）です。

## 呼吸の強さの変え方

`public/motions/*.fbx` は、1 フレーム目が呼吸のない姿勢で、以降のフレームは胴に待機モーションを強さ 0.8 で混ぜてあります。
ブラウザでは、各フレームの 1 フレーム目からの差（回転・移動）を「選んだ強さ ÷ 0.8」倍にして、
FBX の曲線の値だけを書き換えて保存します（`src/fbx/breath.ts`、FBX の読み書きは `src/fbx/binary.ts`）。
混ぜた後に腕は手首の位置を保つよう合わせ直してあるので、強さを大きく変えると手がわずかにずれます（150% で 0.03 cm ほど）。

## 腕の直し

手が体にめり込む・届かないなどは、`scripts/pose_edit.ts` で FBX の腕の曲線を書き換えて直します（呼吸の混ぜ方はそのまま残ります）。

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
