//! PNG → ESC/POS raster for **Epson TM-m30III** (and compatible ESC/POS thermal printers).
//!
//! Pipeline: merged receipt HTML → PNG (client `html2canvas`) → this module → raw bytes for TCP :9100.
//! Note: **ZPL** is Zebra-specific; Epson uses **ESC/POS** (`GS v 0` bit image).

/// Printable width at ~203 dpi for 80 mm paper (~72 mm image area) ≈ 576 dots.
pub const ESCPOS_RECEIPT_WIDTH_DOTS: u32 = 576;

/// Convert a PNG (RGBA or grayscale) to ESC/POS init + centered raster + line feeds + full cut.
pub fn png_to_escpos_tm_raster(png_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png_bytes).map_err(|e| e.to_string())?;
    let img = img.into_rgba8();
    let (w0, h0) = img.dimensions();
    if w0 == 0 || h0 == 0 {
        return Err("empty image".to_string());
    }

    let target_w = ESCPOS_RECEIPT_WIDTH_DOTS.min(w0).max(1);
    let scale_h = ((h0 as f64) * (target_w as f64) / (w0 as f64))
        .round()
        .max(1.0) as u32;
    let img = image::imageops::resize(
        &img,
        target_w,
        scale_h,
        image::imageops::FilterType::Triangle,
    );

    let width = img.width() as usize;
    let height = img.height() as usize;
    let width_bytes = width.div_ceil(8);

    let mut rows: Vec<Vec<u8>> = Vec::with_capacity(height);
    for y in 0..height {
        let mut row = vec![0u8; width_bytes];
        for (xb, slot) in row.iter_mut().enumerate().take(width_bytes) {
            let mut byte = 0u8;
            for bit in 0..8usize {
                let x = xb * 8 + bit;
                let lum = if x < width {
                    let p = img.get_pixel(x as u32, y as u32);
                    let r = p[0] as u32;
                    let g = p[1] as u32;
                    let b = p[2] as u32;
                    (r * 299 + g * 587 + b * 114) / 1000
                } else {
                    255u32
                };
                if lum < 128 {
                    byte |= 1 << (7 - (bit as u8));
                }
            }
            *slot = byte;
        }
        rows.push(row);
    }

    let mut out = Vec::new();
    // ESC @ init
    out.extend_from_slice(&[0x1B, 0x40]);
    // Center alignment (logo / header)
    out.extend_from_slice(&[0x1B, 0x61, 0x01]);

    // GS v 0 — print raster bit image (x = width in bytes, y = height in dots)
    // Reference: ESC/POS GS v 48 (0x1D 0x76 0x30)
    let x = width_bytes;
    let y = height;
    if x > 0xFFFF || y > 0xFFFF {
        return Err("image too large for ESC/POS raster".to_string());
    }
    out.push(0x1D);
    out.push(0x76);
    out.push(0x30);
    out.push(0x00); // m = normal
    out.push((x & 0xFF) as u8);
    out.push(((x >> 8) & 0xFF) as u8);
    out.push((y & 0xFF) as u8);
    out.push(((y >> 8) & 0xFF) as u8);
    for row in rows {
        out.extend_from_slice(&row);
    }

    out.extend_from_slice(b"\n\n\n\n");
    // GS V A 0 — full cut (same family as existing `hardware.rs` text path)
    out.extend_from_slice(&[0x1D, 0x56, 0x41, 0x00]);

    Ok(out)
}
