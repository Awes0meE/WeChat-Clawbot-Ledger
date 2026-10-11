import { PhotonImage, crop } from '@silvia-odwyer/photon-node';

export function detailRegions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > 25_000_000) throw new Error('Invalid image dimensions');
  if (Math.max(width, height) < 64) return [];
  const landscape = width > height;
  const long = Math.max(width, height), short = Math.min(width, height);
  // A full-width strip still leaves small text tiny on broad receipt photos.
  // Split both axes there; narrow long receipts already benefit from strips.
  const across = long / short > 2.5 ? [[0, short]]
    : [0, 0.4].map(start => [Math.floor(short * start), Math.min(short, Math.ceil(short * (start + 0.6)))]);
  return [0, 0.3, 0.6].flatMap(start => across.map(([a, b]) => {
    const first = Math.floor(long * start), last = Math.min(long, Math.ceil(long * (start + 0.4)));
    return landscape ? [first, a, last, b] : [a, first, b, last];
  }));
}

// Generic overlapping details cover the entire image; no fixture-specific crops,
// OCR text substitution, disk files, or changes to the transport-owned original.
export async function imageReviewDetails(jpeg, resizeToJpeg) {
  const original = PhotonImage.new_from_byteslice(jpeg);
  const images = [jpeg];
  try {
    for (const [left, top, right, bottom] of detailRegions(original.get_width(), original.get_height())) {
      const piece = crop(original, left, top, right, bottom);
      try {
        images.push(await resizeToJpeg({ buffer: Buffer.from(piece.get_bytes_jpeg(95)),
          maxSide: 2048, withoutEnlargement: false, quality: 95 }));
      } finally { piece.free(); }
    }
    return images;
  } finally { original.free(); }
}
