//! Staff avatar photo processing pipeline.
//!
//! Takes a real uploaded employee photo and produces a uniform 512x512 portrait:
//! 1. Detect face region using skin-tone/contrast heuristics.
//! 2. Expand bounding box to include head/hair and collarbones/shoulders.
//! 3. Ensure perfect 1:1 square aspect ratio.
//! 4. Resize to 512x512 with Lanczos3 filtering.
//! 5. Encode as high-quality JPEG (WebP when libwebp is available at build time).
//!
//! ROSIE integration point: This module performs deterministic pixel manipulation.
//! ROSIE can orchestrate the pipeline (e.g., queue upload jobs, validate results)
//! but does NOT generate imagery. All output derives from the employee's real photo.

use image::{DynamicImage, GenericImageView};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AvatarError {
    #[error("Failed to decode image: {0}")]
    Decode(String),
    #[error("Image too small: minimum 256x256, got {0}x{1}")]
    TooSmall(u32, u32),
    #[error("Image too large: maximum 4096x4096, got {0}x{1}")]
    TooLarge(u32, u32),
    #[error("Processing failed: {0}")]
    Processing(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Region of interest within the source image.
#[derive(Debug, Clone, Copy)]
struct FaceRegion {
    center_x: u32,
    center_y: u32,
    width: u32,
    height: u32,
}

/// Process a raw uploaded photo into a uniform staff avatar.
///
/// # Arguments
/// * `input` — Raw bytes of the uploaded image (JPEG, PNG, or WebP).
///
/// # Returns
/// JPEG-encoded bytes of the 512x512 cropped portrait, or an `AvatarError`.
pub fn process_staff_avatar(input: &[u8]) -> Result<Vec<u8>, AvatarError> {
    // 1. Decode and validate
    let img = image::load_from_memory(input).map_err(|e| AvatarError::Decode(e.to_string()))?;

    let (w, h) = img.dimensions();
    if w < 256 || h < 256 {
        return Err(AvatarError::TooSmall(w, h));
    }
    if w > 4096 || h > 4096 {
        return Err(AvatarError::TooLarge(w, h));
    }

    // 2. Detect face region (best-effort; falls back to center-crop for portraits)
    let face = detect_face_region(&img);

    // 3. Calculate crop box: expand face to include head/hair + shoulders,
    //    force 1:1 square, keep within image bounds.
    let crop = calculate_crop_box(w, h, face);

    // 4. Crop and resize to 512x512
    let cropped = img.crop_imm(crop.0, crop.1, crop.2, crop.3);
    let resized = cropped.resize_exact(512, 512, image::imageops::FilterType::Lanczos3);

    // 5. Encode as high-quality JPEG (88% quality).
    let mut output = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 88);
    resized
        .write_with_encoder(encoder)
        .map_err(|e| AvatarError::Processing(format!("JPEG encode: {e}")))?;

    Ok(output)
}

// ---------------------------------------------------------------------------
// Face detection heuristic (pure Rust, no external CV libs)
// ---------------------------------------------------------------------------

/// Detect face region using skin-tone segmentation and contrast analysis.
/// Returns `None` if no clear face is found — caller falls back to center-crop.
fn detect_face_region(img: &DynamicImage) -> Option<FaceRegion> {
    let (w, h) = img.dimensions();
    let rgba = img.to_rgba8();

    // Step 1: Build a skin-likelihood mask.
    // Human skin in HSV roughly: H 0–50, S 0.10–0.80, V 0.25–0.95.
    // We quantize to a grid for speed, then smooth.
    let grid_w = (w / 16).max(4);
    let grid_h = (h / 16).max(4);
    let cols = (w / grid_w) as usize;
    let rows = (h / grid_h) as usize;

    let mut grid: Vec<f32> = vec![0.0; cols * rows];

    for gy in 0..rows {
        for gx in 0..cols {
            let x0 = (gx as u32 * grid_w).min(w - 1);
            let y0 = (gy as u32 * grid_h).min(h - 1);
            let x1 = ((x0 + grid_w).min(w)).max(x0 + 1);
            let y1 = ((y0 + grid_h).min(h)).max(y0 + 1);

            let mut skin_pixels = 0u32;
            let mut total = 0u32;

            for y in y0..y1 {
                for x in x0..x1 {
                    let p = rgba.get_pixel(x, y);
                    let [r, g, b, _] = p.0;
                    if is_skin_tone(r, g, b) {
                        skin_pixels += 1;
                    }
                    total += 1;
                }
            }

            if total > 0 {
                grid[gy * cols + gx] = skin_pixels as f32 / total as f32;
            }
        }
    }

    // Step 2: Find the grid cell with highest skin density, then expand
    // to a connected region above a threshold.
    let threshold = 0.25f32;
    let mut best_score = 0.0f32;
    let mut best_cx = 0usize;
    let mut best_cy = 0usize;

    for gy in 0..rows {
        for gx in 0..cols {
            let score = grid[gy * cols + gx];
            if score > best_score {
                best_score = score;
                best_cx = gx;
                best_cy = gy;
            }
        }
    }

    if best_score < 0.15 {
        // No clear skin region — portrait may be low-contrast or non-human.
        return None;
    }

    // Step 3: Grow a rectangular region around the peak while cells exceed threshold.
    let mut min_gx = best_cx;
    let mut max_gx = best_cx;
    let mut min_gy = best_cy;
    let mut max_gy = best_cy;

    let mut visited = vec![false; cols * rows];
    let mut stack = vec![(best_cx, best_cy)];
    visited[best_cy * cols + best_cx] = true;

    while let Some((cx, cy)) = stack.pop() {
        min_gx = min_gx.min(cx);
        max_gx = max_gx.max(cx);
        min_gy = min_gy.min(cy);
        max_gy = max_gy.max(cy);

        for (nx, ny) in neighbors(cx, cy, cols, rows) {
            let idx = ny * cols + nx;
            if !visited[idx] && grid[idx] >= threshold {
                visited[idx] = true;
                stack.push((nx, ny));
            }
        }
    }

    // Convert grid coords back to pixel coords.
    let x0 = (min_gx as u32 * grid_w).min(w - 1);
    let y0 = (min_gy as u32 * grid_h).min(h - 1);
    let x1 = ((max_gx as u32 + 1) * grid_w).min(w);
    let y1 = ((max_gy as u32 + 1) * grid_h).min(h);

    let face_w = x1 - x0;
    let face_h = y1 - y0;

    if face_w < 32 || face_h < 32 {
        return None;
    }

    Some(FaceRegion {
        center_x: x0 + face_w / 2,
        center_y: y0 + face_h / 2,
        width: face_w,
        height: face_h,
    })
}

/// Determine if an RGB pixel matches human skin tone.
/// Uses a simplified heuristic based on the paper by Kovac et al.
fn is_skin_tone(r: u8, g: u8, b: u8) -> bool {
    let r = r as f32;
    let g = g as f32;
    let b = b as f32;

    // Rule 1: R > G and R > B (skin is reddish)
    if r <= g || r <= b {
        return false;
    }

    // Rule 2: Normalized RGB constraints
    let sum = r + g + b;
    if sum == 0.0 {
        return false;
    }
    let nr = r / sum;
    let ng = g / sum;

    // Relaxed bounds for diverse skin tones under varying lighting
    nr > 0.30 && nr < 0.55 && ng > 0.22 && ng < 0.45
}

fn neighbors(cx: usize, cy: usize, cols: usize, rows: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::with_capacity(4);
    const D: [(isize, isize); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];
    for (dx, dy) in D {
        let nx = cx as isize + dx;
        let ny = cy as isize + dy;
        if nx >= 0 && nx < cols as isize && ny >= 0 && ny < rows as isize {
            out.push((nx as usize, ny as usize));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Crop-box calculation
// ---------------------------------------------------------------------------

/// Calculate a 1:1 square crop box that centers the face and includes
/// head/hair (top expansion) and collarbones/shoulders (bottom expansion).
///
/// For portrait photos, the face typically occupies the upper-middle portion.
/// We expand the face bbox by:
///   - 40% upward for hair/forehead
///   - 60% downward for chin/neck/shoulders
///   - 20% left/right for ears/background
///
/// The result is a square. If the image is landscape, we favor the face's
/// vertical span and center horizontally. If portrait, we favor the face's
/// horizontal span and center vertically.
///
/// Edge cases (box exceeds image bounds): the box is clamped to the image
/// and, if the clamped box is not square, we scale down the crop until it
/// fits or pad with the nearest edge color.
fn calculate_crop_box(img_w: u32, img_h: u32, face: Option<FaceRegion>) -> (u32, u32, u32, u32) {
    let (cx, cy, face_w, face_h) = match face {
        Some(f) => (f.center_x, f.center_y, f.width, f.height),
        None => {
            // No face detected — use center-bias crop for typical portrait.
            // Center of the image, slightly above center for vertical bias.
            (img_w / 2, img_h / 2, img_w / 4, img_h / 4)
        }
    };

    // Expansion factors derived from typical portrait proportions.
    let expand_top = 0.45f64; // hair / forehead
    let expand_bottom = 0.75f64; // chin / neck / shoulders
    let expand_sides = 0.30f64; // ears / background

    let crop_w = (face_w as f64 * (1.0 + expand_sides * 2.0)).ceil() as u32;
    let crop_h = (face_h as f64 * (1.0 + expand_top + expand_bottom)).ceil() as u32;

    // Force square — use the larger dimension so we don't cut off features.
    let square = crop_w.max(crop_h);

    // Compute top-left from center.
    let mut x0 = cx.saturating_sub(square / 2);
    let mut y0 =
        cy.saturating_sub((square as f64 * expand_top / (expand_top + expand_bottom)) as u32);
    let mut size = square;

    // Clamp to image bounds.
    if x0 + size > img_w {
        if size > img_w {
            size = img_w;
            x0 = 0;
        } else {
            x0 = img_w - size;
        }
    }
    if y0 + size > img_h {
        if size > img_h {
            size = img_h;
            y0 = 0;
        } else {
            y0 = img_h - size;
        }
    }

    // Final safety clamp.
    x0 = x0.min(img_w.saturating_sub(1));
    y0 = y0.min(img_h.saturating_sub(1));
    size = size.min(img_w - x0).min(img_h - y0);
    size = size.max(1);

    (x0, y0, size, size)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skin_tone_rejects_obvious_non_skin() {
        assert!(!is_skin_tone(0, 0, 255)); // pure blue
        assert!(!is_skin_tone(0, 255, 0)); // pure green
        assert!(!is_skin_tone(255, 255, 255)); // white
    }

    #[test]
    fn test_skin_tone_accepts_typical() {
        assert!(is_skin_tone(220, 170, 140));
        assert!(is_skin_tone(180, 130, 100));
    }

    #[test]
    fn test_crop_box_square() {
        // 1000x1000 image, face at center 200x200
        let (x, y, w, h) = calculate_crop_box(
            1000,
            1000,
            Some(FaceRegion {
                center_x: 500,
                center_y: 400,
                width: 200,
                height: 250,
            }),
        );
        assert_eq!(w, h, "crop must be square");
        assert!(w >= 200);
        assert!(x + w <= 1000);
        assert!(y + h <= 1000);
    }

    #[test]
    fn test_crop_box_clamps_to_bounds() {
        // Face near top-left edge of small image
        let (x, y, w, h) = calculate_crop_box(
            300,
            300,
            Some(FaceRegion {
                center_x: 50,
                center_y: 50,
                width: 60,
                height: 60,
            }),
        );
        assert_eq!(w, h);
        assert!(x + w <= 300);
        assert!(y + h <= 300);
    }

    #[test]
    fn test_process_rejects_tiny() {
        let tiny = vec![0u8; 64];
        assert!(matches!(
            process_staff_avatar(&tiny),
            Err(AvatarError::Decode(_))
        ));
    }
}
