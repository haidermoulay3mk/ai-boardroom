// Encode f###.png frames into a small looping GIF.
// usage: node encode.mjs <framesDir> <out.gif> <delays.json> [width=1024]
// - downscales with a box filter (crisp text)
// - one global palette quantized from a sample of frames
// - frame differencing: unchanged pixels become transparent, so typing frames cost a few KB
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const [dir, out, delaysFile, widthArg] = process.argv.slice(2);
const delays = JSON.parse(readFileSync(delaysFile, 'utf8'));
const files = readdirSync(dir).filter(f => /^f\d+\.png$/.test(f)).sort().slice(0, delays.length);
if (files.length !== delays.length) throw new Error(`have ${files.length} frames for ${delays.length} delays`);
const W = Number(widthArg) || 1024;

function downscale(src, sw, sh, dw, dh) {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy;
    const y1 = Math.min(sh, y0 + fy);
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx;
      const x1 = Math.min(sw, x0 + fx);
      let r = 0, g = 0, b = 0, total = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const w = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * wy;
          const i = (yy * sw + xx) * 4;
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          total += w;
        }
      }
      const o = (y * dw + x) * 4;
      dst[o] = r / total;
      dst[o + 1] = g / total;
      dst[o + 2] = b / total;
      dst[o + 3] = 255;
    }
  }
  return dst;
}

const frames = files.map(f => {
  const png = PNG.sync.read(readFileSync(join(dir, f)));
  const H = Math.round((png.height * W) / png.width);
  return { rgba: downscale(png.data, png.width, png.height, W, H), H };
});
const H = frames[0].H;

// Global palette from every 4th frame (255 colours; index 255 is reserved for "unchanged").
const sample = frames.filter((_, i) => i % 4 === 0 || i === frames.length - 1);
const joined = new Uint8ClampedArray(sample.length * W * H * 4);
sample.forEach((f, i) => joined.set(f.rgba, i * W * H * 4));
const palette = quantize(joined, 255, { format: 'rgb565' });
while (palette.length < 255) palette.push([0, 0, 0]);
palette.push([255, 0, 255]); // 255 = transparent marker

const gif = GIFEncoder();
let prev = null;
let changed = 0;
frames.forEach((f, k) => {
  const index = applyPalette(f.rgba, palette.slice(0, 255), 'rgb565');
  if (!prev) {
    gif.writeFrame(index, W, H, { palette, delay: delays[k], repeat: 0 });
  } else {
    const diff = new Uint8Array(index.length);
    for (let i = 0; i < index.length; i++) {
      if (index[i] === prev[i]) diff[i] = 255;
      else {
        diff[i] = index[i];
        changed++;
      }
    }
    gif.writeFrame(diff, W, H, { delay: delays[k], transparent: true, transparentIndex: 255, dispose: 1 });
  }
  prev = index;
});
gif.finish();
const bytes = gif.bytes();
writeFileSync(out, bytes);
const seconds = delays.reduce((a, b) => a + b, 0) / 1000;
console.log(`${files.length} frames, ${W}x${H}, ${seconds.toFixed(1)}s loop, ${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${changed} changed px after frame 1`);
