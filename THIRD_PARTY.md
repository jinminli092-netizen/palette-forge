# Third-party components

Palette Forge has **no runtime dependencies**.

Everything it needs is either part of Node.js or part of the browser:

| Piece | Where it comes from |
|---|---|
| zlib (PNG deflate/inflate) | Node's built-in `node:zlib` / the browser |
| PNG encoding and decoding | Written here (`tools/png.mjs`) |
| 5×7 bitmap font for the strip image | Written here (`tools/png.mjs`) |
| sRGB → CIELAB conversion | Written here (`tools/color.mjs`) |
| CIEDE2000 colour difference | Written here (`tools/color.mjs`), checked against the published reference pairs |
| k-means clustering | Written here (`tools/engine.mjs`) |
| JPEG / WebP / video decoding | Optional, delegated to a local `ffmpeg` binary when present |

`ffmpeg` is not bundled and is not required for the browser edition or for PNG input.
If you install it yourself, its own licence applies — Palette Forge only calls the
executable and never links against it.

No picture is ever uploaded: the browser edition works entirely on `canvas` pixels,
and the command-line edition only reads local files.
